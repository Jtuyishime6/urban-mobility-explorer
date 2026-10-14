/**
 * Build a directed zone-to-zone mobility graph from cleaned trip aggregates.
 *
 * Nodes  = taxi zone location IDs
 * Edges  = observed pickup → drop-off flows
 * Weight = average trip duration in seconds (lower = faster typical travel)
 */

function buildMobilityGraph(db, filters, { minTrips = 1 } = {}) {
    const zoneRows = db.prepare(`
        SELECT z.location_id AS id, z.zone_name AS zone, b.borough_name AS borough
        FROM taxi_zones z
        JOIN boroughs b USING (borough_id)
        ORDER BY z.location_id
    `).all();

    const zoneMeta = new Map(zoneRows.map(row => [Number(row.id), {
        id: Number(row.id),
        zone: row.zone,
        borough: row.borough
    }]));

    const graph = new Map();
    for (const id of zoneMeta.keys()) {
        graph.set(id, []);
    }

    const edgeRows = db.prepare(`
        SELECT
            t.pickup_location_id AS source,
            t.dropoff_location_id AS target,
            COUNT(*) AS trips,
            AVG(t.duration_seconds) AS avgDuration,
            AVG(t.trip_distance) AS avgDistance,
            AVG(t.average_speed_mph) AS avgSpeed
        FROM trips t
        WHERE ${filters.where}
            AND t.pickup_location_id != t.dropoff_location_id
        GROUP BY t.pickup_location_id, t.dropoff_location_id
        HAVING COUNT(*) >= ?
    `).all(...filters.params, minTrips);

    const edges = [];
    for (const row of edgeRows) {
        const source = Number(row.source);
        const target = Number(row.target);
        const weight = Number(row.avgDuration);
        if (!graph.has(source) || !graph.has(target) || !(weight > 0)) continue;
        const edge = {
            to: target,
            weight,
            trips: Number(row.trips),
            avgDistance: Number(row.avgDistance),
            avgSpeed: Number(row.avgSpeed)
        };
        graph.get(source).push(edge);
        edges.push({
            from: source,
            to: target,
            weight,
            trips: edge.trips,
            avgDistance: edge.avgDistance,
            avgSpeed: edge.avgSpeed
        });
    }

    return {
        graph,
        zoneMeta,
        stats: {
            nodeCount: graph.size,
            edgeCount: edges.length,
            minTrips
        }
    };
}

/**
 * Expand a path of zone IDs into labeled hops with edge metrics.
 */
function describePath(path, graph, zoneMeta) {
    const zones = path.map(id => zoneMeta.get(id) || { id, zone: `Zone ${id}`, borough: null });
    const hops = [];
    for (let i = 0; i < path.length - 1; i += 1) {
        const from = path[i];
        const to = path[i + 1];
        const edge = (graph.get(from) || []).find(candidate => candidate.to === to);
        hops.push({
            from,
            to,
            fromZone: zoneMeta.get(from)?.zone || `Zone ${from}`,
            toZone: zoneMeta.get(to)?.zone || `Zone ${to}`,
            avgDurationSeconds: edge ? Number(edge.weight.toFixed(1)) : null,
            trips: edge ? edge.trips : null,
            avgDistance: edge ? Number(edge.avgDistance.toFixed(2)) : null,
            avgSpeed: edge ? Number(edge.avgSpeed.toFixed(1)) : null
        });
    }
    return { zones, hops };
}

module.exports = { buildMobilityGraph, describePath };
