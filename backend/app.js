const express = require('express');
const { findOptimalCorridor } = require('./algorithms');

const NEW_YORK = 'America/New_York';
const LOCAL_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
});
const LOCAL_HOUR_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK,
    hour: '2-digit',
    hourCycle: 'h23'
});
const SORT_COLUMNS = {
    volume: 'COUNT(*)',
    speed: 'AVG(t.average_speed_mph)',
    distance: 'AVG(t.trip_distance)',
    fare: 'AVG(t.fare_amount)'
};

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function round(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(digits)) : 0;
}

function scalarQueryValue(value, name) {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') {
        throw new HttpError(400, `${name} must be provided once as a string`);
    }
    return value;
}

function parseDate(value, name) {
    if (value === undefined) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new HttpError(400, `${name} must use YYYY-MM-DD format`);
    }
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
        throw new HttpError(400, `${name} must be a valid calendar date`);
    }
    return value;
}

function dateToUtcBoundary(date) {
    const [year, month, day] = date.split('-').map(Number);
    const target = Date.UTC(year, month - 1, day);
    let candidate = target;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const parts = Object.fromEntries(
            LOCAL_PARTS_FORMATTER.formatToParts(new Date(candidate))
                .filter(part => part.type !== 'literal')
                .map(part => [part.type, Number(part.value)])
        );
        const localAsUtc = Date.UTC(
            parts.year,
            parts.month - 1,
            parts.day,
            parts.hour,
            parts.minute,
            parts.second
        );
        const adjustment = target - localAsUtc;
        candidate += adjustment;
        if (adjustment === 0) break;
    }

    return new Date(candidate).toISOString().replace('.000Z', '+00:00');
}

function nextCalendarDate(date) {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function parseNumber(value, name, min, max) {
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new HttpError(400, `${name} must be between ${min} and ${max}`);
    }
    return number;
}

function parsePositiveInt(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new HttpError(400, `${name} must be a positive integer`);
    }
    return number;
}

function requireExistingZone(db, zoneId, name) {
    if (!db.prepare('SELECT 1 FROM taxi_zones WHERE location_id = ?').get(zoneId)) {
        throw new HttpError(404, `Taxi zone ${zoneId} (${name}) was not found`);
    }
}

function buildFilters(db, query, { includeScope = true } = {}) {
    const startDate = parseDate(scalarQueryValue(query.start_date, 'start_date'), 'start_date');
    const endDate = parseDate(scalarQueryValue(query.end_date, 'end_date'), 'end_date');
    if (startDate && endDate && startDate > endDate) {
        throw new HttpError(400, 'start_date must be on or before end_date');
    }

    const zoneValue = scalarQueryValue(query.zone_id, 'zone_id');
    let zoneId;
    if (zoneValue !== undefined) {
        zoneId = Number(zoneValue);
        if (!Number.isSafeInteger(zoneId) || zoneId <= 0) {
            throw new HttpError(400, 'zone_id must be a positive integer');
        }
        if (!db.prepare('SELECT 1 FROM taxi_zones WHERE location_id = ?').get(zoneId)) {
            throw new HttpError(404, `Taxi zone ${zoneId} was not found`);
        }
    }

    let borough = scalarQueryValue(query.borough, 'borough');
    if (borough === 'all' || borough === 'All Boroughs') borough = undefined;
    if (borough !== undefined &&
        !db.prepare('SELECT 1 FROM boroughs WHERE borough_name = ?').get(borough)) {
        throw new HttpError(400, `Unknown borough: ${borough}`);
    }

    const maxDistance = parseNumber(
        scalarQueryValue(query.max_distance, 'max_distance'),
        'max_distance',
        0,
        200
    );
    const maxFare = parseNumber(
        scalarQueryValue(query.max_fare, 'max_fare'),
        'max_fare',
        0,
        1000
    );
    const conditions = [];
    const params = [];

    if (startDate) {
        conditions.push('t.pickup_datetime >= ?');
        params.push(dateToUtcBoundary(startDate));
    }
    if (endDate) {
        conditions.push('t.pickup_datetime < ?');
        params.push(dateToUtcBoundary(nextCalendarDate(endDate)));
    }
    if (includeScope && zoneId !== undefined) {
        conditions.push('(t.pickup_location_id = ? OR t.dropoff_location_id = ?)');
        params.push(zoneId, zoneId);
    }
    if (includeScope && borough !== undefined) {
        conditions.push(`(
            EXISTS (
                SELECT 1 FROM taxi_zones pickup_zone
                JOIN boroughs pickup_borough USING (borough_id)
                WHERE pickup_zone.location_id = t.pickup_location_id
                    AND pickup_borough.borough_name = ?
            )
            OR EXISTS (
                SELECT 1 FROM taxi_zones dropoff_zone
                JOIN boroughs dropoff_borough USING (borough_id)
                WHERE dropoff_zone.location_id = t.dropoff_location_id
                    AND dropoff_borough.borough_name = ?
            )
        )`);
        params.push(borough, borough);
    }
    if (maxDistance !== undefined) {
        conditions.push('t.trip_distance <= ?');
        params.push(maxDistance);
    }
    if (maxFare !== undefined) {
        conditions.push('t.fare_amount <= ?');
        params.push(maxFare);
    }

    return {
        where: conditions.length ? conditions.join(' AND ') : '1 = 1',
        params,
        startDate,
        endDate,
        zoneId,
        borough
    };
}

