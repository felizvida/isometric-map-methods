// Walking and driving networks from mapped lines: weld polylines into a directed graph, route with A*, keep only the
// strongly connected core, offset walking onto the pavement beside a road, and prune links a body could not walk.

/**
 * lines: [{pts: [[x, y], ...], kind, width?, oneway?}]. Nodes are welded by rounding coordinates to `weld` metres.
 * Each segment becomes two directed edges, or one when the line is one-way.
 * Returns {nodes: [{x, y, out: [edgeIndex]}], edges: [{a, b, len, kind, width}]}.
 */
export function buildGraph(lines, {weld = 0.1} = {}) {
  const nodes = [], edges = [], index = new Map();
  const node = ([x, y]) => {
    const key = Math.round(x / weld) + ',' + Math.round(y / weld);
    if (!index.has(key)) { index.set(key, nodes.length); nodes.push({x, y, out: []}); }
    return index.get(key);
  };
  const addEdge = (a, b, line) => {
    if (a === b) return;
    const len = Math.hypot(nodes[b].x - nodes[a].x, nodes[b].y - nodes[a].y);
    nodes[a].out.push(edges.length);
    edges.push({a, b, len, kind: line.kind, width: line.width ?? null});
  };
  for (const line of lines) {
    for (let k = 0; k < line.pts.length - 1; k++) {
      const a = node(line.pts[k]), b = node(line.pts[k + 1]);
      addEdge(a, b, line);
      if (!line.oneway) addEdge(b, a, line);
    }
  }
  return {nodes, edges};
}

/** Binary min-heap of [priority, value]. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(p, v) {
    const a = this.a; a.push([p, v]);
    for (let i = a.length - 1; i > 0;) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

/**
 * A* from node `from` to node `to` with a straight-line heuristic. cost(edge) defaults to its length; any multiplier
 * must be >= 1 for the heuristic to stay admissible (for example 1.6 for walking along a main road, 1.2 for links).
 * Returns {nodes: [...], edges: [...], cost} or null.
 */
export function aStar(graph, from, to, cost = (e) => e.len, {usable = () => true, guard = 200000} = {}) {
  const {nodes, edges} = graph, goal = nodes[to];
  const h = (n) => Math.hypot(nodes[n].x - goal.x, nodes[n].y - goal.y);
  const g = new Map([[from, 0]]), prev = new Map(), heap = new Heap(), done = new Set();
  heap.push(h(from), from);
  let steps = 0;
  while (heap.size && steps++ < guard) {
    const [, n] = heap.pop();
    if (done.has(n)) continue;
    if (n === to) {
      const path = [], used = [];
      for (let m = to; m !== from; m = edges[prev.get(m)].a) { used.push(prev.get(m)); path.push(m); }
      path.push(from);
      return {nodes: path.reverse(), edges: used.reverse(), cost: g.get(to)};
    }
    done.add(n);
    for (const ei of nodes[n].out) {
      const e = edges[ei];
      if (!usable(e, ei)) continue;
      const c = g.get(n) + cost(e);
      if (c < (g.get(e.b) ?? Infinity)) { g.set(e.b, c); prev.set(e.b, ei); heap.push(c + h(e.b), e.b); }
    }
  }
  return null;
}

/**
 * The walkable core: the largest weakly connected component, then the nodes both reachable from and able to reach its
 * busiest node. Spawning, entry points and routing should use only these nodes. Returns a Uint8Array mask.
 */
export function mainNetwork(graph) {
  const {nodes, edges} = graph, n = nodes.length;
  const undirected = Array.from({length: n}, () => []), incoming = Array.from({length: n}, () => []);
  for (const e of edges) { undirected[e.a].push(e.b); undirected[e.b].push(e.a); incoming[e.b].push(e.a); }
  const comp = new Int32Array(n).fill(-1), sizes = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const id = sizes.length, stack = [s];
    comp[s] = id; let size = 0;
    while (stack.length) { const m = stack.pop(); size++; for (const k of undirected[m]) if (comp[k] < 0) { comp[k] = id; stack.push(k); } }
    sizes.push(size);
  }
  const mask = new Uint8Array(n);
  if (!n) return mask;
  const big = sizes.reduce((b, s, k) => (s > sizes[b] ? k : b), 0);
  let seed = -1;
  for (let k = 0; k < n; k++) if (comp[k] === big && (seed < 0 || nodes[k].out.length > nodes[seed].out.length)) seed = k;
  const reach = (next) => {
    const seen = new Uint8Array(n), stack = [seed];
    seen[seed] = 1;
    while (stack.length) { const m = stack.pop(); for (const k of next(m)) if (!seen[k]) { seen[k] = 1; stack.push(k); } }
    return seen;
  };
  const fwd = reach((m) => nodes[m].out.map((ei) => edges[ei].b)), back = reach((m) => incoming[m]);
  for (let k = 0; k < n; k++) mask[k] = fwd[k] && back[k] ? 1 : 0;
  return mask;
}

/** An edge along a road walked on its right-hand pavement: offset by width/2 + 0.9 m. Returns [[x, y], [x, y]]. */
export function pavementLine(graph, e, defaultWidth = 6) {
  const a = graph.nodes[e.a], b = graph.nodes[e.b], L = e.len || 1;
  const off = (e.width ?? defaultWidth) / 2 + 0.9, nx = (b.y - a.y) / L, ny = -(b.x - a.x) / L;
  return [[a.x + nx * off, a.y + ny * off], [b.x + nx * off, b.y + ny * off]];
}

/**
 * Remove edges a body could not walk: `blocked(edge, index)` returns a reason string or null. Edges are removed in
 * place (order kept) and nodes' out-lists remapped, so routing can never disagree with the collision engine.
 * Returns {graph, dropped: [{edge, reason}]}.
 */
export function pruneGraph(graph, blocked) {
  const keep = [], dropped = [], remap = new Int32Array(graph.edges.length).fill(-1);
  graph.edges.forEach((e, i) => {
    const why = blocked(e, i);
    if (why) dropped.push({edge: e, reason: why});
    else { remap[i] = keep.length; keep.push(e); }
  });
  const nodes = graph.nodes.map((n) => ({...n, out: n.out.map((i) => remap[i]).filter((i) => i >= 0)}));
  return {graph: {nodes, edges: keep}, dropped};
}

/** Nearest node (optionally restricted by a mask) to a point, by linear scan. */
export function nearestNode(graph, x, y, mask = null) {
  let best = -1, bd = Infinity;
  graph.nodes.forEach((n, k) => {
    if (mask && !mask[k]) return;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) { bd = d; best = k; }
  });
  return best;
}
