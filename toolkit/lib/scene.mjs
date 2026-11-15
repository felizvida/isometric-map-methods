// Layers (features.geojson, structures.geojson, terrain.json) -> a scene: terrain mesh, a ground texture, building
// meshes with records, trees, collision walls and a pruned walking network. Deterministic: the same layers always
// give the same bytes. Every rule and constant is documented in public-docs/ALGORITHMS.md.
import fs from 'node:fs';
import path from 'node:path';
import {terrainMesh} from '../../methods/terrain.mjs';
import {orientedBox, chooseHeight, seat, roofTriangles, canPitch, pitchedRoofHeight, ringArea} from '../../methods/buildings.mjs';
import {SegmentHash, crossing, cutOpenings, openingHalfWidth, ringSegments, pointSegmentDistance} from '../../methods/collision.mjs';
import {buildGraph, mainNetwork, pruneGraph, pavementLine} from '../../methods/graph.mjs';
import {terrainGrid, quadLeaves, meshCheck, triangulate, pointInRing, overlapShare, encodePNG} from '../../tutorial/lib.mjs';
import {tangentPlane} from './terrain.mjs';

export const TOOLKIT_VERSION = '1.0.0';
const r2 = (x) => Math.round(x * 100) / 100;

// ------------------------------------------------------------------ deterministic randomness
export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashString = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

// ------------------------------------------------------------------ load
export function loadLayers(dir) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const terrain = read('terrain.json');
  if (terrain.format !== 'sample-terrain/1') throw new Error('unknown terrain format');
  const features = read('features.geojson');
  const structures = fs.existsSync(path.join(dir, 'structures.geojson')) ? read('structures.geojson') : {features: []};
  return {terrain, features, structures};
}

function localise(fc, tp) {
  const L = ([lon, lat]) => tp.toLocal(lon, lat);
  return fc.features.map((f) => {
    const g = f.geometry, o = {kind: f.properties.kind, props: f.properties};
    if (g.type === 'Polygon') { o.ring = g.coordinates[0].map(L); if (ringArea(o.ring) < 0) o.ring.reverse(); }
    else if (g.type === 'LineString') o.line = g.coordinates.map(L);
    else if (g.type === 'Point') o.point = L(g.coordinates);
    return o;
  });
}

// ------------------------------------------------------------------ ground texture
export const GROUND = {
  lawn: [150, 168, 108], grass: [140, 166, 98], park: [112, 156, 88], wood: [84, 122, 70], water: [104, 148, 176],
  parking: [132, 132, 134], playground: [214, 190, 142], pitch: [122, 152, 102], basketball: [196, 128, 88],
  tennis: [86, 136, 112], soccer: [108, 156, 86], baseball: [190, 150, 110], kerb: [178, 176, 170],
  road: [92, 94, 100], service: [124, 124, 128], cycleway: [172, 150, 138], path: [212, 202, 182],
  footway: [214, 206, 190], sidewalk: [204, 200, 194], crossing: [92, 94, 100], stream: [104, 148, 176],
  marking: [236, 236, 230], yellow: [222, 186, 74], footprint: [168, 164, 156],
};
const ROAD_WIDTH = {motorway: 14, trunk: 12, primary: 11, secondary: 9, tertiary: 7.5, unclassified: 6, residential: 6.5, living_street: 5};
const LINE_WIDTH = {service: 4.5, cycleway: 3, path: 2.2, footway: 2.4, sidewalk: 2, crossing: 3, stream: 2};

export function lineWidth(f) {
  if (Number.isFinite(f.props.width)) return f.props.width;
  if (f.kind === 'road') return f.props.lanes ? f.props.lanes * 3.3 + 1.2 : ROAD_WIDTH[f.props.road] ?? 7;
  return LINE_WIDTH[f.kind] ?? 2;
}