function parseSort(query) {
    const sortBy = scalarQueryValue(query.sort_by, 'sort_by') || 'volume';
    if (!Object.hasOwn(SORT_COLUMNS, sortBy)) {
        throw new HttpError(400, 'sort_by must be one of: volume, speed, distance, fare');
    }
    const sortOrder = (scalarQueryValue(query.sort_order, 'sort_order') || 'desc').toLowerCase();
    if (!['asc', 'desc'].includes(sortOrder)) {
        throw new HttpError(400, 'sort_order must be asc or desc');
    }
    return { sortBy, sortOrder };
}

function getSummary(db, filters) {
    const row = db.prepare(`
        SELECT
            COUNT(*) AS totalTrips,
            COALESCE(SUM(t.passenger_count), 0) AS totalPassengers,
            COALESCE(SUM(t.total_amount), 0) AS totalRevenue,
            COALESCE(AVG(t.average_speed_mph), 0) AS avgSpeed,
            COALESCE(AVG(t.trip_distance), 0) AS avgDistance,
            COALESCE(SUM(CASE WHEN t.average_speed_mph > 80 THEN 1 ELSE 0 END), 0) AS speedAnomalies,
            COALESCE(SUM(CASE
                WHEN t.trip_distance < 1 AND t.fare_amount > 100 THEN 1 ELSE 0
            END), 0) AS fareAnomalies,
            COALESCE(SUM(CASE
                WHEN t.average_speed_mph > 80
                    OR (t.trip_distance < 1 AND t.fare_amount > 100)
                THEN 1 ELSE 0
            END), 0) AS totalAnomalies
        FROM trips t
        WHERE ${filters.where}
    `).get(...filters.params);
    const totalTrips = Number(row.totalTrips);
    const totalAnomalies = Number(row.totalAnomalies);
    const avgSpeed = round(row.avgSpeed, 1);

    return {
        totalTrips,
        totalPassengers: Number(row.totalPassengers),
        totalRevenue: round(row.totalRevenue),
        avgSpeed,
        avgMobilitySpeed: avgSpeed,
        avgDistance: round(row.avgDistance, 2),
        totalAnomalies,
        systemHealth: totalTrips
            ? round(((totalTrips - totalAnomalies) / totalTrips) * 100, 1)
            : 0,
        anomalyDetails: {
            speed: Number(row.speedAnomalies),
            fare: Number(row.fareAnomalies)
        }
    };
}

function getTopZones(db, filters, sortBy, sortOrder, limit = 10) {
    const rows = db.prepare(`
        SELECT
            z.location_id AS id,
            z.zone_name AS zone,
            b.borough_name AS borough,
            COUNT(*) AS trips,
            AVG(t.average_speed_mph) AS speed,
            AVG(t.trip_distance) AS distance,
            AVG(t.fare_amount) AS fare
        FROM trips t
        JOIN taxi_zones z ON z.location_id = t.pickup_location_id
        JOIN boroughs b USING (borough_id)
        WHERE ${filters.where}
        GROUP BY z.location_id, z.zone_name, b.borough_name
        ORDER BY ${SORT_COLUMNS[sortBy]} ${sortOrder}, z.location_id ASC
        LIMIT ?
    `).all(...filters.params, limit);

    return rows.map(row => ({
        id: Number(row.id),
        zone: row.zone,
        borough: row.borough,
        trips: Number(row.trips),
        speed: round(row.speed, 1),
        distance: round(row.distance, 2),
        fare: round(row.fare)
    }));
}

