// Walls as zero-thickness line segments: a spatial hash, continuous ("swept") movement that can never cross a wall,
// push-out for bodies with a radius, openings cut into fence lines at gates, and walls sliced from a drawn mesh.
// Plain 2D metres; no dependencies.

/** Spatial hash of segments {ax, ay, bx, by, ...}. A segment is filed in every cell its padded band touches. */
export class SegmentHash {
  constructor(cell = 8) {
    this.cell = cell;
    this.cells = new Map();
    this.segments = [];
    this.stamp = 0;
    this.seen = [];
  }

  key(i, j) { return (i + 32768) * 65536 + (j + 32768); }

  add(seg, pad = 0.5) {
    const id = this.segments.length, c = this.cell;
    this.segments.push(seg);
    this.seen.push(0);
    const i0 = Math.floor((Math.min(seg.ax, seg.bx) - pad) / c), i1 = Math.floor((Math.max(seg.ax, seg.bx) + pad) / c);
    const j0 = Math.floor((Math.min(seg.ay, seg.by) - pad) / c), j1 = Math.floor((Math.max(seg.ay, seg.by) + pad) / c);
    const reach = c * 0.7072 + pad;                                   // half a cell diagonal plus the pad
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      if (pointSegmentDistance((i + 0.5) * c, (j + 0.5) * c, seg) > reach) continue;
      const k = this.key(i, j);
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k).push(id);
    }
    return id;
  }

  /** Segments filed in the cells within `r` of (x, y), each once. */
  near(x, y, r) {
    const c = this.cell, out = [], stamp = ++this.stamp;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
        for (const id of this.cells.get(this.key(i, j)) || []) {
          if (this.seen[id] === stamp) continue;
          this.seen[id] = stamp;
          out.push(this.segments[id]);
        }
      }
    }
    return out;
  }
}

export function pointSegmentDistance(x, y, s) {
  const dx = s.bx - s.ax, dy = s.by - s.ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / L2)) : 0;
  return Math.hypot(x - s.ax - t * dx, y - s.ay - t * dy);
}

/**
 * Where the move p -> q crosses segment s: the fraction t along the move, or null. A crossing counts for t in
 * (1e-9, 1] and for u in [-1e-7, 1 + 1e-7] along the wall: the small tolerance stops a move slipping through the joint
 * between two wall segments, and a move that starts exactly on a wall may leave it.
 */
export function crossing(p, q, s) {
  const rx = q[0] - p[0], ry = q[1] - p[1], sx = s.bx - s.ax, sy = s.by - s.ay;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;                           // parallel
  const wx = s.ax - p[0], wy = s.ay - p[1];
  const t = (wx * sy - wy * sx) / den, u = (wx * ry - wy * rx) / den;
  return t > 1e-9 && t <= 1 && u >= -1e-7 && u <= 1 + 1e-7 ? t : null;
}

function firstHit(hash, p, q) {
  const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
  let best = null;
  for (const s of hash.near((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, L / 2 + 0.5)) {
    const t = crossing(p, q, s);
    if (t !== null && (!best || t < best.t)) best = {t, s};
  }
  return best;
}

/**
 * Continuous movement from p towards q that never crosses a wall: stop 1 cm before the first wall crossed, then slide
 * the rest of the move along that wall, and sweep the slide too. Returns {x, y, hit}.
 */
export function sweep(hash, p, q, skin = 0.01) {
  const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (L === 0) return {x: p[0], y: p[1], hit: null};
  const hit = firstHit(hash, p, q);
  if (!hit) return {x: q[0], y: q[1], hit: null};
  const tb = Math.max(0, hit.t - skin / L);
  const stop = [p[0] + (q[0] - p[0]) * tb, p[1] + (q[1] - p[1]) * tb];
  const wl = Math.hypot(hit.s.bx - hit.s.ax, hit.s.by - hit.s.ay) || 1;
  const ux = (hit.s.bx - hit.s.ax) / wl, uy = (hit.s.by - hit.s.ay) / wl;
  const along = ((q[0] - p[0]) * ux + (q[1] - p[1]) * uy) * (1 - tb);
  const slideTo = [stop[0] + ux * along, stop[1] + uy * along];
  const second = firstHit(hash, stop, slideTo);
  if (!second) return {x: slideTo[0], y: slideTo[1], hit: hit.s};
  const sl = Math.hypot(slideTo[0] - stop[0], slideTo[1] - stop[1]);
  const t2 = Math.max(0, second.t - skin / sl);
  return {x: stop[0] + (slideTo[0] - stop[0]) * t2, y: stop[1] + (slideTo[1] - stop[1]) * t2, hit: hit.s};
}

/** Push a disc of radius r at p out of every wall closer than r (along the wall normal). Returns [x, y]. */
export function pushOut(hash, p, r) {
  let [x, y] = p;
  for (const s of hash.near(x, y, r + 0.5)) {
    const dx = s.bx - s.ax, dy = s.by - s.ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / L2)) : 0;
    const cx = s.ax + t * dx, cy = s.ay + t * dy, d = Math.hypot(x - cx, y - cy);
    if (d >= r || d === 0) continue;
    x = cx + (x - cx) / d * r;
    y = cy + (y - cy) / d * r;
  }
  return [x, y];
}

