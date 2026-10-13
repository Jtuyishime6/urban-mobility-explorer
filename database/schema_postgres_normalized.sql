DROP TABLE IF EXISTS exclusion_log CASCADE;
DROP TABLE IF EXISTS trip_metrics CASCADE;
DROP TABLE IF EXISTS trip_fares CASCADE;
DROP TABLE IF EXISTS trips CASCADE;
DROP TABLE IF EXISTS payment_types CASCADE;
DROP TABLE IF EXISTS rate_codes CASCADE;
DROP TABLE IF EXISTS vendors CASCADE;
DROP TABLE IF EXISTS zones CASCADE;

CREATE TABLE zones (
    location_id INTEGER PRIMARY KEY,
    borough VARCHAR(64) NOT NULL,
    zone VARCHAR(128) NOT NULL,
    service_zone VARCHAR(64)
);

CREATE TABLE vendors (
    vendor_id INTEGER PRIMARY KEY,
    vendor_name VARCHAR(64) NOT NULL
);

CREATE TABLE rate_codes (
    rate_code_id INTEGER PRIMARY KEY,
    rate_code_name VARCHAR(64) NOT NULL
);

CREATE TABLE payment_types (
    payment_type_id INTEGER PRIMARY KEY,
    payment_type_name VARCHAR(64) NOT NULL
);

CREATE TABLE trips (
    trip_id BIGSERIAL PRIMARY KEY,
    vendor_id INTEGER REFERENCES vendors(vendor_id),
    pickup_datetime TIMESTAMP NOT NULL,
    dropoff_datetime TIMESTAMP NOT NULL,
    pickup_location_id INTEGER NOT NULL REFERENCES zones(location_id),
    dropoff_location_id INTEGER NOT NULL REFERENCES zones(location_id),
    rate_code_id INTEGER REFERENCES rate_codes(rate_code_id),
    payment_type_id INTEGER REFERENCES payment_types(payment_type_id),
    passenger_count INTEGER NOT NULL CHECK (passenger_count BETWEEN 1 AND 6),
    trip_distance NUMERIC(10, 3) NOT NULL CHECK (trip_distance > 0 AND trip_distance <= 100),
    store_and_fwd_flag CHAR(1),
    CONSTRAINT chk_time_order CHECK (dropoff_datetime > pickup_datetime)
);

CREATE TABLE trip_fares (
    trip_id BIGINT PRIMARY KEY REFERENCES trips(trip_id) ON DELETE CASCADE,
    fare_amount NUMERIC(10, 2) NOT NULL CHECK (fare_amount > 0 AND fare_amount <= 500),
    extra NUMERIC(10, 2) DEFAULT 0,
    mta_tax NUMERIC(10, 2) DEFAULT 0,
    tip_amount NUMERIC(10, 2) DEFAULT 0,
    tolls_amount NUMERIC(10, 2) DEFAULT 0,
    improvement_surcharge NUMERIC(10, 2) DEFAULT 0,
    congestion_surcharge NUMERIC(10, 2) DEFAULT 0,
    airport_fee NUMERIC(10, 2) DEFAULT 0,
    total_amount NUMERIC(10, 2) NOT NULL
);

CREATE TABLE trip_metrics (
    trip_id BIGINT PRIMARY KEY REFERENCES trips(trip_id) ON DELETE CASCADE,
    trip_duration_minutes NUMERIC(10, 2) NOT NULL CHECK (trip_duration_minutes > 0 AND trip_duration_minutes <= 360),
    fare_per_mile NUMERIC(10, 2) NOT NULL CHECK (fare_per_mile >= 0),
    speed_mph NUMERIC(10, 2) NOT NULL CHECK (speed_mph >= 0 AND speed_mph <= 120),
    pickup_hour SMALLINT NOT NULL CHECK (pickup_hour BETWEEN 0 AND 23),
    pickup_weekday SMALLINT NOT NULL CHECK (pickup_weekday BETWEEN 0 AND 6)
);

CREATE TABLE exclusion_log (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    row_index BIGINT,
    reason VARCHAR(100) NOT NULL,
    details TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trips_pickup_datetime ON trips (pickup_datetime);
CREATE INDEX idx_trips_dropoff_datetime ON trips (dropoff_datetime);
CREATE INDEX idx_trips_pickup_location ON trips (pickup_location_id);
CREATE INDEX idx_trips_dropoff_location ON trips (dropoff_location_id);
CREATE INDEX idx_trip_fares_total_amount ON trip_fares (total_amount);
CREATE INDEX idx_trip_metrics_pickup_hour ON trip_metrics (pickup_hour);
