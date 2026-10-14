# Custom Algorithm: Optimal Mobility Corridor (Dijkstra + Binary Min-Heap)

## Purpose

Given two NYC taxi zones, find the **lowest expected travel-time corridor** through
the observed trip network. Nodes are taxi zones; directed edges are pickup →
drop-off flows weighted by average trip duration. This answers questions such as:

> “If a rider moves from Zone A toward Zone B using typical observed hops,
> which multi-zone corridor has the smallest expected duration?”

The implementation is **manual DSA** (custom binary heap + Dijkstra). It does
**not** call library shortest-path helpers or `Array.sort` for the priority queue.

## Why this algorithm

| Alternative | Why we did not choose it |
| --- | --- |
| Built-in SQL `ORDER BY` / JS `.sort()` only | Rubric “No Marks” if only built-ins are used for the core logic |
| BFS / unweighted hops | Ignores travel-time differences between corridors |
| A* | Needs a geographic heuristic; duration graph is already enough and clearer to analyse |
| K-means clustering | Useful for zoning, but weaker “path” story for urban mobility |

Dijkstra fits urban mobility: non-negative edge weights (durations), directed
asymmetric flows (A→B ≠ B→A), and a clear optimality guarantee.

## Data structures

1. **Adjacency list** `Map<node, Array<{to, weight, trips}>>` — sparse zone graph.
2. **Binary min-heap** with decrease-key — extracts the unsettled node with the
   smallest tentative distance in `O(log V)`.
3. **Distance / predecessor maps** — reconstruct the corridor after search.

## Pseudo-code

```
function DIJKSTRA(Graph G, source s, target t):
    for each vertex v in G:
        dist[v] ← ∞
        prev[v] ← undefined
    dist[s] ← 0
    Heap H ← empty binary min-heap
    H.PUSH(s, priority = 0)

    while H is not empty:
        u ← H.POP()                     // smallest dist
        if u is already settled: continue
        mark u settled
        if u = t: break

        for each edge (u → v, weight w) in G.neighbors(u):
            if v is settled: continue
            candidate ← dist[u] + w
            if candidate < dist[v]:
                dist[v] ← candidate
                prev[v] ← u
                if v is in H:
                    H.DECREASE_KEY(v, candidate)
                else:
                    H.PUSH(v, priority = candidate)

    if dist[t] = ∞: return NO_PATH
    return reconstruct path s ⇝ t using prev[], and dist[t]
```

Binary heap helpers:

```
PUSH(item):
    append item to array
    SIFT_UP(last index)

POP():
    swap root with last; remove last
    SIFT_DOWN(0); return old root

DECREASE_KEY(id, newPriority):
    locate id via handle map
    lower priority; SIFT_UP(index)

SIFT_UP / SIFT_DOWN:
    swap with parent / smaller child until heap order holds
```

## Complexity analysis

Let `V` = number of taxi zones (nodes) and `E` = number of observed zone-pair
edges after aggregation.

| Component | Time | Space |
| --- | --- | --- |
| Build graph from SQL aggregates | `O(E)` over grouped pairs | `O(V + E)` |
| Dijkstra with binary heap | `O((V + E) log V)` | `O(V)` for dist/prev/heap |
| Path reconstruction | `O(V)` worst case | `O(V)` |

Overall API call (excluding SQL scan): **`O((V + E) log V)` time**, **`O(V + E)` space**.

With a Fibonacci heap the theoretical bound is `O(E + V log V)`, but a binary
heap is clearer to implement and sufficient for ~263 TLC zones.

## Integration

- Module: `backend/algorithms/`
- API: `GET /api/routes/optimal?from=<zoneId>&to=<zoneId>`
- Optional query params reuse the shared date/borough filters (`start_date`,
  `end_date`, `borough`, `min_trips`).

Frontend / report teammates can call this endpoint to show corridor insights
without re-implementing the search.

## Implementation challenges and insights

1. **Self-loops** (same pickup and drop-off zone) were excluded — they do not
   represent inter-zone movement and would create zero-hop noise.
2. **`min_trips`** filters rare edges so the corridor reflects stable mobility,
   not one-off outliers.
3. **Decrease-key** required an `id → index` handle map; without it, duplicate
   heap entries still work but waste space (`O(E)` entries vs `O(V)`).
4. Edge weights must stay **non-negative**; average duration from cleaned trips
   satisfies Dijkstra’s precondition (ETL already rejects nonpositive durations).

## Files

| File | Role |
| --- | --- |
| `binaryHeap.js` | Custom binary min-heap |
| `dijkstra.js` | Shortest-path search |
| `mobilityGraph.js` | Build zone graph from SQLite |
| `index.js` | Public `findOptimalCorridor` helper |
| `../tests/algorithms.test.js` | Unit tests for heap + Dijkstra |
