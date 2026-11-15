import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {orientedBox, chooseHeight, seat, roofTriangles, wallQuads, bayLayout, pitchedRoofHeight, canPitch, ringArea} from '../methods/buildings.mjs';
import {rasterize, fillHoles, roofLevels, agreement, bestFlatHeight, auditClass} from '../methods/lidar.mjs';
import {canonicalJSON, writePacks, readPacks, recordHashes, diffRecords} from '../methods/packs.mjs';

test('oriented box of a rotated rectangle and an L-shape', () => {
  const a = 0.5, R = (x, y) => [x * Math.cos(a) - y * Math.sin(a) + 3, x * Math.sin(a) + y * Math.cos(a) - 2];
  const rect = [R(-10, -4), R(10, -4), R(10, 4), R(-10, 4), R(-10, -4)];
  const b = orientedBox(rect);
  assert.ok(Math.abs(b.hu - 10) < 1e-9 && Math.abs(b.hv - 4) < 1e-9 && Math.abs(b.fill - 1) < 1e-9);
  assert.ok(Math.abs(b.cx - 3) < 1e-9 && Math.abs(b.cy + 2) < 1e-9);
  assert.ok(Math.abs(Math.abs(Math.cos(b.angle - a)) - 1) < 1e-9, 'long axis follows the rectangle');
  const L = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10], [0, 0]];
  assert.ok(!canPitch(orientedBox(L), 'gabled'));
  assert.equal(pitchedRoofHeight(8), 2.56);
  assert.equal(pitchedRoofHeight(30, true), 4.5);
});

test('height priority and seating on a slope', () => {
  assert.deepEqual(chooseHeight({curated: 12, tagged: 20}), {height: 12, source: 'curated'});
  assert.deepEqual(chooseHeight({tagged: 20, match: {coverage: 1, areaRatio: 1, height: 9}}), {height: 20, source: 'tag'});
  assert.deepEqual(chooseHeight({match: {coverage: 0.9, areaRatio: 1.1, height: 17.4}}), {height: 17.4, source: 'structures'});
  assert.equal(chooseHeight({match: {coverage: 0.5, areaRatio: 1, height: 17.4}, levels: 6, storey: 3}).source, 'levels');
  assert.equal(chooseHeight({match: {coverage: 0.9, areaRatio: 1, height: 1.5}}).source, 'default');
  assert.equal(chooseHeight({match: {coverage: 0.9, areaRatio: 1, height: 10}, roofShape: 'gabled', roofHeight: 3}).height, 11.8);
  const ground = [100, 100.5, 101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5, 105];
  const s = seat(ground, 12);
  assert.equal(s.pad, 104.5); assert.equal(s.base, 100); assert.equal(s.drape, false);
  assert.equal(seat(ground, 4).drape, true);
  assert.equal(seat(ground, 4, {raised: true}).pad, 102.5);
});

test('roof forms close over the box and wind upwards; bays fill the wall', () => {
  const box = orientedBox([[0, 0], [20, 0], [20, 8], [0, 8], [0, 0]]);
  for (const shape of ['flat', 'gabled', 'hipped', 'pyramidal', 'skillion', 'barrel']) {
    const tris = roofTriangles(box, 10, 13, shape, {overhang: 0});
    let plan = 0;
    for (const [p, q, r] of tris) {
      const up = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      assert.ok(up >= -1e-9, `${shape} triangle faces down`);
      plan += up / 2;
    }
    assert.ok(Math.abs(plan - 160) < 1e-6, `${shape} covers ${plan} m2`);
  }
  const walls = wallQuads([[0, 0], [20, 0], [20, 1.5], [0, 1.5], [0, 0]], 0, 10);
  assert.deepEqual(walls.map((w) => w.kind), ['windows', 'blank', 'windows', 'blank']);
  const bays = bayLayout(20, 10.5, 'punched', 3.5);
  assert.equal(bays.columns, 6); assert.equal(bays.storeys, 2); assert.equal(bays.windows.length, 12);
  assert.ok(bays.windows.every((w) => w.u0 >= bays.pier && w.u1 <= 20 - bays.pier));
  assert.equal(bayLayout(1.5, 10, 'punched').windows.length, 0);
  assert.equal(bayLayout(20, 10, 'punched', 3.5, {bay: 4}).columns, Math.round((20 - 1.4) / 4));
});

test('lidar: rasters, roof levels, agreement and audit classes', () => {
  const pts = [];
  for (let x = 0.25; x < 10; x += 0.5) for (let y = 0.25; y < 10; y += 0.5) {
    pts.push({x, y, z: 100, cls: 2, ret: 1, nret: 1});
    const roof = x < 6 ? 112 : 106;                                   // two roof levels: 12 m and 6 m above ground
    pts.push({x, y, z: roof, cls: 1, ret: 1, nret: 1});
  }
  pts.push({x: 5, y: 5, z: 400, cls: 7, ret: 1, nret: 1});            // noise is ignored
  const r = rasterize(pts, [0, 0, 10, 10], 0.5);
  assert.equal(r.w, 20); assert.equal(Math.max(...r.dsm), 112); assert.equal(r.dtm[0], 100);
  const holes = Float32Array.from(r.dsm); holes[45] = NaN;
  assert.equal(fillHoles(holes, r.w, r.h)[45], 112);
  const above = Array.from(r.dsm, (z) => z - 100);
  const lv = roofLevels(above);
  assert.deepEqual(lv.levels.map((l) => Math.round(l.z)).sort((a, b) => a - b), [6, 12]);
  assert.equal(Math.round(lv.roof), 12);
  const flat = bestFlatHeight(above);
  assert.ok(Math.abs(flat.z - 12) < 1e-9 && Math.abs(flat.share - 0.6) < 1e-9);
  const ag = agreement(above, above.map(() => 12));
  assert.ok(Math.abs(ag.agree - 0.6) < 1e-9 && Math.abs(ag.over - 0.4) < 1e-9);
  assert.equal(auditClass({agree: 0.6, flatShare: flat.share}), 'multi-level');
  assert.equal(auditClass({agree: 0.9}), 'ok');
  assert.equal(auditClass({agree: 0.1, groundShare: 0.8}), 'phantom');
});

test('packs are content addressed and fail closed; record hashes split shape from labels', () => {
  assert.equal(canonicalJSON({b: 1, a: [2, {d: 3, c: 4}]}), '{"a":[2,{"c":4,"d":3}],"b":1}');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  try {
    const meta = writePacks(dir, {structures: {x: [1, 2]}, site: {roads: []}});
    assert.match(meta.packs.structures.file, /^structures\.[0-9a-f]{12}\.json$/);
    assert.deepEqual(readPacks(dir), {site: {roads: []}, structures: {x: [1, 2]}});
    fs.writeFileSync(path.join(dir, meta.packs.site.file), '{"roads":[1]}');
    assert.throws(() => readPacks(dir), /differs/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
  const a = {h: 10, ring: [[0, 0]], name: 'Hall'};
  assert.equal(recordHashes(a).g, recordHashes({...a, name: 'Other'}).g);
  assert.notEqual(recordHashes(a).g, recordHashes({...a, h: 11}).g);
  assert.deepEqual(diffRecords({a, b: a}, {a: {...a, name: 'X'}, c: a}), {added: ['c'], removed: ['b'], shape: [], label: ['a']});
  assert.equal(Math.abs(ringArea([[0, 0], [2, 0], [2, 2], [0, 0]])), 2);
});
