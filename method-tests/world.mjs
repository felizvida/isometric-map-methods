import test from 'node:test';
import assert from 'node:assert/strict';
import {SegmentHash, crossing, sweep, pushOut, cutOpenings, openingHalfWidth, sliceWalls, ringSegments} from '../methods/collision.mjs';
import {buildGraph, aStar, mainNetwork, pruneGraph, pavementLine, nearestNode} from '../methods/graph.mjs';
import {idmAcceleration, laneOffset, junctionRadius, uTurnPoint, turnWeight} from '../methods/traffic.mjs';

function hashOf(segs, cell = 8) { const h = new SegmentHash(cell); for (const s of segs) h.add(s); return h; }
const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

test('a swept move never crosses a wall, even when one step is longer than the body', () => {
  const h = hashOf(ringSegments(square));
  // a thousand random long steps from inside the square: every result stays inside
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 1000; k++) {
    const p = [1 + 8 * rnd(), 1 + 8 * rnd()], q = [p[0] + (rnd() - 0.5) * 30, p[1] + (rnd() - 0.5) * 30];
    const r = sweep(h, p, q);
    assert.ok(r.x > 0 && r.x < 10 && r.y > 0 && r.y < 10, `escaped to ${r.x}, ${r.y}`);
  }
  // sliding: a diagonal move into the east wall continues north along it
  const r = sweep(h, [9, 5], [12, 8]);
  assert.ok(r.x > 9.98 && r.x < 10 && r.y > 7.9 && r.hit);
  // the joint between two wall segments does not leak
  assert.notEqual(crossing([5, 5], [15, 15], {ax: 10, ay: 0, bx: 10, by: 10}), null);
});

test('push-out keeps a disc off the wall, openings cut fences, slicing finds solid walls', () => {
  const h = hashOf(ringSegments(square));
  const p = pushOut(h, [0.1, 5], 0.3);
  assert.ok(Math.abs(p[0] - 0.3) < 1e-9);
  // a 40 m fence with a gate at 10 m (1.8 m gap) and a road crossing at 30 m (6 m road)
  const pieces = cutOpenings([[0, 0], [40, 0]], [{s: 10, halfWidth: openingHalfWidth({})}, {s: 30, halfWidth: openingHalfWidth({roadWidth: 6})}]);
  assert.deepEqual(pieces.map((l) => [l[0][0], l[l.length - 1][0]].map((x) => +x.toFixed(2))), [[0, 9.1], [10.9, 25.4], [34.6, 40]]);
  assert.equal(openingHalfWidth({width: 4}), 2);
  // a vertical wall triangle pair 0..6 m high is cut at 1 m; a roof-only triangle 3 m up is not (no 1.0/1.8 crossing)
  const wall = [[[0, 0, 0], [10, 0, 0], [10, 0, 6]], [[0, 0, 0], [10, 0, 6], [0, 0, 6]]];
  const canopyPost = [[[0, 5, 2.5], [0.3, 5, 2.5], [0.3, 5, 3]]];
  const segs = sliceWalls([...wall, ...canopyPost], () => 0);
  assert.equal(segs.length, 2);
  assert.ok(segs.every((s) => s.ay === 0 && s.by === 0));
});

test('graph: welding, A*, the strongly connected core and pruning by walls', () => {
  const lines = [
    {pts: [[0, 0], [10, 0], [20, 0]], kind: 'footway'},
    {pts: [[20, 0], [20, 10]], kind: 'footway'},
    {pts: [[10, 0.04], [10, 10], [20, 10]], kind: 'footway'},          // welds to (10, 0) within 0.1 m
    {pts: [[30, 30], [40, 30]], kind: 'footway'},                      // a separate island
    {pts: [[20, 10], [25, 15]], kind: 'service', oneway: true},        // a one-way spur: reachable, no way back
  ];
  const g = buildGraph(lines);
  assert.equal(g.nodes.length, 8);
  const from = nearestNode(g, 0, 0), to = nearestNode(g, 20, 10);
  const r = aStar(g, from, to);
  assert.equal(Math.round(r.cost), 30);
  const mask = mainNetwork(g);
  assert.equal(mask[nearestNode(g, 30, 30)], 0, 'island excluded');
  assert.equal(mask[nearestNode(g, 25, 15)], 0, 'one-way dead end excluded');
  assert.equal(mask[from], 1);
  // a wall across (15, -1)-(15, 1) blocks the direct path; the route goes round by the north
  const walls = hashOf([{ax: 15, ay: -1, bx: 15, by: 1}]);
  const {graph: pruned, dropped} = pruneGraph(g, (e) => {
    const a = g.nodes[e.a], b = g.nodes[e.b];
    return walls.near((a.x + b.x) / 2, (a.y + b.y) / 2, e.len).some((s) => crossing([a.x, a.y], [b.x, b.y], s) !== null) ? 'wall' : null;
  });
  assert.equal(dropped.length, 2);
  assert.equal(Math.round(aStar(pruned, from, to).cost), 30);
  assert.equal(aStar(pruned, from, nearestNode(g, 20, 0)).cost, 40);
  const pl = pavementLine(g, {...g.edges[0], width: 6});
  assert.deepEqual(pl.map((p) => p.map((x) => +x.toFixed(2))), [[0, -3.9], [10, -3.9]]);
});

test('traffic references: IDM, lanes, junction zones, U-turns and turn weights', () => {
  assert.ok(Math.abs(idmAcceleration(0, 13, Infinity) - 1.5) < 1e-12);
  assert.ok(idmAcceleration(13, 13, Infinity) === 0);
  assert.equal(idmAcceleration(15, 13, 3, 10), -8.5);
  assert.equal(laneOffset(6, 2, 0, false), 1.5);
  assert.equal(laneOffset(9, 3, 0, true), -3);
  assert.equal(junctionRadius(8, Math.PI / 2), 5.5);
  assert.equal(junctionRadius(50, 0.01), 22);
  const start = uTurnPoint([0, 0], [1, 0], 1.5, 1.5, 0), end = uTurnPoint([0, 0], [1, 0], 1.5, 1.5, Math.PI);
  assert.deepEqual(start.map((x) => +x.toFixed(9)), [-2, -1.5]);
  assert.deepEqual(end.map((x) => +x.toFixed(9)), [-2, 1.5]);
  assert.ok(turnWeight({rank: 2, currentRank: 2, turn: 0}) > turnWeight({rank: 2, currentRank: 2, turn: Math.PI / 2}));
  assert.equal(turnWeight({rank: 2, currentRank: 2, turn: Math.PI, uTurn: true}), 0);
});