function getHourlyDistribution(db, filters) {
    const data = Object.fromEntries(
        Array.from({ length: 24 }, (_, hour) => [String(hour), { trips: 0, speed: 0 }])
    );
    const speedTotals = new Array(24).fill(0);
    const rows = db.prepare(`
        SELECT
            substr(t.pickup_datetime, 1, 13) AS utcHour,
            COUNT(*) AS trips,
            AVG(t.average_speed_mph) AS speed
        FROM trips t
        WHERE ${filters.where}
        GROUP BY utcHour
    `).all(...filters.params);

    for (const row of rows) {
        const hourDate = new Date(`${row.utcHour}:00:00+00:00`);
        const localHour = Number(LOCAL_HOUR_FORMATTER.format(hourDate));
        const trips = Number(row.trips);
        data[String(localHour)].trips += trips;
        speedTotals[localHour] += Number(row.speed) * trips;
    }
    for (let hour = 0; hour < 24; hour += 1) {
        const key = String(hour);
        data[key].speed = data[key].trips
            ? round(speedTotals[hour] / data[key].trips, 1)
            : 0;
    }
    return data;
}

function getCoverageGaps(db, filters) {
    const zoneConditions = [];
    const zoneParams = [];
    if (filters.borough !== undefined) {
        zoneConditions.push('b.borough_name = ?');
        zoneParams.push(filters.borough);
    }
    if (filters.zoneId !== undefined) {
        zoneConditions.push('z.location_id = ?');
        zoneParams.push(filters.zoneId);
    }
    const zoneScope = zoneConditions.length ? `WHERE ${zoneConditions.join(' AND ')}` : '';
    const rows = db.prepare(`
        SELECT
            z.location_id AS id,
            z.zone_name AS zone,
            b.borough_name AS borough,
            COALESCE(p.pickup_count, 0) AS pickupCount,
            COALESCE(d.dropoff_count, 0) AS dropoffCount
        FROM taxi_zones z
        JOIN boroughs b USING (borough_id)
        LEFT JOIN (
            SELECT t.pickup_location_id AS location_id, COUNT(*) AS pickup_count
            FROM trips t WHERE ${filters.where}
            GROUP BY t.pickup_location_id
        ) p ON p.location_id = z.location_id
        LEFT JOIN (
            SELECT t.dropoff_location_id AS location_id, COUNT(*) AS dropoff_count
            FROM trips t WHERE ${filters.where}
            GROUP BY t.dropoff_location_id
        ) d ON d.location_id = z.location_id
        ${zoneScope}
        ORDER BY z.location_id
    `).all(...filters.params, ...filters.params, ...zoneParams);

    return rows.flatMap(row => {
        const pickups = Number(row.pickupCount);
        const dropoffs = Number(row.dropoffCount);
        const coverageRatio = pickups ? round(dropoffs / pickups, 2) : (dropoffs ? dropoffs : 1);
        if (coverageRatio >= 0.6 && coverageRatio <= 1.8) return [];
        return [{
            id: Number(row.id),
            zone: row.zone,
            borough: row.borough,
            pickupCount: pickups,
            dropoffCount: dropoffs,
            coverageRatio,
            ratio: coverageRatio
        }];
    });
}