function groundTexture(features, buildings, bounds, maxPx = 2048) {
  const [x0, y0, x1, y1] = bounds;
  const res = Math.max(0.25, Math.max(x1 - x0, y1 - y0) / maxPx);
  const w = Math.ceil((x1 - x0) / res), h = Math.ceil((y1 - y0) / res);
  const cls = new Uint8Array(w * h), names = Object.keys(GROUND), id = (n) => names.indexOf(n);
  const fillRing = (ring, c) => {
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / res)), i1 = Math.min(w - 1, Math.ceil((Math.max(...xs) - x0) / res));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - y0) / res)), j1 = Math.min(h - 1, Math.ceil((Math.max(...ys) - y0) / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (pointInRing([x0 + (i + 0.5) * res, y0 + (j + 0.5) * res], ring)) cls[j * w + i] = c;
    }
  };
  // stroke a polyline: paint(cls) where distance <= hw; `pattern(t, d)` may pick a different class (markings, zebra)
  const stroke = (line, hw, c, pattern = null) => {
    let along = 0;
    for (let k = 0; k < line.length - 1; k++) {
      const [ax, ay] = line[k], [bx, by] = line[k + 1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - x0) / res)), i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + hw - x0) / res));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - hw - y0) / res)), j1 = Math.min(h - 1, Math.ceil((Math.max(ay, by) + hw - y0) / res));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = x0 + (i + 0.5) * res, y = y0 + (j + 0.5) * res;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (L * L)));
        const side = ((x - ax) * dy - (y - ay) * dx) / L, d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d > hw) continue;
        cls[j * w + i] = pattern ? pattern(along + t * L, side, d, c) : c;
      }
      along += L;
    }
  };
  for (const kind of ['grass', 'wood', 'park', 'parking', 'water', 'playground', 'pitch']) {
    for (const f of features) if (f.ring && f.kind === kind) fillRing(f.ring, id(kind === 'pitch' && id(f.props.sport) >= 0 ? f.props.sport : kind));
  }
  const lines = features.filter((f) => f.line && (f.kind in LINE_WIDTH || f.kind === 'road'));
  const rank = (f) => -lineWidth(f);
  lines.sort((a, b) => rank(a) - rank(b));                               // wide first, narrow paths on top
  for (const f of lines) if (f.kind === 'road' || f.kind === 'service') stroke(f.line, lineWidth(f) / 2 + 0.3, id('kerb'));
  for (const f of lines) {
    const hw = lineWidth(f) / 2;
    if (f.kind === 'road' && !f.props.oneway && lineWidth(f) >= 6.5) {
      stroke(f.line, hw, id('road'), (s, side, d, c) => (Math.abs(Math.abs(side) - 0.16) < 0.065 ? id('yellow') : c));
    } else if (f.kind === 'crossing') {
      stroke(f.line, hw, id('road'), (s, side, d) => (Math.abs(side) < hw - 0.2 && (s % 0.9) < 0.5 ? id('marking') : id('road')));
    } else stroke(f.line, hw, id(f.kind));
  }
  for (const b of buildings) fillRing(b.ring, id('footprint'));
  const rgba = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const c = GROUND[names[cls[j * w + i]]], o = ((h - 1 - j) * w + i) * 4;  // PNG rows run north to south
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
  }
  return {x0, y0, res, w, h, png: Buffer.from(encodePNG(rgba, w, h)).toString('base64'), classAt: (x, y) => {
    const i = Math.floor((x - x0) / res), j = Math.floor((y - y0) / res);
    return i < 0 || j < 0 || i >= w || j >= h ? 'lawn' : names[cls[j * w + i]];
  }};
}

// ------------------------------------------------------------------ buildings
const WALL_COLOURS = {apartments: [0.78, 0.69, 0.6], residential: [0.8, 0.72, 0.62], house: [0.86, 0.82, 0.74], detached: [0.86, 0.82, 0.74],
  commercial: [0.74, 0.74, 0.72], office: [0.7, 0.73, 0.76], retail: [0.8, 0.76, 0.7], industrial: [0.7, 0.7, 0.68], garage: [0.72, 0.7, 0.66],
  parking: [0.74, 0.73, 0.7], school: [0.76, 0.62, 0.52], church: [0.8, 0.76, 0.68], shed: [0.66, 0.6, 0.52]};
const STYLE = {apartments: 'apartment', residential: 'apartment', house: 'house', detached: 'house', terrace: 'house', commercial: 'ribbon',
  office: 'ribbon', retail: 'ribbon', industrial: 'industrial', warehouse: 'industrial', garage: 'industrial', parking: 'parking',
  church: 'church', school: 'institutional', hospital: 'institutional', university: 'institutional'};
