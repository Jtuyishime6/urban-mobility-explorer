const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const Database = require('better-sqlite3');
const { createApp, dateToUtcBoundary } = require('../app');

let database;
let server;
let baseUrl;

before(async () => {
    database = new Database(':memory:');
    database.exec(`
        PRAGMA foreign_keys = ON;
        ${require('node:fs').readFileSync(
            require('node:path').join(__dirname, '..', '..', 'database', 'schema.sql'),
            'utf8'
        )}
    `);
    database.exec(`
        INSERT INTO boroughs (borough_id, borough_name) VALUES
            (1, 'Manhattan'), (2, 'Brooklyn');
        INSERT INTO service_zones (service_zone_id, service_zone_name) VALUES
            (1, 'Yellow Zone');
        INSERT INTO taxi_zones
            (location_id, borough_id, zone_name, service_zone_id, geometry_json)
        VALUES
            (1, 1, 'Zone A', 1, '{"type":"Polygon","coordinates":[]}'),
            (2, 2, 'Zone B', 1, '{"type":"Polygon","coordinates":[]}'),
            (3, 1, 'Zone C', 1, '{"type":"Polygon","coordinates":[]}');
        INSERT INTO rate_codes (rate_code_id, rate_code_name) VALUES (1, 'Standard rate');
        INSERT INTO payment_types (payment_type_id, payment_type_name) VALUES (1, 'Credit card');
    `);

    const insertTrip = database.prepare(`
        INSERT INTO trips (
            trip_hash, pickup_datetime, dropoff_datetime, passenger_count,
            trip_distance, rate_code_id, store_and_fwd_flag,
            pickup_location_id, dropoff_location_id, payment_type_id,
            fare_amount, extra, mta_tax, tip_amount, tolls_amount,
            improvement_surcharge, total_amount, congestion_surcharge,
            airport_fee, cbd_congestion_fee, duration_seconds,
            average_speed_mph, fare_per_mile
        ) VALUES (
            ?, ?, ?, ?, ?, 1, 'N', ?, ?, 1, ?, 0, 0, 0, 0, 0, ?,
            0, 0, 0, ?, ?, ?
        )
    `);
    insertTrip.run(
        'trip-1', '2019-01-01T05:00:00+00:00', '2019-01-01T05:15:00+00:00',
        1, 3, 1, 2, 12, 15, 900, 12, 4
    );
    insertTrip.run(
        'trip-2', '2019-01-01T18:00:00+00:00', '2019-01-01T18:15:00+00:00',
        2, 0.5, 1, 1, 150, 152, 900, 8, 300
    );
    insertTrip.run(
        'trip-3', '2019-01-02T01:00:00+00:00', '2019-01-02T01:15:00+00:00',
        1, 4, 2, 2, 16, 18, 900, 16, 4
    );
    // Corridor edges for Dijkstra: A→C (300s) then C→B (300s) beats direct A→B (900s).
    insertTrip.run(
        'trip-4', '2019-01-01T12:00:00+00:00', '2019-01-01T12:05:00+00:00',
        1, 1, 1, 3, 8, 10, 300, 12, 8
    );
    insertTrip.run(
        'trip-5', '2019-01-01T13:00:00+00:00', '2019-01-01T13:05:00+00:00',
        1, 1, 3, 2, 8, 10, 300, 12, 8
    );

    server = createApp(database).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
    database.close();
});

test('converts local date boundaries correctly across daylight saving time', () => {
    assert.equal(dateToUtcBoundary('2019-01-01'), '2019-01-01T05:00:00+00:00');
    assert.equal(dateToUtcBoundary('2019-07-01'), '2019-07-01T04:00:00+00:00');
});

test('reports API health and allows the local dashboard origin', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { status: 'ok', database: 'connected' });
});

test('serves taxi zone GeoJSON in the dashboard shape', async () => {
    const response = await fetch(`${baseUrl}/api/zones`);
    assert.equal(response.status, 200);
    const zones = await response.json();
    assert.equal(zones.length, 3);
    assert.deepEqual(zones[0], {
        id: 2,
        borough: 'Brooklyn',
        zone: 'Zone B',
        geometry: { type: 'Polygon', coordinates: [] }
    });
});

test('filters summary by New York calendar date and returns aggregate metrics', async () => {
    const response = await fetch(
        `${baseUrl}/api/trips/summary?start_date=2019-01-01&end_date=2019-01-01`
    );
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.totalTrips, 5);
    assert.equal(summary.totalPassengers, 6);
    assert.equal(summary.totalRevenue, 205);
    assert.equal(summary.anomalyDetails.fare, 1);
    assert.equal(summary.totalAnomalies, 1);
    assert.equal(summary.topZones[0].zone, 'Zone A');
});

