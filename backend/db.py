import sqlite3
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'database', 'mobility.db')
SCHEMA_PATH = os.path.join(BASE_DIR, 'database', 'schema_sqlite_normalized.sql')

SCHEMA = {
    "zones": {
        "columns": ["location_id", "borough", "zone", "service_zone"],
        "primary_key": "location_id",
        "description": "NYC taxi zone lookup with borough and service zone mappings"
    },
    "trips": {
        "columns": [
            "trip_id", "vendor_id", "rate_code_id", "payment_type_id",
            "store_and_fwd_flag", "pickup_datetime", "dropoff_datetime", "passenger_count",
            "trip_distance", "pickup_location_id", "dropoff_location_id",
        ],
        "primary_key": "trip_id",
        "foreign_keys": {
            "pickup_location_id": "zones(location_id)",
            "dropoff_location_id": "zones(location_id)",
            "vendor_id": "vendors(vendor_id)",
            "rate_code_id": "rate_codes(rate_code_id)",
            "payment_type_id": "payment_types(payment_type_id)"
        },
        "description": "Core trip records referencing categorical dimensions"
    },
    "vendors": {
        "columns": ["vendor_id", "vendor_name"], "primary_key": "vendor_id"
    },
    "rate_codes": {
        "columns": ["rate_code_id", "rate_code_name"], "primary_key": "rate_code_id"
    },
    "payment_types": {
        "columns": ["payment_type_id", "payment_type_name"], "primary_key": "payment_type_id"
    },
    "trip_fares": {
        "columns": ["trip_id", "fare_amount", "extra", "mta_tax", "tip_amount",
                    "tolls_amount", "improvement_surcharge", "congestion_surcharge",
                    "airport_fee", "total_amount"],
        "primary_key": "trip_id",
        "foreign_keys": {"trip_id": "trips(trip_id)"}
    },
    "trip_metrics": {
        "columns": ["trip_id", "trip_duration_minutes", "fare_per_mile",
                    "speed_mph", "pickup_hour", "pickup_weekday"],
        "primary_key": "trip_id",
        "foreign_keys": {"trip_id": "trips(trip_id)"}
    },
    "exclusion_log": {
        "columns": ["id", "filename", "row_index", "reason", "details", "created_at"],
        "primary_key": "id",
        "description": "Log of excluded or suspicious records during data cleaning"
    }
}


def get_db_connection():
    """Return a SQLite connection with Row factory."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def initialize_connection(conn):
    """Create normalized tables without replacing an existing flat database."""
    columns = {row[1] for row in conn.execute("PRAGMA table_info(trips)")}
    if columns and 'trip_id' not in columns:
        raise RuntimeError(
            "Legacy flat database detected. Run python backend/data_pipeline.py "
            "to rebuild from raw data; the existing database will be backed up."
        )
    with open(SCHEMA_PATH, encoding='utf-8') as f:
        conn.executescript(f.read())


def init_db():
    """Initialize the normalized SQLite database without deleting data."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        initialize_connection(conn)
        conn.commit()
    finally:
        conn.close()


def get_table_counts():
    """Return row counts for each known table."""
    conn = get_db_connection()
    counts = {}
    for table in SCHEMA.keys():
        try:
            row = conn.execute(f"SELECT COUNT(*) as count FROM {table}").fetchone()
            counts[table] = row['count']
        except sqlite3.OperationalError:
            counts[table] = None
    conn.close()
    return counts


def table_exists(table_name):
    """Check if a table exists in the database."""
    conn = get_db_connection()
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,)
    ).fetchone()
    conn.close()
    return row is not None


def is_db_ready():
    """Check that the normalized tables and API view exist."""
    if not os.path.exists(DB_PATH):
        return False
    conn = get_db_connection()
    columns = {row[1] for row in conn.execute("PRAGMA table_info(trips)")}
    if 'trip_id' not in columns:
        conn.close()
        return False
    for table in SCHEMA.keys():
        cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table,)
        )
        if cur.fetchone() is None:
            conn.close()
            return False
    ready = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='view' AND name='trip_details'"
    ).fetchone() is not None
    conn.close()
    return ready