function getZoneStats(db, zoneId, query) {
    const zone = db.prepare(`
        SELECT z.location_id AS id, z.zone_name AS zone, b.borough_name AS borough
        FROM taxi_zones z JOIN boroughs b USING (borough_id)
        WHERE z.location_id = ?
    `).get(zoneId);
    if (!zone) throw new HttpError(404, `Taxi zone ${zoneId} was not found`);

    const filters = buildFilters(db, query, { includeScope: false });
    const pickup = db.prepare(`
        SELECT
            COUNT(*) AS pickupCount,
            COALESCE(SUM(t.passenger_count), 0) AS pickupPassengers,
            COALESCE(AVG(t.trip_distance), 0) AS avgDistance,
            COALESCE(AVG(t.duration_seconds) / 60.0, 0) AS avgDuration,
            COALESCE(AVG(t.average_speed_mph), 0) AS avgSpeed,
            COALESCE(AVG(t.fare_amount), 0) AS avgFare
        FROM trips t
        WHERE ${filters.where} AND t.pickup_location_id = ?
    `).get(...filters.params, zoneId);
    const dropoff = db.prepare(`
        SELECT
            COUNT(*) AS dropoffCount,
            COALESCE(SUM(t.passenger_count), 0) AS dropoffPassengers
        FROM trips t
        WHERE ${filters.where} AND t.dropoff_location_id = ?
    `).get(...filters.params, zoneId);
    const boroughSpeed = db.prepare(`
        SELECT COALESCE(AVG(t.average_speed_mph), 0) AS avgSpeed
        FROM trips t
        JOIN taxi_zones pickup_zone ON pickup_zone.location_id = t.pickup_location_id
        JOIN boroughs b USING (borough_id)
        WHERE ${filters.where} AND b.borough_name = ?
    `).get(...filters.params, zone.borough);

    const pickupCount = Number(pickup.pickupCount);
    const dropoffCount = Number(dropoff.dropoffCount);
    const avgSpeed = round(pickup.avgSpeed, 1);
    const boroughAvgSpeed = round(boroughSpeed.avgSpeed, 1);
    return {
        id: Number(zone.id),
        zone: zone.zone,
        borough: zone.borough,
        pickupCount,
        dropoffCount,
        pickupPassengers: Number(pickup.pickupPassengers),
        dropoffPassengers: Number(dropoff.dropoffPassengers),
        avgDistance: round(pickup.avgDistance, 2),
        avgDuration: round(pickup.avgDuration, 1),
        avgSpeed,
        avgFare: round(pickup.avgFare),
        boroughAvgSpeed,
        speedComparison: boroughAvgSpeed
            ? round(((avgSpeed - boroughAvgSpeed) / boroughAvgSpeed) * 100, 1)
            : 0,
        coverageRatio: pickupCount
            ? round(dropoffCount / pickupCount, 2)
            : (dropoffCount ? dropoffCount : 1)
    };
}

function getBoroughStats(db, borough, query) {
    const allBoroughs = borough === 'All Boroughs' || borough === 'all';
    const boroughRow = allBoroughs
        ? null
        : db.prepare('SELECT borough_id FROM boroughs WHERE borough_name = ?').get(borough);
    if (!allBoroughs && !boroughRow) throw new HttpError(404, `Borough ${borough} was not found`);

    const filters = buildFilters(db, query, { includeScope: false });
    const boroughCondition = allBoroughs ? '' : 'AND z.borough_id = ?';
    const params = allBoroughs
        ? filters.params
        : [...filters.params, Number(boroughRow.borough_id)];
    const tripRow = db.prepare(`
        SELECT
            COUNT(*) AS totalTrips,
            COALESCE(AVG(t.average_speed_mph), 0) AS avgSpeed,
            COALESCE(AVG(t.fare_amount), 0) AS avgFare,
            COALESCE(AVG(t.trip_distance), 0) AS avgDistance
        FROM trips t
        ${allBoroughs ? '' : 'JOIN taxi_zones z ON z.location_id = t.pickup_location_id'}
        WHERE ${filters.where} ${boroughCondition}
    `).get(...params);
    const zoneCount = allBoroughs
        ? db.prepare('SELECT COUNT(*) AS count FROM taxi_zones').get().count
        : db.prepare('SELECT COUNT(*) AS count FROM taxi_zones WHERE borough_id = ?')
            .get(Number(boroughRow.borough_id)).count;
    return {
        borough: allBoroughs ? 'All Boroughs' : borough,
        zoneCount: Number(zoneCount),
        totalTrips: Number(tripRow.totalTrips),
        avgSpeed: round(tripRow.avgSpeed, 1),
        avgFare: round(tripRow.avgFare),
        avgDistance: round(tripRow.avgDistance, 2)
    };
}

