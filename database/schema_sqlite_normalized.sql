PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS zones (
    location_id INTEGER PRIMARY KEY,
    borough TEXT NOT NULL,
    zone TEXT NOT NULL,
    service_zone TEXT
);

CREATE TABLE IF NOT EXISTS vendors (
    vendor_id INTEGER PRIMARY KEY,
    vendor_name TEXT NOT NULL
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
    trip_id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER,
    pickup_datetime TEXT NOT NULL,
    dropoff_datetime TEXT NOT NULL,
    pickup_location_id INTEGER NOT NULL,
    dropoff_location_id INTEGER NOT NULL,
    rate_code_id INTEGER,
    payment_type_id INTEGER,
    passenger_count INTEGER NOT NULL CHECK (
        typeof(passenger_count) = 'integer' AND passenger_count BETWEEN 1 AND 6
    ),
    trip_distance REAL NOT NULL CHECK (trip_distance > 0 AND trip_distance <= 100),
    store_and_fwd_flag TEXT CHECK (store_and_fwd_flag IN ('Y', 'N')),
    CHECK (dropoff_datetime > pickup_datetime),
    FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id),
    FOREIGN KEY (pickup_location_id) REFERENCES zones(location_id),
    FOREIGN KEY (dropoff_location_id) REFERENCES zones(location_id),
    FOREIGN KEY (rate_code_id) REFERENCES rate_codes(rate_code_id),
    FOREIGN KEY (payment_type_id) REFERENCES payment_types(payment_type_id)
);

CREATE TABLE IF NOT EXISTS trip_fares (
    trip_id INTEGER PRIMARY KEY,
    fare_amount REAL NOT NULL CHECK (fare_amount > 0 AND fare_amount <= 500),
    extra REAL CHECK (extra >= 0),
    mta_tax REAL CHECK (mta_tax >= 0),
    tip_amount REAL CHECK (tip_amount >= 0),
    tolls_amount REAL CHECK (tolls_amount >= 0),
    improvement_surcharge REAL CHECK (improvement_surcharge >= 0),
    congestion_surcharge REAL CHECK (congestion_surcharge >= 0),
    airport_fee REAL CHECK (airport_fee >= 0),
    total_amount REAL NOT NULL CHECK (total_amount >= fare_amount),
    FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trip_metrics (
    trip_id INTEGER PRIMARY KEY,
    trip_duration_minutes REAL NOT NULL CHECK (trip_duration_minutes > 0 AND trip_duration_minutes <= 360),
    fare_per_mile REAL NOT NULL CHECK (fare_per_mile >= 0),
    speed_mph REAL NOT NULL CHECK (speed_mph >= 0 AND speed_mph <= 120),
    pickup_hour INTEGER NOT NULL CHECK (pickup_hour BETWEEN 0 AND 23),
    pickup_weekday INTEGER NOT NULL CHECK (pickup_weekday BETWEEN 0 AND 6),
    FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exclusion_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    row_index INTEGER,
    reason TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trips_pickup_datetime ON trips (pickup_datetime);
CREATE INDEX IF NOT EXISTS idx_trips_dropoff_datetime ON trips (dropoff_datetime);
CREATE INDEX IF NOT EXISTS idx_trips_pickup_location ON trips (pickup_location_id);
CREATE INDEX IF NOT EXISTS idx_trips_dropoff_location ON trips (dropoff_location_id);
CREATE INDEX IF NOT EXISTS idx_trip_fares_total_amount ON trip_fares (total_amount);
CREATE INDEX IF NOT EXISTS idx_trip_fares_fare_amount ON trip_fares (fare_amount);
CREATE INDEX IF NOT EXISTS idx_trip_metrics_pickup_hour ON trip_metrics (pickup_hour);

CREATE VIEW IF NOT EXISTS trip_details AS
SELECT t.trip_id AS id,
       t.pickup_datetime, t.dropoff_datetime, t.passenger_count,
       t.trip_distance, t.pickup_location_id, t.dropoff_location_id,
       f.fare_amount, f.tip_amount, f.total_amount,
       m.trip_duration_minutes, m.fare_per_mile, m.speed_mph
FROM trips t
JOIN trip_fares f ON f.trip_id = t.trip_id
JOIN trip_metrics m ON m.trip_id = t.trip_id;
