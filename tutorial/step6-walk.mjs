// Step 6: walking. Build a network from the mapped paths and streets, remove every link a body could not walk (it
// crosses a wall or runs inside a building), keep the strongly connected core, route with A*, and show that a swept
// move can never pass through a wall however long the step.
//   node tutorial/step6-walk.mjs
import {loadLayers, buildScene} from '../toolkit/lib/scene.mjs';
import {SegmentHash, sweep} from '../methods/collision.mjs';
import {aStar} from '../methods/graph.mjs';
import {pointInRing, SAMPLE_DIR} from './lib.mjs';

const {packs} = buildScene(loadLayers(SAMPLE_DIR), {name: 'sample'});
const {walk, buildings} = {walk: packs.walk, buildings: packs.buildings.records};
const reasons = walk.dropped.reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {});
console.log(`Network: ${walk.nodes.length} nodes, ${walk.edges.length} directed links kept, ${walk.dropped.length} dropped`, reasons);
console.log(`Strongly connected core: ${walk.main.filter(Boolean).length} of ${walk.nodes.length} nodes (spawn, enter and route only there)`);

// A* between the two core nodes farthest apart
const graph = {nodes: walk.nodes.map(([x, y]) => ({x, y, out: []})), edges: []};
walk.edges.forEach(([a, b, cost]) => { graph.nodes[a].out.push(graph.edges.length); graph.edges.push({a, b, cost, len: cost}); });
const core = walk.nodes.map((_, k) => k).filter((k) => walk.main[k]);
let pair = [core[0], core[0]], far = 0;
for (const a of core) for (const b of core) {
  const d = Math.hypot(walk.nodes[a][0] - walk.nodes[b][0], walk.nodes[a][1] - walk.nodes[b][1]);
  if (d > far) { far = d; pair = [a, b]; }
}
const route = aStar(graph, pair[0], pair[1], (e) => e.cost);
console.log(`Route across the area: ${far.toFixed(0)} m apart in a straight line, ${route.cost.toFixed(0)} m by the network (${route.edges.length} links)`);

// Swept movement: 10,000 random steps of up to 6 m from points outside buildings; none may end inside one.
const walls = new SegmentHash(8);
for (const w of walk.walls) walls.add({ax: w[0], ay: w[1], bx: w[2], by: w[3]});
let seed = 11, inside = 0, stopped = 0, naive = 0;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const [x0, y0, x1, y1] = packs.info.bounds;
const inBuilding = (p) => buildings.some((b) => pointInRing(p, b.ring));
for (let k = 0; k < 10000; k++) {
  const p = [x0 + (x1 - x0) * rnd(), y0 + (y1 - y0) * rnd()];
  if (inBuilding(p)) continue;
  const a = rnd() * 2 * Math.PI, L = 6 * rnd(), q = [p[0] + L * Math.cos(a), p[1] + L * Math.sin(a)];
  const r = sweep(walls, p, q);
  if (r.hit) stopped++;
  if (inBuilding([r.x, r.y])) inside++;
  if (inBuilding(q)) naive++;
}
console.log(`Swept moves: ${stopped} stopped at a wall and slid; ${inside} ended inside a building (without the sweep: ${naive})`);
