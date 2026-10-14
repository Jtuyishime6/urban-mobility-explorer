const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'data', 'urban_mobility.sqlite');
const schemaPath = path.resolve(__dirname, '..', 'database', 'schema.sql');

if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// 1. Run schema
const schemaSql = fs.readFileSync(schemaPath, 'utf8');
db.exec(schemaSql);

// 2. Seed Dimensions
const insertBorough = db.prepare('INSERT OR IGNORE INTO boroughs (borough_id, borough_name) VALUES (?, ?)');
const boroughs = [
    [1, 'Manhattan'],
    [2, 'Brooklyn'],
    [3, 'Queens'],
    [4, 'Bronx'],
    [5, 'Staten Island'],
    [6, 'EWR']
];
for (const b of boroughs) insertBorough.run(...b);

const insertServiceZone = db.prepare('INSERT OR IGNORE INTO service_zones (service_zone_id, service_zone_name) VALUES (?, ?)');
insertServiceZone.run(1, 'Yellow Zone');
insertServiceZone.run(2, 'Boro Zone');
insertServiceZone.run(3, 'Airports');

const insertRateCode = db.prepare('INSERT OR IGNORE INTO rate_codes (rate_code_id, rate_code_name) VALUES (?, ?)');
insertRateCode.run(1, 'Standard rate');
insertRateCode.run(2, 'JFK');
insertRateCode.run(3, 'Newark');

const insertPayment = db.prepare('INSERT OR IGNORE INTO payment_types (payment_type_id, payment_type_name) VALUES (?, ?)');
insertPayment.run(1, 'Credit card');
insertPayment.run(2, 'Cash');

// 3. Seed Zones (read from frontend/js/sample-zones.js or standard 10 sample zones)
const sampleZones = [
    { id: 1, borough_id: 1, zone: "Financial District", sz_id: 1, lat: 40.7074, lon: -74.0141 },
    { id: 2, borough_id: 1, zone: "Midtown", sz_id: 1, lat: 40.7589, lon: -73.9885 },
    { id: 3, borough_id: 1, zone: "Upper East Side", sz_id: 1, lat: 40.7736, lon: -73.9665 },
    { id: 4, borough_id: 2, zone: "Williamsburg", sz_id: 2, lat: 40.7181, lon: -73.9635 },
    { id: 5, borough_id: 2, zone: "Downtown Brooklyn", sz_id: 2, lat: 40.6945, lon: -73.9885 },
    { id: 6, borough_id: 3, zone: "Astoria", sz_id: 2, lat: 40.7644, lon: -73.9282 },
    { id: 7, borough_id: 3, zone: "Long Island City", sz_id: 2, lat: 40.7505, lon: -73.9445 },
    { id: 8, borough_id: 4, zone: "Yankee Stadium", sz_id: 2, lat: 40.8296, lon: -73.9275 },
    { id: 9, borough_id: 5, zone: "St. George", sz_id: 2, lat: 40.6435, lon: -74.0765 },
    { id: 10, borough_id: 1, zone: "Times Square", sz_id: 1, lat: 40.7580, lon: -73.9870 }
];

const insertZone = db.prepare(`
    INSERT INTO taxi_zones (location_id, borough_id, zone_name, service_zone_id, geometry_json)
    VALUES (?, ?, ?, ?, ?)
`);

for (const z of sampleZones) {
    const poly = {
        type: "Polygon",
        coordinates: [[
            [z.lon, z.lat],
            [z.lon + 0.009, z.lat],
            [z.lon + 0.009, z.lat - 0.006],
            [z.lon, z.lat - 0.006],
            [z.lon, z.lat]
        ]]
    };
    insertZone.run(z.id, z.borough_id, z.zone, z.sz_id, JSON.stringify(poly));
}