function getFareDistance(db, filters) {
    const labels = ['0-2 mi', '2-5 mi', '5-10 mi', '10-15 mi', '15-20 mi', '20+ mi'];
    const buckets = labels.map((label, index) => ({
        bucket: label,
        trips: 0,
        avgFare: 0
    }));
    const rows = db.prepare(`
        SELECT
            CASE
                WHEN t.trip_distance < 2 THEN 0
                WHEN t.trip_distance < 5 THEN 1
                WHEN t.trip_distance < 10 THEN 2
                WHEN t.trip_distance < 15 THEN 3
                WHEN t.trip_distance < 20 THEN 4
                ELSE 5
            END AS bucket,
            COUNT(*) AS trips,
            AVG(t.fare_amount) AS avgFare
        FROM trips t
        WHERE ${filters.where}
        GROUP BY bucket
        ORDER BY bucket
    `).all(...filters.params);
    for (const row of rows) {
        buckets[row.bucket].trips = Number(row.trips);
        buckets[row.bucket].avgFare = round(row.avgFare);
    }
    return buckets;
}

function getBoroughMetadata(db, borough, filters) {
    const boroughRow = db.prepare(
        'SELECT borough_id FROM boroughs WHERE borough_name = ?'
    ).get(borough);
    const zoneCount = Number(db.prepare(
        'SELECT COUNT(*) AS count FROM taxi_zones WHERE borough_id = ?'
    ).get(Number(boroughRow.borough_id)).count);
    const rows = db.prepare(`
        SELECT
            COALESCE(SUM(CASE WHEN z.borough_id = ? THEN t.passenger_count ELSE 0 END), 0) AS pickupPassengers,
            COALESCE(SUM(CASE WHEN d.borough_id = ? THEN t.passenger_count ELSE 0 END), 0) AS dropoffPassengers
        FROM trips t
        JOIN taxi_zones z ON z.location_id = t.pickup_location_id
        JOIN taxi_zones d ON d.location_id = t.dropoff_location_id
        WHERE ${filters.where}
    `).get(Number(boroughRow.borough_id), Number(boroughRow.borough_id), ...filters.params);
    const underservedZones = getCoverageGaps(db, { ...filters, borough });
    return {
        zoneCount,
        pickupPassengers: Number(rows.pickupPassengers),
        dropoffPassengers: Number(rows.dropoffPassengers),
        underservedZones
    };
}

