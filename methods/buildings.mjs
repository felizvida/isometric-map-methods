// Buildings from footprints: an oriented bounding box, a documented height-source priority, seating on sloping
// ground, roof forms built on the box, and facade bay layout. Units are metres; rings are closed ([first] repeated last)
// and counter-clockwise. No dependencies.

export function ringArea(ring) {
  let s = 0;
  for (let k = 0; k < ring.length - 1; k++) s += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
  return s / 2;
}

/**
 * Minimum-area oriented rectangle: try each edge direction of the ring, keep the smallest box. Returns the centre,
 * the long axis unit vector u, half-lengths hu >= hv, the angle of u in radians, and fill = footprint area / box area.
 */
export function orientedBox(ring) {
  const pts = ring.slice(0, -1);
  let best = null;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of pts) {
      const u = x * ux + y * uy, v = -x * uy + y * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area - 1e-9) best = {area, ux, uy, u0, u1, v0, v1};
  }
  let {ux, uy, u0, u1, v0, v1} = best;
  if (v1 - v0 > u1 - u0) { [ux, uy] = [-uy, ux]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }   // u = long axis
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return {cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, ux, uy, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2,
          angle: Math.atan2(uy, ux), fill: Math.abs(ringArea(ring)) / best.area};
}

/** Pitched-roof height from the box's short side: clamp(0.32 x short side, 1.2, 4.5 for houses or 7). */
export function pitchedRoofHeight(shortSide, residential = false) {
  return Math.min(Math.max(0.32 * shortSide, 1.2), residential ? 4.5 : 7);
}

/** A pitched roof needs a nearly rectangular footprint: box fill > 0.72 (> 0.6 for pyramidal or dome roofs). */
export function canPitch(box, shape) {
  return box.fill > (shape === 'pyramidal' || shape === 'dome' ? 0.6 : 0.72);
}

/**
 * Height by source priority; the first rule that applies wins, and the result says which.
 *  1. a curated value (hand-checked against survey data);
 *  2. a mapped height tag;
 *  3. a matched structures-dataset height, if the match covers >= 60 % of the footprint, the areas agree within
 *     0.55-1.8x and the height is in [2.5, 150) m; for a pitched roof the wall is max(2.8, h - 0.4 roof);
 *  4. levels x storey height + roof (+0.6 m parapet on flat roofs), with a default level count.
 */
export function chooseHeight({curated = null, tagged = null, match = null, levels = null, storey = 3.5,
                              roofShape = 'flat', roofHeight = 0, defaultLevels = 2} = {}) {
  if (Number.isFinite(curated)) return {height: curated, source: 'curated'};
  if (Number.isFinite(tagged)) return {height: tagged, source: 'tag'};
  if (match && match.coverage >= 0.6 && match.areaRatio >= 0.55 && match.areaRatio <= 1.8 &&
      match.height >= 2.5 && match.height < 150) {
    if (roofShape === 'flat') return {height: Math.max(3, match.height), source: 'structures'};
    const wall = Math.max(2.8, match.height - 0.4 * roofHeight);
    return {height: wall + roofHeight, source: 'structures'};
  }
  const n = Number.isFinite(levels) && levels > 0 ? levels : defaultLevels;
  return {height: n * storey + roofHeight + (roofShape === 'flat' ? 0.6 : 0), source: Number.isFinite(levels) ? 'levels' : 'default'};
}

export function percentile(values, p) {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.round(p / 100 * (v.length - 1))))];
}

/**
 * Seat a building on sloping ground from ground heights sampled along its walls (every 3 m is enough): the pad (floor
 * of the roof's height) is the 90th percentile so it is not buried uphill, the walls reach the lowest sample so it
 * does not float downhill. If the drop exceeds max(4, 0.75 x height) the building should follow the ground in pieces
 * instead (drape). Raised structures (canopies, decks) use the median.
 */
export function seat(wallGround, height, {raised = false, exaggeration = 1} = {}) {
  const pad = raised ? percentile(wallGround, 50) : percentile(wallGround, 90), low = wallGround.reduce((m, v) => (v < m ? v : m), Infinity);
  return {pad, base: low, drape: (pad - low) * exaggeration > Math.max(4, 0.75 * height),
          foundation: Math.min(45, (pad - low) * exaggeration + 0.6)};
}

/**
 * Roof triangles on an oriented box between eaves height z0 and ridge height z1. shape: flat | gabled | hipped |
 * pyramidal | skillion | barrel. overhang widens the roof beyond the walls. Ridge runs along the long axis.
 * Returns [[[x,y,z] x3], ...] wound counter-clockwise seen from above (normals point up and out).
 */