export const STYLE_INDEX = ['punched', 'ribbon', 'curtain', 'historic', 'institutional', 'house', 'apartment', 'parking', 'industrial', 'church'];
const STOREY = {house: 3.0, apartment: 3.0, parking: 3.1};

function makeBuildings(features, structures, grid) {
  const out = [];
  let id = 0;
  for (const f of features.filter((x) => x.kind === 'building' && x.ring && x.ring.length >= 4)) {
    const ring = f.ring, area = Math.abs(ringArea(ring));
    if (area < 4) continue;
    const box = orientedBox(ring), type = f.props.building || 'yes', style = STYLE[type] || 'punched';
    let shape = f.props.roof_shape || 'flat';
    if (shape === 'round') shape = 'barrel';
    if (['gambrel', 'saltbox', 'mansard'].includes(shape)) shape = 'gabled';
    if (!['flat', 'gabled', 'hipped', 'pyramidal', 'skillion', 'barrel'].includes(shape) || (shape !== 'flat' && !canPitch(box, shape))) shape = 'flat';
    const roofH = shape === 'flat' ? 0 : f.props.roof_height ?? pitchedRoofHeight(2 * box.hv, style === 'house' || style === 'apartment');
    let best = null;
    for (const s of structures) {
      if (!s.ring || !Number.isFinite(s.props.height_m)) continue;
      const cov = overlapShare(ring, s.ring);
      if (cov > 0 && (!best || cov > best.coverage)) best = {coverage: cov, areaRatio: Math.abs(ringArea(s.ring)) / area, height: s.props.height_m};
    }
    const storey = STOREY[style] ?? 3.5;
    const h = chooseHeight({tagged: f.props.height, match: best, levels: f.props.levels, storey, roofShape: shape, roofHeight: roofH,
                            defaultLevels: area < 60 ? 1 : 2});
    const samples = [];
    for (let k = 0; k < ring.length - 1; k++) {
      const [ax, ay] = ring[k], [bx, by] = ring[k + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 3));
      for (let t = 0; t < n; t++) samples.push(grid.heightAt(Math.min(grid.x1, Math.max(grid.x0, ax + (bx - ax) * t / n)), Math.min(grid.y1, Math.max(grid.y0, ay + (by - ay) * t / n))));
    }
    const st = seat(samples, h.height);
    const rnd = mulberry32(hashString(f.props.osm || String(id)));
    const wall = (WALL_COLOURS[type] || [0.77, 0.72, 0.66]).map((c) => c * (0.94 + 0.12 * rnd()));
    const roof = shape === 'flat' ? [0.6, 0.6, 0.6].map((c) => c * (0.92 + 0.1 * rnd())) : [0.46, 0.36, 0.32].map((c) => c * (0.85 + 0.25 * rnd()));
    out.push({id: ++id, osm: f.props.osm || null, ring, box, type, style, storey, shape, roofH, height: r2(h.height), source: h.source,
              coverage: best ? r2(best.coverage) : 0, pad: r2(st.pad), base: r2(st.base), top: r2(st.pad + h.height), area: r2(area), wall, roof});
  }
  return out;
}

