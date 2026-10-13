"""Clean TLC records and load normalized SQLite tables with an exclusion audit."""

from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime
import glob
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from typing import Iterable, Optional

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

if __package__:
    from .db import DB_PATH, initialize_connection
else:
    from db import DB_PATH, initialize_connection

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / 'data'
ZONES_CSV = DATA_DIR / 'taxi_zone_lookup.csv'
ZONES_GEOJSON_DIR = DATA_DIR / 'taxi_zones'

TRIP_COLUMNS = [
    'vendor_id', 'pickup_datetime', 'dropoff_datetime', 'pickup_location_id',
    'dropoff_location_id', 'rate_code_id', 'payment_type_id', 'passenger_count',
    'trip_distance', 'store_and_fwd_flag',
]
FARE_COLUMNS = [
    'fare_amount', 'extra', 'mta_tax', 'tip_amount', 'tolls_amount',
    'improvement_surcharge', 'congestion_surcharge', 'airport_fee', 'total_amount',
]
METRIC_COLUMNS = [
    'trip_duration_minutes', 'fare_per_mile', 'speed_mph', 'pickup_hour',
    'pickup_weekday',
]
REQUIRED_COLUMNS = [
    'pickup_datetime', 'dropoff_datetime', 'passenger_count', 'trip_distance',
    'pickup_location_id', 'dropoff_location_id', 'fare_amount', 'total_amount',
]
EXCLUSION_COLUMNS = ['filename', 'row_index', 'reason', 'details']
DIMENSIONS = {
    'vendors': ('vendor_id', 'vendor_name', {
        1: 'Creative Mobile Technologies', 2: 'VeriFone Inc.',
    }),
    'rate_codes': ('rate_code_id', 'rate_code_name', {
        1: 'Standard rate', 2: 'JFK', 3: 'Newark', 4: 'Nassau or Westchester',
        5: 'Negotiated fare', 6: 'Group ride', 99: 'Unknown',
    }),
    'payment_types': ('payment_type_id', 'payment_type_name', {
        0: 'Unknown', 1: 'Credit card', 2: 'Cash', 3: 'No charge',
        4: 'Dispute', 5: 'Unknown', 6: 'Voided trip',
    }),
}


def get_parquet_paths() -> list[str]:
    return sorted(glob.glob(str(DATA_DIR / 'yellow_tripdata_*.parquet')))


def load_zone_lookup() -> pd.DataFrame:
    df = pd.read_csv(ZONES_CSV, keep_default_na=False, na_values=[''])
    df.columns = [c.lower() for c in df.columns]
    df = df.rename(columns={'locationid': 'location_id', 'servicezone': 'service_zone'})
    ids = pd.to_numeric(df['location_id'], errors='raise')
    if ids.isna().any() or (ids % 1 != 0).any() or ids.duplicated().any():
        raise ValueError("Zone lookup must contain unique integer location IDs.")
    if df[['borough', 'zone']].isna().any().any():
        raise ValueError("Zone lookup contains missing borough or zone names.")
    df['location_id'] = ids.astype(int)
    return df[['location_id', 'borough', 'zone', 'service_zone']]


def load_spatial_metadata():
    for name in ('taxi_zones.geojson', 'taxi_zones.json'):
        path = DATA_DIR / name
        if path.exists():
            with path.open(encoding='utf-8') as file:
                return json.load(file)
    shapefiles = list(ZONES_GEOJSON_DIR.glob('*.shp'))
    if shapefiles:
        try:
            import geopandas as gpd
        except ImportError:
            print("Spatial polygons not loaded: geopandas is not installed. "
                  "Zone lookup relationships will still be loaded.")
            return None
        return json.loads(gpd.read_file(shapefiles[0]).to_json())
    return None


def iter_trip_batches(filepath, nrows=None, batch_size=100000):
    offset = 0
    for batch in pq.ParquetFile(filepath).iter_batches(batch_size=batch_size):
        df = batch.to_pandas()
        if nrows is not None:
            df = df.head(nrows - offset)
        df.index = pd.RangeIndex(offset, offset + len(df))
        yield df
        offset += len(df)
        if nrows is not None and offset >= nrows:
            break