/**
 * Half-width of the gap cut in a fence at an opening node (gate, entrance, bollard...): a tagged width wins; otherwise
 * the road through it plus 1.6 m each side; otherwise 0.9 m (a 1.8 m gate). A road crossing at an angle widens the
 * cut: divided by max(0.35, |sin angle|) when the width was not tagged.
 */
export function openingHalfWidth({width = null, roadWidth = null, angle = Math.PI / 2} = {}) {
  if (Number.isFinite(width) && width > 0) return width / 2;
  if (Number.isFinite(roadWidth) && roadWidth > 0) return (roadWidth / 2 + 1.6) / Math.max(0.35, Math.abs(Math.sin(angle)));
  return 0.9;
}

/**
 * Cut gaps into a polyline at arc-length positions: openings = [{s, halfWidth}]. Overlapping cuts merge; pieces
 * shorter than `minPiece` are dropped. Returns a list of polylines.
 */
export function cutOpenings(line, openings, minPiece = 0.2) {
  const cum = [0];
  for (let k = 1; k < line.length; k++) cum.push(cum[k - 1] + Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]));
  const total = cum[cum.length - 1];
  const cuts = openings.map((o) => [Math.max(0, o.s - o.halfWidth), Math.min(total, o.s + o.halfWidth)]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const c of cuts) {
    if (merged.length && c[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], c[1]);
    else merged.push([...c]);
  }
  const keep = [];
  let from = 0;
  for (const [a, b] of merged) { keep.push([from, a]); from = b; }
  keep.push([from, total]);
  const at = (s) => {
    let k = 1;
    while (k < cum.length - 1 && cum[k] < s) k++;
    const f = (s - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
    return [line[k - 1][0] + (line[k][0] - line[k - 1][0]) * f, line[k - 1][1] + (line[k][1] - line[k - 1][1]) * f];
  };
  const out = [];
  for (const [a, b] of keep) {
    if (b - a < minPiece) continue;
    const piece = [at(a)];
    for (let k = 1; k < line.length - 1; k++) if (cum[k] > a && cum[k] < b) piece.push(line[k]);
    piece.push(at(b));
    out.push(piece);
  }
  return out;
}

/**
 * Walls from the drawn building mesh, like a plan section: every steep triangle (|nz| <= 0.9) is cut by a horizontal
 * plane 1.0 m above the ground just outside it (sampled 0.4 m out along its horizontal normal), or at 1.8 m if it does
 * not reach 1.0 m. Columns and colonnades therefore leave real gaps; a solid wall gives a continuous line.
 * triangles: [[[x,y,z],[x,y,z],[x,y,z]], ...]; groundAt(x, y) -> z. Returns segments {ax, ay, bx, by}.
 */
export function sliceWalls(triangles, groundAt, heights = [1.0, 1.8]) {
  const out = [];
  for (const t of triangles) {
    const u = t[1].map((v, k) => v - t[0][k]), w = t[2].map((v, k) => v - t[0][k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const nl = Math.hypot(...n);
    if (!nl || Math.abs(n[2] / nl) > 0.9) continue;
    const hl = Math.hypot(n[0], n[1]);
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
    const g = groundAt(cx + n[0] / hl * 0.4, cy + n[1] / hl * 0.4);
    for (const h of heights) {
      const z = g + h, pts = [];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3];
        if ((a[2] - z) * (b[2] - z) < 0) {
          const f = (z - a[2]) / (b[2] - a[2]);
          pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        }
      }
      if (pts.length === 2) { out.push({ax: pts[0][0], ay: pts[0][1], bx: pts[1][0], by: pts[1][1]}); break; }
    }
  }
  return out;
}

/** Ring (closed polygon) -> wall segments. */
export function ringSegments(ring, extra = {}) {
  const out = [];
  for (let k = 0; k < ring.length - 1; k++) out.push({ax: ring[k][0], ay: ring[k][1], bx: ring[k + 1][0], by: ring[k + 1][1], ...extra});
  return out;
}