test('applies distance and fare limits and validates sort selections', async () => {
    const response = await fetch(
        `${baseUrl}/api/trips/summary?start_date=2019-01-01&end_date=2019-01-01` +
        '&max_distance=4&max_fare=20&sort_by=fare&sort_order=asc'
    );
    const summary = await response.json();
    assert.equal(response.status, 200);
    assert.equal(summary.totalTrips, 4);
    assert.equal(summary.totalRevenue, 53);
    assert.deepEqual(summary.topZones.map(zone => zone.zone), ['Zone C', 'Zone A', 'Zone B']);
});

test('returns 24 local-time hourly buckets and fare-distance groups', async () => {
    const hourlyResponse = await fetch(`${baseUrl}/api/trips/hourly?start_date=2019-01-01`);
    const hourly = await hourlyResponse.json();
    assert.equal(Object.keys(hourly).length, 24);
    assert.equal(hourly['0'].trips, 1);

    const fareResponse = await fetch(`${baseUrl}/api/trips/fare-distance?start_date=2019-01-01`);
    const fareGroups = await fareResponse.json();
    assert.equal(fareGroups.length, 6);
    assert.equal(fareGroups[0].trips, 3);
    assert.equal(fareGroups[0].avgFare, 55.33);
});

test('rejects invalid filters and unknown zones with JSON errors', async () => {
    const invalidDate = await fetch(`${baseUrl}/api/trips/summary?start_date=2019-02-31`);
    assert.equal(invalidDate.status, 400);
    assert.match((await invalidDate.json()).error, /valid calendar date/);

    const unknownZone = await fetch(`${baseUrl}/api/trips/summary?zone_id=999`);
    assert.equal(unknownZone.status, 404);
    assert.match((await unknownZone.json()).error, /was not found/);

    const unsafeSort = await fetch(`${baseUrl}/api/trips/summary?sort_by=volume%20DESC`);
    assert.equal(unsafeSort.status, 400);
});

test('returns zone and borough summaries and coverage gaps', async () => {
    const zoneResponse = await fetch(`${baseUrl}/api/zones/1/stats?start_date=2019-01-01`);
    const zoneStats = await zoneResponse.json();
    assert.equal(zoneStats.pickupCount, 3);
    assert.equal(zoneStats.dropoffCount, 1);
    assert.equal(zoneStats.coverageRatio, 0.33);

    const boroughResponse = await fetch(`${baseUrl}/api/boroughs/Manhattan/stats`);
    const boroughStats = await boroughResponse.json();
    assert.equal(boroughStats.zoneCount, 2);
    assert.equal(boroughStats.totalTrips, 4);

    const gapsResponse = await fetch(`${baseUrl}/api/trips/gaps?start_date=2019-01-01`);
    const gaps = await gapsResponse.json();
    assert.ok(gaps.length > 0);
    assert.ok(gaps.every(gap => gap.coverageRatio < 0.6 || gap.coverageRatio > 1.8));
});

test('returns average borough speed in the congestion chart response shape', async () => {
    const response = await fetch(`${baseUrl}/api/trips/revenue`);
    assert.equal(response.status, 200);
    const speeds = await response.json();
    assert.equal(speeds.Brooklyn, 16);
    assert.equal(speeds.Manhattan, 11);
});

test('builds a report with top zones and hourly rush-hour data', async () => {
    const response = await fetch(`${baseUrl}/api/report?start_date=2019-01-01`);
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.equal(report.metadata.scope, 'Citywide');
    assert.equal(report.summary.totalTrips, 5);
    assert.equal(report.topZones.length, 3);
    assert.equal(Object.keys(report.rushHour.trend).length, 24);
});

test('runs custom Dijkstra corridor search between taxi zones', async () => {
    const response = await fetch(
        `${baseUrl}/api/routes/optimal?from=1&to=2&start_date=2019-01-01&end_date=2019-01-01`
    );
    assert.equal(response.status, 200);
    const route = await response.json();
    assert.equal(route.algorithm, 'dijkstra');
    assert.equal(route.dataStructure, 'binary_min_heap');
    assert.equal(route.found, true);
    assert.deepEqual(route.path.map(zone => zone.id), [1, 3, 2]);
    assert.equal(route.hops, 2);
    assert.equal(route.totalDurationSeconds, 600);
    assert.equal(route.complexity.time, 'O((V + E) log V)');

    const missing = await fetch(`${baseUrl}/api/routes/optimal?from=1`);
    assert.equal(missing.status, 400);

    const unknown = await fetch(`${baseUrl}/api/routes/optimal?from=1&to=999`);
    assert.equal(unknown.status, 404);
});
