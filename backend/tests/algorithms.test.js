const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BinaryMinHeap, dijkstra } = require('../algorithms');

test('binary min-heap pushes, peeks, pops, and decrease-keys in order', () => {
    const heap = new BinaryMinHeap();
    heap.push({ id: 'c', priority: 30 });
    heap.push({ id: 'a', priority: 10 });
    heap.push({ id: 'b', priority: 20 });

    assert.equal(heap.size, 3);
    assert.equal(heap.peek().id, 'a');
    assert.equal(heap.decreaseKey('c', 5), true);
    assert.equal(heap.pop().id, 'c');
    assert.equal(heap.pop().id, 'a');
    assert.equal(heap.pop().id, 'b');
    assert.equal(heap.pop(), null);
    assert.equal(heap.isEmpty(), true);
});

test('binary min-heap rejects duplicate ids and ignores non-decreasing keys', () => {
    const heap = new BinaryMinHeap();
    heap.push({ id: 1, priority: 4 });
    assert.throws(() => heap.push({ id: 1, priority: 1 }), /already contains/);
    assert.equal(heap.decreaseKey(1, 5), false);
    assert.equal(heap.decreaseKey(99, 1), false);
    assert.equal(heap.contains(1), true);
});

test('dijkstra finds the lowest-duration multi-hop corridor', () => {
    // Zones: 1 --10--> 2 --10--> 4
    //         \--50-------------> 4
    //         1 --5--> 3 --5--> 4
    const graph = new Map([
        [1, [{ to: 2, weight: 10 }, { to: 3, weight: 5 }, { to: 4, weight: 50 }]],
        [2, [{ to: 4, weight: 10 }]],
        [3, [{ to: 4, weight: 5 }]],
        [4, []]
    ]);

    const result = dijkstra(graph, 1, 4);
    assert.equal(result.found, true);
    assert.equal(result.distance, 10);
    assert.deepEqual(result.path, [1, 3, 4]);
    assert.equal(result.hops, 2);
    assert.ok(result.visitedNodes >= 2);
});

test('dijkstra reports no path and handles identical endpoints', () => {
    const graph = new Map([
        [1, [{ to: 2, weight: 3 }]],
        [2, []],
        [3, []]
    ]);

    assert.deepEqual(dijkstra(graph, 1, 3).found, false);
    assert.deepEqual(dijkstra(graph, 1, 1), {
        found: true,
        distance: 0,
        path: [1],
        hops: 0,
        visitedNodes: 1
    });
    assert.equal(dijkstra(graph, 9, 1).found, false);
});
