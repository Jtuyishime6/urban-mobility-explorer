const { BinaryMinHeap } = require('./binaryHeap');

/**
 * Dijkstra's shortest-path on a weighted directed adjacency list.
 *
 * @param {Map<number, Array<{to: number, weight: number, trips?: number}>>} graph
 * @param {number} source
 * @param {number} target
 * @returns {{
 *   found: boolean,
 *   distance: number | null,
 *   path: number[],
 *   hops: number,
 *   visitedNodes: number
 * }}
 */
function dijkstra(graph, source, target) {
    if (!graph.has(source) || !graph.has(target)) {
        return { found: false, distance: null, path: [], hops: 0, visitedNodes: 0 };
    }
    if (source === target) {
        return { found: true, distance: 0, path: [source], hops: 0, visitedNodes: 1 };
    }

    const dist = new Map();
    const prev = new Map();
    const visited = new Set();
    const heap = new BinaryMinHeap();

    for (const node of graph.keys()) {
        dist.set(node, Number.POSITIVE_INFINITY);
    }
    dist.set(source, 0);
    heap.push({ id: source, priority: 0 });

    let visitedNodes = 0;

    while (!heap.isEmpty()) {
        const current = heap.pop();
        const u = current.id;
        if (visited.has(u)) continue;
        visited.add(u);
        visitedNodes += 1;

        if (u === target) break;

        const neighbors = graph.get(u) || [];
        for (const edge of neighbors) {
            const v = edge.to;
            if (visited.has(v)) continue;
            const candidate = dist.get(u) + edge.weight;
            if (candidate < dist.get(v)) {
                dist.set(v, candidate);
                prev.set(v, u);
                if (heap.contains(v)) {
                    heap.decreaseKey(v, candidate);
                } else {
                    heap.push({ id: v, priority: candidate });
                }
            }
        }
    }

    const best = dist.get(target);
    if (!Number.isFinite(best)) {
        return { found: false, distance: null, path: [], hops: 0, visitedNodes };
    }

    const path = [];
    let node = target;
    while (node !== undefined) {
        path.push(node);
        if (node === source) break;
        node = prev.get(node);
    }
    path.reverse();

    return {
        found: true,
        distance: best,
        path,
        hops: path.length - 1,
        visitedNodes
    };
}

module.exports = { dijkstra };