def load_trip_data(filepath, nrows=None):
    frames = list(iter_trip_batches(filepath, nrows=nrows))
    return pd.concat(frames) if frames else pd.DataFrame()


def standardize_columns(df):
    df = df.copy()
    df.columns = [c.lower() for c in df.columns]
    return df.rename(columns={
        'tpep_pickup_datetime': 'pickup_datetime',
        'tpep_dropoff_datetime': 'dropoff_datetime',
        'pulocationid': 'pickup_location_id',
        'dolocationid': 'dropoff_location_id',
        'ratecodeid': 'rate_code_id',
        'payment_type': 'payment_type_id',
        'vendorid': 'vendor_id',
    })


def clean_and_validate(
    df: pd.DataFrame,
    filename: str = "unknown",
    exclusion_log: Optional[list[dict[str, object]]] = None,
    valid_zone_ids: Optional[set[int]] = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    missing = set(REQUIRED_COLUMNS) - set(df.columns)
    if missing:
        raise ValueError(f"{filename}: missing required columns: {sorted(missing)}")
    df = df.copy()
    excluded = [] if exclusion_log is None else list(exclusion_log)

    def exclude(mask, reason, details):
        nonlocal df
        for idx in df.index[mask]:
            excluded.append({
                'filename': filename, 'row_index': int(idx),
                'reason': reason, 'details': details,
            })
        df = df.loc[~mask].copy()

    exclude(df[REQUIRED_COLUMNS].isna().any(axis=1), 'missing_values',
            'Null in a required field')
    for col in TRIP_COLUMNS + FARE_COLUMNS:
        if col not in df.columns:
            df[col] = None

    integers = [
        'passenger_count', 'pickup_location_id', 'dropoff_location_id',
        'vendor_id', 'rate_code_id', 'payment_type_id',
    ]
    for col in integers + ['trip_distance'] + FARE_COLUMNS:
        raw = df[col]
        numeric = pd.to_numeric(raw, errors='coerce')
        invalid = raw.notna() & (numeric.isna() | ~np.isfinite(numeric))
        exclude(invalid, 'invalid_numeric', f'{col} must be finite numeric data')
        df[col] = numeric.loc[df.index]
    for col in integers:
        invalid = df[col].notna() & ((df[col] % 1 != 0) | (df[col] < 0))
        exclude(invalid, 'invalid_identifier', f'{col} must be a nonnegative integer')
    for col, lo, hi in [('fare_amount', 0, 500), ('trip_distance', 0, 100)]:
        exclude(~((df[col] > lo) & (df[col] <= hi)),
                f'outlier_{col}', f'{col} must be in ({lo}, {hi}]')
    exclude(~df['passenger_count'].between(1, 6), 'outlier_passenger_count',
            'passenger_count must be an integer in [1, 6]')
    for col in FARE_COLUMNS:
        exclude(df[col].notna() & (df[col] < 0), 'negative_amount',
                f'{col} cannot be negative')
    exclude(df['total_amount'] < df['fare_amount'], 'invalid_total_amount',
            'total_amount cannot be less than fare_amount')
    if valid_zone_ids is not None:
        for col in ['pickup_location_id', 'dropoff_location_id']:
            exclude(~df[col].isin(valid_zone_ids), 'unknown_zone',
                    f'{col} is not in the zone lookup')
    flag = df['store_and_fwd_flag'].astype('string').str.strip().str.upper()
    exclude(flag.notna() & ~flag.isin(['Y', 'N']), 'invalid_category',
            'store_and_fwd_flag must be Y, N, or missing')
    df['store_and_fwd_flag'] = flag.loc[df.index]

    # TLC timestamps are New York local wall times, not UTC timestamps.
    for col in ['pickup_datetime', 'dropoff_datetime']:
        df[col] = pd.to_datetime(df[col], errors='coerce', format='mixed')
        if isinstance(df[col].dtype, pd.DatetimeTZDtype):
            raise ValueError(f'{filename}: expected timezone-naive TLC local times')
    exclude(df[['pickup_datetime', 'dropoff_datetime']].isna().any(axis=1),
            'invalid_datetime', 'Timestamp could not be parsed')
    duration = (df['dropoff_datetime'] - df['pickup_datetime']).dt.total_seconds() / 60
    exclude((duration <= 0) | (duration > 360), 'outlier_duration',
            'Duration must be in (0, 360] minutes')
    speed = df['trip_distance'] / (duration.loc[df.index] / 60)
    exclude(speed > 120, 'outlier_speed', 'Average speed exceeds 120 mph')
    exclude(df.duplicated(subset=TRIP_COLUMNS + FARE_COLUMNS), 'duplicate',
            'Duplicate normalized trip and fare values')
    return df, pd.DataFrame(excluded, columns=EXCLUSION_COLUMNS)


def engineer_features(df):
    df = df.copy()
    duration = (df['dropoff_datetime'] - df['pickup_datetime']).dt.total_seconds() / 60
    df['trip_duration_minutes'] = duration
    df['fare_per_mile'] = df['fare_amount'] / df['trip_distance']
    df['speed_mph'] = df['trip_distance'] / (duration / 60)
    df['pickup_hour'] = df['pickup_datetime'].dt.hour
    df['pickup_weekday'] = df['pickup_datetime'].dt.weekday
    return df


def normalize_for_db(df):
    df = df.copy()
    for col in ['pickup_datetime', 'dropoff_datetime']:
        df[col] = df[col].dt.strftime('%Y-%m-%d %H:%M:%S.%f')
    for col in ['passenger_count', 'pickup_location_id', 'dropoff_location_id',
                'vendor_id', 'rate_code_id', 'payment_type_id',
                'pickup_hour', 'pickup_weekday']:
        df[col] = df[col].astype('Int64')
    return df


def get_trip_columns():
    return list(TRIP_COLUMNS)


def sql_rows(df, columns):
    return df[columns].astype(object).where(df[columns].notna(), None).itertuples(
        index=False, name=None
    )


def load_zones(conn, zones):
    conn.executemany(
        'INSERT INTO zones (location_id, borough, zone, service_zone) VALUES (?, ?, ?, ?)',
        sql_rows(zones, ['location_id', 'borough', 'zone', 'service_zone']),
    )


def insert_cleaned_trips(conn, df, filename):
    """Insert related rows with matching IDs; detect duplicates across all files."""
    for table, (id_col, name_col, labels) in DIMENSIONS.items():
        ids = [int(value) for value in df[id_col].dropna().unique()]
        conn.executemany(
            f'INSERT OR IGNORE INTO {table} ({id_col}, {name_col}) VALUES (?, ?)',
            [(value, labels.get(value, f'Unmapped TLC code {value}')) for value in ids],
        )
    conn.execute('CREATE TEMP TABLE IF NOT EXISTS seen_trips (signature BLOB PRIMARY KEY)')
    columns = TRIP_COLUMNS + FARE_COLUMNS + METRIC_COLUMNS
    accepted = []
    exclusions = []
    for idx, row in zip(df.index, sql_rows(df, columns)):
        signature = hashlib.sha256(
            json.dumps(row[:len(TRIP_COLUMNS) + len(FARE_COLUMNS)],
                       separators=(',', ':'), allow_nan=False).encode()
        ).digest()
        cursor = conn.execute('INSERT OR IGNORE INTO seen_trips VALUES (?)', (signature,))
        if cursor.rowcount == 0:
            exclusions.append((filename, int(idx), 'duplicate',
                               'Duplicate normalized record across batches/files'))
        else:
            accepted.append(row)
    next_id = conn.execute('SELECT COALESCE(MAX(trip_id), 0) + 1 FROM trips').fetchone()[0]
    for table, fields, offset in [
        ('trips', TRIP_COLUMNS, 0),
        ('trip_fares', FARE_COLUMNS, len(TRIP_COLUMNS)),
        ('trip_metrics', METRIC_COLUMNS, len(TRIP_COLUMNS) + len(FARE_COLUMNS)),
    ]:
        names = ', '.join(['trip_id'] + fields)
        placeholders = ', '.join('?' for _ in range(len(fields) + 1))
        conn.executemany(
            f'INSERT INTO {table} ({names}) VALUES ({placeholders})',
            ((next_id + i,) + row[offset:offset + len(fields)]
             for i, row in enumerate(accepted)),
        )
    conn.executemany(
        'INSERT INTO exclusion_log (filename, row_index, reason, details) VALUES (?, ?, ?, ?)',
        exclusions,
    )
    return len(accepted)


def backup_database(path):
    backup_path = path.with_name(
        f'{path.name}.{datetime.now().strftime("%Y%m%dT%H%M%S%f")}.bak'
    )
    with closing(sqlite3.connect(path)) as source:
        with closing(sqlite3.connect(backup_path)) as destination:
            source.backup(destination)
    print(f'Previous database backed up to {backup_path}')


def run_pipeline(
    parquet_paths: Optional[Iterable[os.PathLike[str] | str]] = None,
    nrows: Optional[int] = None,
    db_path: Optional[os.PathLike[str] | str] = None,
    batch_size: int = 100000,
) -> dict[str, int]:
    """Build a database atomically; on failure keep the previous database intact."""
    if nrows is not None and nrows <= 0:
        raise ValueError('nrows must be positive')
    if batch_size <= 0:
        raise ValueError('batch_size must be positive')
    paths = get_parquet_paths() if parquet_paths is None else list(parquet_paths)
    if not paths:
        raise FileNotFoundError('No TLC Parquet files found. Run backend/download_tlc_data.py first.')
    for path in paths:
        if not Path(path).is_file():
            raise FileNotFoundError(path)
    zones = load_zone_lookup()
    spatial = load_spatial_metadata()
    if spatial:
        print(f"Loaded spatial metadata: {len(spatial.get('features', []))} zones")
    target = Path(DB_PATH if db_path is None else db_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='mobility-build-', suffix='.db', dir=target.parent)
    os.close(fd)
    staging = Path(name)
    total = 0
    try:
        with closing(sqlite3.connect(staging)) as conn:
            initialize_connection(conn)
            with conn:
                load_zones(conn, zones)
                zone_ids = set(zones['location_id'])
                for path in paths:
                    filename = Path(path).name
                    print(f'Loading {filename}' + (f' (up to {nrows} rows)' if nrows else ''))
                    for raw in iter_trip_batches(path, nrows, batch_size):
                        df, exclusions = clean_and_validate(
                            standardize_columns(raw), filename, valid_zone_ids=zone_ids
                        )
                        df = normalize_for_db(engineer_features(df))
                        total += insert_cleaned_trips(conn, df, filename)
                        conn.executemany(
                            'INSERT INTO exclusion_log (filename, row_index, reason, details) '
                            'VALUES (?, ?, ?, ?)',
                            sql_rows(exclusions, EXCLUSION_COLUMNS),
                        )
                if conn.execute('PRAGMA foreign_key_check').fetchall():
                    raise RuntimeError('Normalized database has foreign key violations')
            excluded = conn.execute('SELECT COUNT(*) FROM exclusion_log').fetchone()[0]
            counts = [conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                      for table in ['trips', 'trip_fares', 'trip_metrics', 'trip_details']]
            if counts != [total] * 4:
                raise RuntimeError(f'Incomplete normalized trip relationships: {counts}')
        if target.exists():
            backup_database(target)
        os.replace(staging, target)
    finally:
        staging.unlink(missing_ok=True)
    print(f'Pipeline complete: {total} trips, {excluded} excluded, {len(zones)} zones.')
    return {'zones': len(zones), 'trips': total, 'excluded': excluded}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nrows', type=int, help='Limit raw rows per file (sample run)')
    parser.add_argument('--batch-size', type=int, default=100000)
    parser.add_argument('--db-path', default=DB_PATH)
    args = parser.parse_args()
    run_pipeline(nrows=args.nrows, db_path=args.db_path, batch_size=args.batch_size)


if __name__ == '__main__':
    main()
