#!/usr/bin/env python3
"""Clean NYC TLC Yellow Taxi records and load them into SQLite."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import sqlite3
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = PROJECT_ROOT / "database" / "schema.sql"
NEW_YORK = ZoneInfo("America/New_York")

RATE_CODES = {
    1: "Standard rate",
    2: "JFK",
    3: "Newark",
    4: "Nassau or Westchester",
    5: "Negotiated fare",
    6: "Group ride",
}
PAYMENT_TYPES = {
    1: "Credit card",
    2: "Cash",
    3: "No charge",
    4: "Dispute",
    5: "Unknown",
    6: "Voided trip",
}
AMOUNT_COLUMNS = (
    "extra",
    "mta_tax",
    "tip_amount",
    "tolls_amount",
    "improvement_surcharge",
    "congestion_surcharge",
    "airport_fee",
    "cbd_congestion_fee",
)
AUDIT_COLUMNS = (
    "tpep_pickup_datetime",
    "tpep_dropoff_datetime",
    "passenger_count",
    "trip_distance",
    "RatecodeID",
    "PULocationID",
    "DOLocationID",
    "payment_type",
    "fare_amount",
    "total_amount",
)
REQUIRED_TRIP_COLUMNS = {
    "tpep_pickup_datetime",
    "tpep_dropoff_datetime",
    "passenger_count",
    "trip_distance",
    "PULocationID",
    "DOLocationID",
    "fare_amount",
}


class RejectedRecord(ValueError):
    """A record that fails a documented data-quality rule."""


def _number(value: Any, name: str, *, required: bool = False) -> float | None:
    if value is None or value == "":
        if required:
            raise RejectedRecord(f"missing_{name}")
        return None
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise RejectedRecord(f"invalid_{name}") from exc
    if not math.isfinite(result):
        raise RejectedRecord(f"invalid_{name}")
    return result


def _integer(value: Any, name: str, *, required: bool = False) -> int | None:
    number = _number(value, name, required=required)
    if number is None:
        return None
    if not number.is_integer():
        raise RejectedRecord(f"invalid_{name}")
    return int(number)


def _timestamp(value: Any, name: str) -> datetime:
    if value is None or value == "":
        raise RejectedRecord(f"missing_{name}")
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError as exc:
            raise RejectedRecord(f"invalid_{name}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=NEW_YORK)
    return parsed.astimezone(timezone.utc)


def _zone_id(value: Any, name: str, valid_zone_ids: set[int]) -> int:
    zone_id = _integer(value, name, required=True)
    if zone_id not in valid_zone_ids:
        raise RejectedRecord(f"unknown_{name}")
    return zone_id


def clean_record(record: dict[str, Any], valid_zone_ids: set[int]) -> tuple[dict[str, Any], list[str]]:
    """Validate a raw TLC row and return its normalized values and audit flags."""
    pickup = _timestamp(record.get("tpep_pickup_datetime"), "pickup_datetime")
    dropoff = _timestamp(record.get("tpep_dropoff_datetime"), "dropoff_datetime")
    duration = int((dropoff - pickup).total_seconds())
    if duration <= 0:
        raise RejectedRecord("nonpositive_duration")
    if duration > 4 * 60 * 60:
        raise RejectedRecord("duration_over_4_hours")

    passengers = _integer(record.get("passenger_count"), "passenger_count", required=True)
    if not 1 <= passengers <= 8:
        raise RejectedRecord("passenger_count_out_of_range")

    distance = _number(record.get("trip_distance"), "trip_distance", required=True)
    if not 0 < distance <= 200:
        raise RejectedRecord("trip_distance_out_of_range")
    speed = distance * 3600 / duration
    if speed > 100:
        raise RejectedRecord("average_speed_over_100_mph")

    fare = _number(record.get("fare_amount"), "fare_amount", required=True)
    if not 0 < fare <= 1000:
        raise RejectedRecord("fare_amount_out_of_range")

    flags: list[str] = []
    amounts: dict[str, float] = {}
    for name in AMOUNT_COLUMNS:
        amount = _number(record.get(name), name)
        if amount is None:
            amount = 0.0
            if name in record:
                flags.append(f"missing_{name}_set_to_zero")
        if name in {"tip_amount", "tolls_amount"} and amount < 0:
            raise RejectedRecord(f"negative_{name}")
        if abs(amount) > 1000:
            raise RejectedRecord(f"{name}_out_of_range")
        amounts[name] = amount

    total = _number(record.get("total_amount"), "total_amount")
    if total is None:
        total = fare + sum(amounts.values())
        flags.append("missing_total_amount_calculated")
    if not 0 < total <= 1500:
        raise RejectedRecord("total_amount_out_of_range")

    try:
        rate_code = _integer(record.get("RatecodeID"), "rate_code_id")
    except RejectedRecord:
        rate_code = None
        flags.append("invalid_rate_code_set_to_null")
    if rate_code not in RATE_CODES:
        if rate_code is not None:
            flags.append("invalid_rate_code_set_to_null")
        rate_code = None
    try:
        payment_type = _integer(record.get("payment_type"), "payment_type_id")
    except RejectedRecord:
        payment_type = None
        flags.append("invalid_payment_type_set_to_null")
    if payment_type not in PAYMENT_TYPES:
        if payment_type is not None:
            flags.append("invalid_payment_type_set_to_null")
        payment_type = None

    flag = record.get("store_and_fwd_flag")
    if flag not in ("Y", "N", None, ""):
        flag = None
        flags.append("invalid_store_and_fwd_flag_set_to_null")

    normalized: dict[str, Any] = {
        "pickup_datetime": pickup.isoformat(timespec="seconds"),
        "dropoff_datetime": dropoff.isoformat(timespec="seconds"),
        "passenger_count": passengers,
        "trip_distance": distance,
        "rate_code_id": rate_code,
        "store_and_fwd_flag": flag or None,
        "pickup_location_id": _zone_id(record.get("PULocationID"), "pickup_location_id", valid_zone_ids),
        "dropoff_location_id": _zone_id(record.get("DOLocationID"), "dropoff_location_id", valid_zone_ids),
        "payment_type_id": payment_type,
        "fare_amount": fare,
        **amounts,
        "total_amount": total,
        "duration_seconds": duration,
        "average_speed_mph": speed,
        "fare_per_mile": fare / distance,
    }
    fingerprint_source = json.dumps(record, sort_keys=True, default=str, separators=(",", ":"))
    normalized["trip_hash"] = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()
    return normalized, flags


def _location_id(properties: dict[str, Any]) -> int:
    for key in ("LocationID", "location_id", "OBJECTID", "objectid"):
        value = properties.get(key)
        if value is not None:
            return int(value)
    raise ValueError("GeoJSON feature is missing a zone identifier")


def _read_zone_geometries(path: Path) -> dict[int, dict[str, Any] | None]:
    if path.suffix.lower() in {".json", ".geojson"}:
        geojson = json.loads(path.read_text(encoding="utf-8"))
        geometries = {
            _location_id(feature.get("properties") or {}): feature.get("geometry")
            for feature in geojson.get("features", [])
        }
        if not geometries:
            raise ValueError("Taxi zone GeoJSON does not contain any features")
        return geometries

    if path.suffix.lower() != ".zip":
        raise ValueError("Taxi zone boundaries must be GeoJSON or a zipped shapefile")
    try:
        import shapefile
        from pyproj import CRS, Transformer
    except ImportError as exc:
        raise RuntimeError(
            "Install backend dependencies with: pip install -r backend/requirements.txt"
        ) from exc

    with zipfile.ZipFile(path) as archive:
        members = {Path(name).name.lower(): name for name in archive.namelist()}
        shp_name = next((name for name in members.values() if name.lower().endswith(".shp")), None)
        if not shp_name:
            raise ValueError("Taxi zone ZIP does not contain a .shp file")
        stem = Path(shp_name).stem.lower()
        prj_name = members.get(f"{stem}.prj")
        if not prj_name:
            raise ValueError("Taxi zone shapefile is missing its .prj coordinate reference")
        dbf_name = members.get(f"{stem}.dbf")
        if not dbf_name:
            raise ValueError("Taxi zone shapefile is missing its .dbf attributes")
        source_crs = CRS.from_wkt(archive.read(prj_name).decode("utf-8"))
        transformer = Transformer.from_crs(source_crs, CRS.from_epsg(4326), always_xy=True)
        shapefile_reader = shapefile.Reader(
            shp=io.BytesIO(archive.read(shp_name)),
            shx=io.BytesIO(archive.read(members[f"{stem}.shx"]))
            if f"{stem}.shx" in members
            else None,
            dbf=io.BytesIO(archive.read(dbf_name)),
        )
        field_names = [field[0] for field in shapefile_reader.fields[1:]]
        geometries: dict[int, dict[str, Any] | None] = {}
        for shape_record in shapefile_reader.iterShapeRecords():
            properties = dict(zip(field_names, shape_record.record))
            location_id = _location_id(properties)
            geometry = shape_record.shape.__geo_interface__

            def reproject(coordinate: list[Any]) -> list[Any]:
                if not coordinate:
                    return coordinate
                if isinstance(coordinate[0], (int, float)):
                    longitude, latitude = transformer.transform(coordinate[0], coordinate[1])
                    return [longitude, latitude, *coordinate[2:]]
                return [reproject(child) for child in coordinate]

            geometries[location_id] = {
                "type": geometry["type"],
                "coordinates": reproject(geometry["coordinates"]),
            }
        if not geometries:
            raise ValueError("Taxi zone shapefile does not contain any features")
        return geometries


def load_zones(
    connection: sqlite3.Connection,
    lookup_path: Path,
    boundaries_path: Path,
) -> set[int]:
    with lookup_path.open(newline="", encoding="utf-8-sig") as source:
        rows = list(csv.DictReader(source))
    if not rows:
        raise ValueError("taxi_zone_lookup.csv does not contain any rows")
    geometries = _read_zone_geometries(boundaries_path)

    borough_ids: dict[str, int] = {}
    service_zone_ids: dict[str, int] = {}
    for row in rows:
        borough = (row.get("Borough") or "").strip()
        zone_name = (row.get("Zone") or "").strip()
        if not borough or not zone_name:
            raise ValueError("taxi_zone_lookup.csv contains a row missing Borough or Zone")
        if borough not in borough_ids:
            connection.execute(
                "INSERT OR IGNORE INTO boroughs (borough_name) VALUES (?)", (borough,)
            )
            borough_ids[borough] = connection.execute(
                "SELECT borough_id FROM boroughs WHERE borough_name = ?", (borough,)
            ).fetchone()[0]

        service_zone = (row.get("service_zone") or "").strip()
        service_zone_id = None
        if service_zone:
            if service_zone not in service_zone_ids:
                connection.execute(
                    "INSERT OR IGNORE INTO service_zones (service_zone_name) VALUES (?)",
                    (service_zone,),
                )
                service_zone_ids[service_zone] = connection.execute(
                    "SELECT service_zone_id FROM service_zones WHERE service_zone_name = ?",
                    (service_zone,),
                ).fetchone()[0]
            service_zone_id = service_zone_ids[service_zone]

        location_id = int(row["LocationID"])
        geometry = geometries.get(location_id)
        connection.execute(
            """
            INSERT INTO taxi_zones (location_id, borough_id, zone_name, service_zone_id, geometry_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(location_id) DO UPDATE SET
                borough_id = excluded.borough_id,
                zone_name = excluded.zone_name,
                service_zone_id = excluded.service_zone_id,
                geometry_json = excluded.geometry_json
            """,
            (
                location_id,
                borough_ids[borough],
                zone_name,
                service_zone_id,
                json.dumps(geometry, separators=(",", ":")) if geometry else None,
            ),
        )
    return {int(row[0]) for row in connection.execute("SELECT location_id FROM taxi_zones")}


def _seed_dimensions(connection: sqlite3.Connection) -> None:
    connection.executemany(
        "INSERT OR IGNORE INTO rate_codes (rate_code_id, rate_code_name) VALUES (?, ?)",
        RATE_CODES.items(),
    )
    connection.executemany(
        "INSERT OR IGNORE INTO payment_types (payment_type_id, payment_type_name) VALUES (?, ?)",
        PAYMENT_TYPES.items(),
    )


def _audit_summary(record: dict[str, Any]) -> str:
    summary = {name: record[name] for name in AUDIT_COLUMNS if name in record}
    return json.dumps(summary, default=str, sort_keys=True, separators=(",", ":"))


def load_trips(
    connection: sqlite3.Connection,
    parquet_path: Path,
    valid_zone_ids: set[int],
    batch_size: int = 5000,
    max_trips: int | None = None,
) -> tuple[int, int]:
    try:
        import pyarrow.parquet as parquet
    except ImportError as exc:
        raise RuntimeError("Install backend dependencies with: pip install -r backend/requirements.txt") from exc

    parquet_file = parquet.ParquetFile(parquet_path)
    missing_columns = REQUIRED_TRIP_COLUMNS.difference(parquet_file.schema.names)
    if missing_columns:
        raise ValueError(
            f"Parquet file is missing required columns: {', '.join(sorted(missing_columns))}"
        )
    accepted = rejected = source_row_number = 0
    flag_counts: dict[str, int] = {}
    source_file = parquet_path.name
    reached_limit = False
    for batch in parquet_file.iter_batches(batch_size=batch_size):
        if reached_limit:
            break
        for record in batch.to_pylist():
            if max_trips is not None and accepted >= max_trips:
                reached_limit = True
                break
            source_row_number += 1
            try:
                trip, flags = clean_record(record, valid_zone_ids)
            except RejectedRecord as exc:
                connection.execute(
                    """
                    INSERT INTO data_quality_issues
                        (source_file, source_row, status, reason, record_json)
                    VALUES (?, ?, 'excluded', ?, ?)
                    """,
                    (
                        source_file,
                        source_row_number,
                        str(exc),
                        _audit_summary(record),
                    ),
                )
                rejected += 1
                continue

            cursor = connection.execute(
                """
                INSERT INTO trips (
                    trip_hash, pickup_datetime, dropoff_datetime, passenger_count,
                    trip_distance, rate_code_id, store_and_fwd_flag,
                    pickup_location_id, dropoff_location_id, payment_type_id,
                    fare_amount, extra, mta_tax, tip_amount, tolls_amount,
                    improvement_surcharge, total_amount, congestion_surcharge,
                    airport_fee, cbd_congestion_fee, duration_seconds,
                    average_speed_mph, fare_per_mile
                ) VALUES (
                    :trip_hash, :pickup_datetime, :dropoff_datetime, :passenger_count,
                    :trip_distance, :rate_code_id, :store_and_fwd_flag,
                    :pickup_location_id, :dropoff_location_id, :payment_type_id,
                    :fare_amount, :extra, :mta_tax, :tip_amount, :tolls_amount,
                    :improvement_surcharge, :total_amount, :congestion_surcharge,
                    :airport_fee, :cbd_congestion_fee, :duration_seconds,
                    :average_speed_mph, :fare_per_mile
                )
                ON CONFLICT(trip_hash) DO NOTHING
                """,
                trip,
            )
            if cursor.rowcount == 0:
                connection.execute(
                    """
                    INSERT INTO data_quality_issues
                        (source_file, source_row, status, reason, record_json)
                    VALUES (?, ?, 'excluded', 'duplicate_trip', ?)
                    """,
                    (
                        source_file,
                        source_row_number,
                        _audit_summary(record),
                    ),
                )
                rejected += 1
            else:
                accepted += 1
                for flag_reason in flags:
                    flag_counts[flag_reason] = flag_counts.get(flag_reason, 0) + 1
    for reason, record_count in flag_counts.items():
        connection.execute(
            """
            INSERT INTO data_quality_issues
                (source_file, source_row, status, reason, record_json)
            VALUES (?, 0, 'flagged', ?, ?)
            """,
            (
                source_file,
                f"{reason} (records={record_count})",
                json.dumps({"record_count": record_count}),
            ),
        )
    return accepted, rejected


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trips", required=True, type=Path, help="NYC TLC Yellow Taxi Parquet file")
    parser.add_argument("--zone-lookup", required=True, type=Path, help="taxi_zone_lookup.csv")
    parser.add_argument(
        "--zones",
        required=True,
        type=Path,
        help="taxi_zones.geojson or taxi_zones.zip shapefile",
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=PROJECT_ROOT / "data" / "urban_mobility.sqlite",
        help="SQLite database output path",
    )
    parser.add_argument(
        "--max-trips",
        type=int,
        default=None,
        help="Stop after accepting this many trips (useful for lightweight demos)",
    )
    args = parser.parse_args()
    for input_path in (args.trips, args.zone_lookup, args.zones):
        if not input_path.is_file():
            parser.error(f"input file does not exist: {input_path}")
    if args.max_trips is not None and args.max_trips < 1:
        parser.error("--max-trips must be at least 1")

    args.database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(args.database) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        _seed_dimensions(connection)
        valid_zone_ids = load_zones(connection, args.zone_lookup, args.zones)
        accepted, rejected = load_trips(
            connection,
            args.trips,
            valid_zone_ids,
            max_trips=args.max_trips,
        )
        connection.commit()
    print(f"Loaded {accepted:,} trips; excluded {rejected:,} records. Database: {args.database}")


if __name__ == "__main__":
    main()