// 4. Seed Trips
const insertTrip = db.prepare(`
    INSERT INTO trips (
        trip_hash, pickup_datetime, dropoff_datetime, passenger_count,
        trip_distance, rate_code_id, store_and_fwd_flag,
        pickup_location_id, dropoff_location_id, payment_type_id,
        fare_amount, extra, mta_tax, tip_amount, tolls_amount,
        improvement_surcharge, total_amount, congestion_surcharge,
        airport_fee, cbd_congestion_fee, duration_seconds,
        average_speed_mph, fare_per_mile
    ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
`);

const insertAudit = db.prepare(`
    INSERT INTO data_quality_issues (
        source_file, source_row, status, reason, record_json
    ) VALUES (?, ?, ?, ?, ?)
`);

const startJan = new Date(Date.UTC(2019, 0, 1, 0, 0, 0)).getTime();
const endJan = new Date(Date.UTC(2019, 0, 31, 23, 59, 59)).getTime();

console.log("Seeding sample trips...");
const insertMany = db.transaction((numTrips) => {
    for (let i = 0; i < numTrips; i++) {
        const randTime = startJan + Math.random() * (endJan - startJan);
        const pDate = new Date(randTime);
        const puHour = pDate.getUTCHours();
        const isPeak = (puHour >= 8 && puHour <= 10) || (puHour >= 17 && puHour <= 20);

        const dist = +(0.8 + Math.random() * 12).toFixed(2);
        // speed between 6 and 28 mph
        const baseSpeed = isPeak ? (7 + Math.random() * 6) : (14 + Math.random() * 12);
        // occasionally generate speed anomaly
        const isSpeedAnom = (i % 250 === 0);
        const speed = isSpeedAnom ? 88.5 : +baseSpeed.toFixed(1);

        const durationSeconds = Math.max(120, Math.round((dist / speed) * 3600));
        const dDate = new Date(pDate.getTime() + durationSeconds * 1000);

        const isFareAnom = (i % 300 === 0);
        const baseFare = +(2.5 + dist * 2.8 + (durationSeconds / 60) * 0.5).toFixed(2);
        const fare = isFareAnom ? 120.00 : Math.max(3.0, baseFare);
        const total = +(fare + 0.5 + 0.5 + 2.5).toFixed(2);
        const farePerMile = +(fare / dist).toFixed(2);

        const puZone = (i % 10) + 1;
        let doZone = ((i + Math.floor(Math.random() * 8) + 1) % 10) + 1;
        if (puZone === doZone) doZone = (puZone % 10) + 1;

        const hash = crypto.createHash('sha256').update(`seed-${i}-${randTime}`).digest('hex');

        insertTrip.run(
            hash,
            pDate.toISOString().replace('.000Z', '+00:00'),
            dDate.toISOString().replace('.000Z', '+00:00'),
            (i % 4) + 1,
            dist,
            1,
            'N',
            puZone,
            doZone,
            1,
            fare,
            0.5,
            0.5,
            +(fare * 0.18).toFixed(2),
            0.0,
            0.3,
            total,
            2.5,
            0.0,
            0.0,
            durationSeconds,
            speed,
            farePerMile
        );
    }

    // Seed audit issues
    insertAudit.run("yellow_tripdata_2019-01.parquet", 1042, "excluded", "SPEED_EXCEEDS_MAXIMUM", JSON.stringify({ speed: 114.2, distance: 4.1 }));
    insertAudit.run("yellow_tripdata_2019-01.parquet", 4821, "excluded", "NEGATIVE_FARE", JSON.stringify({ fare_amount: -12.50 }));
    insertAudit.run("yellow_tripdata_2019-01.parquet", 8912, "excluded", "ZERO_PASSENGERS", JSON.stringify({ passenger_count: 0 }));
});

insertMany(1500);

console.log("Database seeded successfully at:", dbPath);
console.log("Zones count:", db.prepare("SELECT COUNT(*) c FROM taxi_zones").get().c);
console.log("Trips count:", db.prepare("SELECT COUNT(*) c FROM trips").get().c);
db.close();
