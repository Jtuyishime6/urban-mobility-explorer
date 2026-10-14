PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS boroughs (
    borough_id INTEGER PRIMARY KEY,
    borough_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS service_zones (
    service_zone_id INTEGER PRIMARY KEY,
    service_zone_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS taxi_zones (
    location_id INTEGER PRIMARY KEY,
    borough_id INTEGER NOT NULL REFERENCES boroughs (borough_id),
    zone_name TEXT NOT NULL,
    service_zone_id INTEGER REFERENCES service_zones (service_zone_id),
    geometry_json TEXT
);

CREATE TABLE IF NOT EXISTS rate_codes (
    rate_code_id INTEGER PRIMARY KEY,
    rate_code_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_types (
    payment_type_id INTEGER PRIMARY KEY,
    payment_type_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
    trip_id INTEGER PRIMARY KEY,
    trip_hash TEXT NOT NULL UNIQUE,
    pickup_datetime TEXT NOT NULL,
    dropoff_datetime TEXT NOT NULL,
    passenger_count INTEGER NOT NULL CHECK (passenger_count BETWEEN 1 AND 8),
    trip_distance REAL NOT NULL CHECK (trip_distance > 0 AND trip_distance <= 200),
    rate_code_id INTEGER REFERENCES rate_codes (rate_code_id),
    store_and_fwd_flag TEXT CHECK (store_and_fwd_flag IN ('Y', 'N') OR store_and_fwd_flag IS NULL),
    pickup_location_id INTEGER NOT NULL REFERENCES taxi_zones (location_id),
    dropoff_location_id INTEGER NOT NULL REFERENCES taxi_zones (location_id),
    payment_type_id INTEGER REFERENCES payment_types (payment_type_id),
    fare_amount REAL NOT NULL CHECK (fare_amount > 0 AND fare_amount <= 1000),
    extra REAL NOT NULL DEFAULT 0,
    mta_tax REAL NOT NULL DEFAULT 0,
    tip_amount REAL NOT NULL DEFAULT 0 CHECK (tip_amount >= 0),
    tolls_amount REAL NOT NULL DEFAULT 0 CHECK (tolls_amount >= 0),
    improvement_surcharge REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL CHECK (total_amount > 0 AND total_amount <= 1500),
    congestion_surcharge REAL NOT NULL DEFAULT 0,
    airport_fee REAL NOT NULL DEFAULT 0,
    cbd_congestion_fee REAL NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 14400),
    average_speed_mph REAL NOT NULL CHECK (average_speed_mph > 0 AND average_speed_mph <= 100),
    fare_per_mile REAL NOT NULL CHECK (fare_per_mile > 0)
);

CREATE TABLE IF NOT EXISTS data_quality_issues (
    issue_id INTEGER PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_row INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('excluded', 'flagged')),
    reason TEXT NOT NULL,
    record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trips_pickup_datetime
    ON trips (pickup_datetime);
CREATE INDEX IF NOT EXISTS idx_trips_pickup_location_datetime
    ON trips (pickup_location_id, pickup_datetime);
CREATE INDEX IF NOT EXISTS idx_trips_dropoff_location_datetime
    ON trips (dropoff_location_id, pickup_datetime);
CREATE INDEX IF NOT EXISTS idx_trips_payment_type
    ON trips (payment_type_id);
CREATE INDEX IF NOT EXISTS idx_quality_source_row
    ON data_quality_issues (source_file, source_row);
