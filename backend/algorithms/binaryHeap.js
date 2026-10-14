/**
 * Binary min-heap with decrease-key support via a handle map.
 * Implemented from scratch (no library priority queue).
 */
class BinaryMinHeap {
    constructor(compare = (a, b) => a.priority - b.priority) {
        this._items = [];
        this._indexById = new Map();
        this._compare = compare;
    }

    get size() {
        return this._items.length;
    }

    isEmpty() {
        return this._items.length === 0;
    }

    peek() {
        return this._items[0] || null;
    }

    /**
     * Insert a node. Each item must have a unique `id` and a numeric `priority`.
     */
    push(item) {
        if (this._indexById.has(item.id)) {
            throw new Error(`Heap already contains id ${item.id}`);
        }
        this._items.push(item);
        this._indexById.set(item.id, this._items.length - 1);
        this._siftUp(this._items.length - 1);
    }

    pop() {
        if (this._items.length === 0) return null;
        const root = this._items[0];
        const last = this._items.pop();
        this._indexById.delete(root.id);
        if (this._items.length > 0) {
            this._items[0] = last;
            this._indexById.set(last.id, 0);
            this._siftDown(0);
        }
        return root;
    }

    /**
     * Lower the priority of an existing node (Dijkstra decrease-key).
     * Returns true if the key was decreased.
     */
    decreaseKey(id, newPriority) {
        const index = this._indexById.get(id);
        if (index === undefined) return false;
        const item = this._items[index];
        if (newPriority >= item.priority) return false;
        item.priority = newPriority;
        this._siftUp(index);
        return true;
    }

    contains(id) {
        return this._indexById.has(id);
    }

    _siftUp(index) {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this._compare(this._items[index], this._items[parent]) >= 0) break;
            this._swap(index, parent);
            index = parent;
        }
    }

    _siftDown(index) {
        const length = this._items.length;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;
            if (left < length && this._compare(this._items[left], this._items[smallest]) < 0) {
                smallest = left;
            }
            if (right < length && this._compare(this._items[right], this._items[smallest]) < 0) {
                smallest = right;
            }
            if (smallest === index) break;
            this._swap(index, smallest);
            index = smallest;
        }
    }

    _swap(i, j) {
        const a = this._items[i];
        const b = this._items[j];
        this._items[i] = b;
        this._items[j] = a;
        this._indexById.set(a.id, j);
        this._indexById.set(b.id, i);
    }
}

module.exports = { BinaryMinHeap };
