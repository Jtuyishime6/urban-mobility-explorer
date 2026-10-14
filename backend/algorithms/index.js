const { BinaryMinHeap } = require('./binaryHeap');
const { dijkstra } = require('./dijkstra');
const { buildMobilityGraph, describePath } = require('./mobilityGraph');

/**
 * Find the lowest expected-travel-time corridor between two taxi zones
 * using a custom binary-heap Dijkstra implementation.
 */
function findOptimalCorridor(db, filters, fromZoneId, toZoneId, options = {}) {
    const minTrips = options.minTrips ?? 1;
    const { graph, zoneMeta, stats } = buildMobilityGraph(db, filters, { minTrips });
    const result = dijkstra(graph, fromZoneId, toZoneId);
    const description = describePath(result.path, graph, zoneMeta);

    return {
        algorithm: 'dijkstra',
        dataStructure: 'binary_min_heap',
        from: zoneMeta.get(fromZoneId) || { id: fromZoneId },
        to: zoneMeta.get(toZoneId) || { id: toZoneId },
        found: result.found,
        totalDurationSeconds: result.found ? Number(result.distance.toFixed(1)) : null,
        totalDurationMinutes: result.found ? Number((result.distance / 60).toFixed(2)) : null,
        hops: result.hops,
        visitedNodes: result.visitedNodes,
        path: description.zones,
        segments: description.hops,
        graphStats: stats,
        complexity: {
            time: 'O((V + E) log V)',
            space: 'O(V + E)',
            notes: 'V = taxi zones, E = observed zone-to-zone trip edges'
        }
    };
}

module.exports = {
    BinaryMinHeap,
    dijkstra,
    buildMobilityGraph,
    describePath,
    findOptimalCorridor
};