function buildingMesh(blds, zBase) {
  const pos = [], nrm = [], col = [], fac = [], ids = [], idx = [];
  const tri = (p, n, c, b, f = [0, 0, 0, -1]) => {
    const base = pos.length / 3;
    for (const q of p) { pos.push(r2(q[0]), r2(q[1]), r2(q[2] - zBase)); nrm.push(...n.map((v) => Math.round(v * 1000) / 1000)); col.push(...c.map((v) => Math.round(v * 255))); ids.push(b.id); }
    for (const q of f.length === 4 ? [f, f, f] : f) fac.push(...q);
    idx.push(base, base + 1, base + 2);
  };
  const normalOf = ([a, b, c]) => {
    const u = b.map((v, k) => v - a[k]), w = c.map((v, k) => v - a[k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...n) || 1;
    return n.map((v) => v / l);
  };
  for (const b of blds) {
    const eaves = b.top - b.roofH, styleId = STYLE_INDEX.indexOf(b.style);
    for (let k = 0; k < b.ring.length - 1; k++) {
      const [ax, ay] = b.ring[k], [bx, by] = b.ring[k + 1], len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const n = [(by - ay) / len, -(bx - ax) / len, 0];
      // facade attributes per vertex: (u along the edge, z above the pad, storey height, style; -1 = no windows)
      const s = len < 2 ? -1 : styleId, F = (u, z) => [r2(u), r2(z - b.pad), b.storey, s];
      const A0 = [ax, ay, b.base], B0 = [bx, by, b.base], B1 = [bx, by, eaves], A1 = [ax, ay, eaves];
      tri([A0, B0, B1], n, b.wall, b, [F(0, b.base), F(len, b.base), F(len, eaves)]);
      tri([A0, B1, A1], n, b.wall, b, [F(0, b.base), F(len, eaves), F(0, eaves)]);
    }
    if (b.shape === 'flat') {
      const pts = b.ring.slice(0, -1);
      for (const [i, j, k] of triangulate(b.ring)) tri([[...pts[i], b.top], [...pts[j], b.top], [...pts[k], b.top]], [0, 0, 1], b.roof, b);
    } else {
      for (const t of roofTriangles(b.box, eaves, b.top, b.shape)) tri(t, normalOf(t), b.roof, b);
      // close the ends between eaves and roof (gables, skillion sides, barrel ends) in the wall colour
      const P = (u, v, z) => [b.box.cx + u * b.box.ux - v * b.box.uy, b.box.cy + u * b.box.uy + v * b.box.ux, z];
      const {hu, hv} = b.box;
      const ends = [];
      if (b.shape === 'gabled') ends.push([P(hu, -hv, eaves), P(hu, hv, eaves), P(hu, 0, b.top)], [P(-hu, hv, eaves), P(-hu, -hv, eaves), P(-hu, 0, b.top)]);
      if (b.shape === 'skillion') ends.push([P(hu, -hv, eaves), P(hu, hv, b.top), P(hu, hv, eaves)], [P(-hu, hv, eaves), P(-hu, hv, b.top), P(-hu, -hv, eaves)]);
      if (b.shape === 'barrel') {
        const rise = b.top - eaves, R = (hv * hv + rise * rise) / (2 * rise), phi = Math.asin(Math.min(1, hv / R));
        for (let k = 0; k < 12; k++) {
          const a0 = -phi + 2 * phi * k / 12, a1 = -phi + 2 * phi * (k + 1) / 12, z = (a) => eaves + R * Math.cos(a) - R * Math.cos(phi);
          ends.push([P(hu, 0, eaves), P(hu, R * Math.sin(a0), z(a0)), P(hu, R * Math.sin(a1), z(a1))]);
          ends.push([P(-hu, 0, eaves), P(-hu, R * Math.sin(a1), z(a1)), P(-hu, R * Math.sin(a0), z(a0))]);
        }
      }
      for (const t of ends) tri(t, normalOf(t), b.wall, b);
    }
  }
  return {positions: pos, normals: nrm, colours: col, facade: fac.map(r2), ids, indices: idx};
}

// ------------------------------------------------------------------ trees
const TREE_DENSITY = {wood: 0.5, park: 0.08, grass: 0.03, lawn: 0.012};

function makeTrees(features, ground, grid, buildings, seed) {
  const rnd = mulberry32(seed), trees = [];
  const inBuilding = (x, y) => buildings.some((b) => pointInRing([x, y], b.ring));
  const clearOf = (x, y, r) => {
    for (let a = 0; a < 8; a++) {
      const c = ground.classAt(x + r * Math.cos(a * Math.PI / 4), y + r * Math.sin(a * Math.PI / 4));
      if (!(c in TREE_DENSITY)) return false;
    }
    return true;
  };
  const add = (x, y, kind) => {
    const conifer = kind !== 'street' && rnd() < (kind === 'wood' ? 0.22 : 0.12);
    const [h0, h1, c0, c1] = conifer ? [10, 19, 2.4, 3.8] : kind === 'wood' ? [13, 20, 3.8, 5.8] : [8.5, 15.5, 3, 5.4];
    trees.push({x: r2(x), y: r2(y), z: r2(grid.heightAt(x, y)), h: r2(h0 + (h1 - h0) * rnd()), r: r2(c0 + (c1 - c0) * rnd()), conifer, seed: Math.floor(rnd() * 1e6)});
  };
  for (const f of features) if (f.point && f.kind === 'tree') {
    const [x, y] = f.point;
    if (x > grid.x0 && x < grid.x1 && y > grid.y0 && y < grid.y1 && !inBuilding(x, y)) add(x, y, 'mapped');
  }
  for (let y = grid.y0 + 2; y < grid.y1 - 2; y += 4) for (let x = grid.x0 + 2; x < grid.x1 - 2; x += 4) {
    const px = x + (rnd() - 0.5) * 3.2, py = y + (rnd() - 0.5) * 3.2, c = ground.classAt(px, py), p = rnd();
    if (!(c in TREE_DENSITY) || p >= TREE_DENSITY[c]) continue;
    if (!clearOf(px, py, 2.2) || inBuilding(px, py) || trees.some((t) => Math.hypot(t.x - px, t.y - py) < 3)) continue;
    add(px, py, c);
  }
  return trees;
}

// ------------------------------------------------------------------ walls and the walking network
function makeWalls(features, buildings) {
  const walls = [];
  for (const b of buildings) for (const s of ringSegments(b.ring)) walls.push([s.ax, s.ay, s.bx, s.by, 1]);
  const openings = features.filter((f) => f.point && f.kind === 'opening');
  const roads = features.filter((f) => f.line && (f.kind === 'road' || f.kind === 'service'));
  let gaps = 0;
  for (const f of features.filter((x) => x.line && ['fence', 'wall', 'hedge'].includes(x.kind))) {
    const cuts = [];
    let cum = 0;
    for (let k = 0; k < f.line.length - 1; k++) {
      const seg = {ax: f.line[k][0], ay: f.line[k][1], bx: f.line[k + 1][0], by: f.line[k + 1][1]}, L = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay);
      for (const o of openings) {
        if (pointSegmentDistance(o.point[0], o.point[1], seg) > 1) continue;
        const t = Math.max(0, Math.min(1, ((o.point[0] - seg.ax) * (seg.bx - seg.ax) + (o.point[1] - seg.ay) * (seg.by - seg.ay)) / (L * L || 1)));
        const road = roads.find((r) => r.line.some((p, i) => i < r.line.length - 1 &&
          pointSegmentDistance(o.point[0], o.point[1], {ax: p[0], ay: p[1], bx: r.line[i + 1][0], by: r.line[i + 1][1]}) < 1));
        cuts.push({s: cum + t * L, halfWidth: openingHalfWidth({width: o.props.width, roadWidth: road ? lineWidth(road) : null})});
      }
      cum += L;
    }
    gaps += cuts.length;
    for (const piece of cutOpenings(f.line, cuts)) for (let k = 0; k < piece.length - 1; k++) walls.push([piece[k][0], piece[k][1], piece[k + 1][0], piece[k + 1][1], 2]);
  }
  return {walls: walls.map((w) => w.map((v, k) => (k < 4 ? r2(v) : v))), gaps};
}