function createApp(db) {
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    app.get('/api/health', (_req, res) => {
        db.prepare('SELECT 1').get();
        res.json({ status: 'ok', database: 'connected' });
    });

    app.get('/api/zones', (_req, res) => {
        const rows = db.prepare(`
            SELECT
                z.location_id AS id,
                b.borough_name AS borough,
                z.zone_name AS zone,
                z.geometry_json AS geometry
            FROM taxi_zones z
            JOIN boroughs b USING (borough_id)
            ORDER BY b.borough_name, z.zone_name, z.location_id
        `).all();
        res.json(rows.map(row => ({
            ...row,
            id: Number(row.id),
            geometry: row.geometry ? JSON.parse(row.geometry) : null
        })));
    });

    app.get('/api/trips/summary', (req, res) => {
        const filters = buildFilters(db, req.query);
        const { sortBy, sortOrder } = parseSort(req.query);
        res.json({
            ...getSummary(db, filters),
            topZones: getTopZones(db, filters, sortBy, sortOrder)
        });
    });

    app.get('/api/trips/hourly', (req, res) => {
        res.json(getHourlyDistribution(db, buildFilters(db, req.query)));
    });

    app.get('/api/trips/revenue', (req, res) => {
        const filters = buildFilters(db, req.query);
        const rows = db.prepare(`
            SELECT b.borough_name AS borough, AVG(t.average_speed_mph) AS speed
            FROM trips t
            JOIN taxi_zones z ON z.location_id = t.pickup_location_id
            JOIN boroughs b USING (borough_id)
            WHERE ${filters.where}
            GROUP BY b.borough_id, b.borough_name
            ORDER BY b.borough_name
        `).all(...filters.params);
        res.json(Object.fromEntries(rows.map(row => [row.borough, round(row.speed, 1)])));
    });

    app.get('/api/trips/fare-distance', (req, res) => {
        res.json(getFareDistance(db, buildFilters(db, req.query)));
    });

    app.get('/api/trips/gaps', (req, res) => {
        res.json(getCoverageGaps(db, buildFilters(db, req.query, { includeScope: false })));
    });

    /**
     * Custom DSA endpoint: binary-heap Dijkstra on the zone mobility graph.
     * Query: from, to (required zone IDs); optional start_date, end_date, borough, min_trips.
     */
    app.get('/api/routes/optimal', (req, res) => {
        const fromRaw = scalarQueryValue(req.query.from, 'from');
        const toRaw = scalarQueryValue(req.query.to, 'to');
        if (fromRaw === undefined || toRaw === undefined) {
            throw new HttpError(400, 'from and to zone ids are required');
        }
        const fromZoneId = parsePositiveInt(fromRaw, 'from');
        const toZoneId = parsePositiveInt(toRaw, 'to');
        requireExistingZone(db, fromZoneId, 'from');
        requireExistingZone(db, toZoneId, 'to');

        const minTrips = parseNumber(
            scalarQueryValue(req.query.min_trips, 'min_trips'),
            'min_trips',
            1,
            1_000_000
        ) ?? 1;

        const filters = buildFilters(db, req.query, { includeScope: false });
        res.json(findOptimalCorridor(db, filters, fromZoneId, toZoneId, { minTrips }));
    });

    app.get('/api/zones/:zoneId/stats', (req, res) => {
        const zoneId = Number(req.params.zoneId);
        if (!Number.isSafeInteger(zoneId) || zoneId <= 0) {
            throw new HttpError(400, 'zone id must be a positive integer');
        }
        res.json(getZoneStats(db, zoneId, req.query));
    });

    app.get('/api/boroughs/:borough/stats', (req, res) => {
        res.json(getBoroughStats(db, req.params.borough, req.query));
    });

    app.get('/api/report', (req, res) => {
        const filters = buildFilters(db, req.query);
        const summary = getSummary(db, filters);
        const hourly = getHourlyDistribution(db, filters);
        const topZones = getTopZones(db, filters, 'volume', 'desc', 5);
        const coverageGaps = getCoverageGaps(
            db,
            buildFilters(db, req.query, { includeScope: false })
        );
        const busiestHour = Object.keys(hourly).reduce((best, hour) =>
            hourly[hour].trips > hourly[best].trips ? hour : best
        , '0');
        const peak = hourly[busiestHour];
        const congestionImpact = summary.avgSpeed
            ? round(((peak.speed - summary.avgSpeed) / summary.avgSpeed) * 100, 1)
            : null;
        const zoneStats = filters.zoneId
            ? getZoneStats(db, filters.zoneId, req.query)
            : null;
        const boroughMetadata = filters.borough
            ? getBoroughMetadata(db, filters.borough, filters)
            : null;
        const period = `${filters.startDate || 'All dates'} to ${filters.endDate || 'Present'}`;

        res.json({
            metadata: {
                scope: zoneStats ? 'Selected Taxi Zone' : (filters.borough || 'Citywide'),
                period,
                generatedAt: new Date().toISOString(),
                isZoneReport: Boolean(zoneStats),
                isCitywide: !filters.borough && !zoneStats,
                comparison: zoneStats ? {
                    zoneSpeed: zoneStats.avgSpeed,
                    boroughSpeed: zoneStats.boroughAvgSpeed,
                    diff: zoneStats.speedComparison
                } : null,
                boroughMetadata
            },
            summary: {
                totalTrips: summary.totalTrips,
                totalPassengers: summary.totalPassengers,
                totalRevenue: summary.totalRevenue,
                avgSpeed: summary.avgSpeed,
                avgDistance: summary.avgDistance,
                totalAnomalies: summary.totalAnomalies,
                systemHealth: summary.systemHealth,
                anomalyDetails: summary.anomalyDetails
            },
            topZones,
            rushHour: {
                hour: Number(busiestHour),
                trips: peak.trips,
                avgSpeed: peak.speed,
                congestionImpact,
                trend: hourly
            },
            coverageGaps: coverageGaps.map(gap => ({
                zone: gap.zone,
                borough: gap.borough,
                ratio: gap.coverageRatio
            }))
        });
    });

    app.use('/api', (_req, res) => {
        res.status(404).json({ error: 'API endpoint not found' });
    });
    app.use((err, _req, res, _next) => {
        if (err instanceof HttpError) {
            return res.status(err.status).json({ error: err.message });
        }
        console.error('API request failed:', err);
        return res.status(500).json({ error: 'Internal server error' });
    });
    return app;
}

module.exports = { createApp, dateToUtcBoundary };