export function roofTriangles(box, z0, z1, shape = 'gabled', {overhang = 0.35, segments = 12} = {}) {
  const hu = box.hu + overhang, hv = box.hv + overhang;
  const P = (u, v, z) => [box.cx + u * box.ux - v * box.uy, box.cy + u * box.uy + v * box.ux, z];
  const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
  const tris = [];
  if (shape === 'flat') {
    tris.push(...quad(P(-hu, -hv, z1), P(hu, -hv, z1), P(hu, hv, z1), P(-hu, hv, z1)));
  } else if (shape === 'gabled') {
    tris.push(...quad(P(-hu, -hv, z0), P(hu, -hv, z0), P(hu, 0, z1), P(-hu, 0, z1)));
    tris.push(...quad(P(hu, hv, z0), P(-hu, hv, z0), P(-hu, 0, z1), P(hu, 0, z1)));
  } else if (shape === 'hipped' || shape === 'pyramidal') {
    const inset = shape === 'pyramidal' ? hu : Math.min(hv, hu);      // hip run equals half the span
    const r0 = P(-hu + inset, 0, z1), r1 = P(hu - inset, 0, z1);
    const c = [P(-hu, -hv, z0), P(hu, -hv, z0), P(hu, hv, z0), P(-hu, hv, z0)];
    tris.push(...quad(c[0], c[1], r1, r0), [c[1], c[2], r1], ...quad(c[2], c[3], r0, r1), [c[3], c[0], r0]);
  } else if (shape === 'skillion') {
    tris.push(...quad(P(-hu, -hv, z0), P(hu, -hv, z0), P(hu, hv, z1), P(-hu, hv, z1)));
  } else if (shape === 'barrel') {
    // segmental arc across the short axis: radius R = (half^2 + rise^2) / (2 rise)
    const rise = z1 - z0, R = (hv * hv + rise * rise) / (2 * rise), phi = Math.asin(Math.min(1, hv / R));
    const n = Math.max(6, Math.min(20, segments));
    const arc = Array.from({length: n + 1}, (_, k) => {
      const a = -phi + 2 * phi * k / n;
      return [R * Math.sin(a), z0 + R * Math.cos(a) - R * Math.cos(phi)];
    });
    for (let k = 0; k < n; k++) tris.push(...quad(P(-hu, arc[k][0], arc[k][1]), P(hu, arc[k][0], arc[k][1]),
                                                  P(hu, arc[k + 1][0], arc[k + 1][1]), P(-hu, arc[k + 1][0], arc[k + 1][1])));
  } else {
    throw new RangeError('unknown roof shape ' + shape);
  }
  return tris;
}

/**
 * Wall quads for a ring between base and top, each tagged with the edge index and a kind: 'blank' for edges shorter
 * than 2 m (too short for a window bay) and 'windows' otherwise. A renderer may promote one edge to 'entrance'.
 */
export function wallQuads(ring, base, top) {
  const out = [];
  for (let k = 0; k < ring.length - 1; k++) {
    const [ax, ay] = ring[k], [bx, by] = ring[k + 1], len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    out.push({edge: k, len, kind: len < 2 ? 'blank' : 'windows', normal: [(by - ay) / len, -(bx - ax) / len],
              corners: [[ax, ay, base], [bx, by, base], [bx, by, top], [ax, ay, top]]});
  }
  return out;
}

/**
 * Facade window styles: bay spacing sp (m) and the window's box as fractions of bay width (x0-x1) and storey height
 * (y0-y1). Storey height is never taken below 2.5 m.
 */
export const WINDOW_STYLES = {
  punched: {sp: 3.2, x: [0.26, 0.74], y: [0.30, 0.80]}, ribbon: {sp: 1.6, x: [0, 1], y: [0.36, 0.80]},
  curtain: {sp: 1.5, x: [0, 1], y: [0.06, 0.94]}, historic: {sp: 3.0, x: [0.34, 0.66], y: [0.26, 0.84]},
  institutional: {sp: 2.8, x: [0.17, 0.83], y: [0.32, 0.80]}, house: {sp: 3.6, x: [0.32, 0.68], y: [0.36, 0.80]},
  apartment: {sp: 3.2, x: [0.22, 0.78], y: [0.30, 0.82]}, parking: {sp: 7.5, x: [0.05, 0.95], y: [0.30, 0.86]},
  industrial: {sp: 6.0, x: [0.20, 0.80], y: [0.72, 0.86]}, church: {sp: 4.0, x: [0.40, 0.60], y: [0.16, 0.86]},
  slot: {sp: 2.4, x: [0.44, 0.56], y: [0.15, 0.85]}, frame: {sp: 6.1, x: [0.07, 0.93], y: [0.24, 0.93]},
  deep: {sp: 6.5, x: [0.11, 0.89], y: [0.36, 0.86]}, piers: {sp: 2.1, x: [0.36, 0.64], y: [0.03, 0.99]},
  banded: {sp: 7.0, x: [0.08, 0.60], y: [0.30, 0.80]}, recess: {sp: 4.4, x: [0.18, 0.82], y: [0.18, 0.72]},
  sparse: {sp: 4.9, x: [0.37, 0.63], y: [0.30, 0.75]}, fins: {sp: 0.9, x: [0.30, 1], y: [0.16, 0.93]},
};

/**
 * Bay layout along one wall: corner piers (0 for curtain wall, 0.95 m historic, 0.45 m house, 0.7 m otherwise, at most
 * 0.2 x length), then ncol = max(1, round(inner / sp)) equal bays. Returns {pier, columns, bay, storey, storeys,
 * windows: [{u0, u1, z0, z1}]} for a wall of height `height` (windows stop 0.5 m under the top).
 */
export function bayLayout(length, height, style = 'punched', storeyHeight = 3.5, {bay = null} = {}) {
  const s = WINDOW_STYLES[style];
  if (!s) throw new RangeError('unknown window style ' + style);
  const sp = bay || s.sp;
  const pierBase = style === 'curtain' ? 0 : style === 'historic' ? 0.95 : style === 'house' ? 0.45 : 0.7;
  const pier = Math.min(pierBase, 0.2 * length), inner = length - 2 * pier;
  const columns = Math.max(1, Math.round(inner / sp)), cw = inner / columns, storey = Math.max(2.5, storeyHeight);
  const storeys = Math.max(0, Math.floor((height - 0.5) / storey)), windows = [];
  if (length >= 2) for (let f = 0; f < storeys; f++) for (let c = 0; c < columns; c++) {
    windows.push({u0: pier + (c + s.x[0]) * cw, u1: pier + (c + s.x[1]) * cw, z0: (f + s.y[0]) * storey, z1: (f + s.y[1]) * storey});
  }
  return {pier, columns, bay: cw, storey, storeys, windows};
}