const WALK_KINDS = {footway: 1, sidewalk: 1, crossing: 1, path: 1, cycleway: 1, service: 1.25, road: 1.6};

function makeWalkNetwork(features, walls, buildings, bounds) {
  const lines = features.filter((f) => f.line && f.kind in WALK_KINDS).map((f) => ({pts: f.line, kind: f.kind, width: lineWidth(f)}));
  const g = buildGraph(lines);
  const hash = new SegmentHash(8);
  for (const w of walls) hash.add({ax: w[0], ay: w[1], bx: w[2], by: w[3]});
  const [x0, y0, x1, y1] = bounds, inside = (p) => p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1;
  const geom = (e) => (e.kind === 'road' || e.kind === 'service') ? pavementLine(g, e) : [[g.nodes[e.a].x, g.nodes[e.a].y], [g.nodes[e.b].x, g.nodes[e.b].y]];
  const {graph, dropped} = pruneGraph(g, (e) => {
    const [p, q] = geom(e);
    if (!inside(p) || !inside(q)) return 'outside the area';
    if (hash.near((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, e.len / 2 + 1).some((s) => crossing(p, q, s) !== null)) return 'crosses a wall';
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (buildings.some((b) => pointInRing(mid, b.ring))) return 'inside a building';
    return null;
  });
  const main = mainNetwork(graph);
  return {nodes: graph.nodes.map((n) => [r2(n.x), r2(n.y)]), main: Array.from(main),
          edges: graph.edges.map((e) => [e.a, e.b, r2(e.len * WALK_KINDS[e.kind]), (e.kind === 'road' || e.kind === 'service') ? r2(e.width / 2 + 0.9) : 0]),
          dropped: dropped.map((d) => d.reason)};
}

// ------------------------------------------------------------------ the scene
export function buildScene(layers, {name = 'area', stars = null, tolerance = 0.25} = {}) {
  const {terrain} = layers, grid = terrainGrid(terrain);
  const tp = tangentPlane(terrain.frame.origin_lon, terrain.frame.origin_lat);
  const features = localise(layers.features, tp), structures = localise(layers.structures, tp);
  const zBase = Math.floor(grid.min);
  const leaves = quadLeaves(grid, tolerance, 32), mesh = terrainMesh(leaves, grid.heightAt), check = meshCheck(mesh, grid);
  if (check.cracks) throw new Error('terrain mesh has cracks');
  const bounds = [grid.x0, grid.y0, grid.x1, grid.y1];
  const buildings = makeBuildings(features, structures, grid);
  const ground = groundTexture(features, buildings, bounds);
  const trees = makeTrees(features, ground, grid, buildings, hashString(name));
  const {walls, gaps} = makeWalls(features, buildings);
  const walk = makeWalkNetwork(features, walls, buildings, bounds);
  const packs = {
    info: {format: 'toolkit-scene/1', toolkit: TOOLKIT_VERSION, name, origin: {lon: terrain.frame.origin_lon, lat: terrain.frame.origin_lat},
           bounds: bounds.map(r2), zBase, vertical: terrain.vertical?.datum ?? null,
           attribution: [layers.features.attribution, layers.structures.attribution, terrain.credit].filter(Boolean)},
    terrain: {x0: grid.x0, y0: grid.y0, cell: grid.cell, nx: grid.nx, ny: grid.ny,
              heights: Array.from({length: grid.ny}, (_, j) => Array.from({length: grid.nx}, (_, i) => r2(grid.z(i, j) - zBase))),
              mesh: {positions: mesh.vertices.flatMap((v) => [r2(v[0]), r2(v[1]), r2(v[2] - zBase)]), indices: mesh.triangles.flat()}},
    ground: {x0: ground.x0, y0: ground.y0, res: ground.res, w: ground.w, h: ground.h, png: ground.png},
    buildings: {records: buildings.map((b) => ({id: b.id, osm: b.osm, type: b.type, style: b.style, roof: b.shape, height: b.height, source: b.source,
                                                coverage: b.coverage, pad: r2(b.pad - zBase), base: r2(b.base - zBase), top: r2(b.top - zBase), area: b.area,
                                                ring: b.ring.map((p) => [r2(p[0]), r2(p[1])])})),
                mesh: buildingMesh(buildings, zBase), styles: STYLE_INDEX},
    trees,
    walk: {...walk, walls},
  };
  if (stars) packs.sky = {source: stars.source, licence: stars.licence, stars: stars.stars};
  const summary = {buildings: buildings.length, sources: buildings.reduce((m, b) => (m[b.source] = (m[b.source] || 0) + 1, m), {}),
                   terrain: {leaves: leaves.length, triangles: check.triangles, cracks: check.cracks}, trees: trees.length,
                   walls: walls.length, gaps, walk: {nodes: walk.nodes.length, edges: walk.edges.length, dropped: walk.dropped.length,
                                                     main: walk.main.reduce((a, b) => a + b, 0)},
                   ground: [ground.w, ground.h, ground.res]};
  return {packs, summary};
}
