import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {osmToFeatures, structuresToFeatures, kindOf, osmXmlToJson} from '../toolkit/lib/osm.mjs';
import {layersFromSource} from '../toolkit/build.mjs';
import {terrainFromTiff} from '../toolkit/lib/terrain.mjs';
import {loadLayers, buildScene} from '../toolkit/lib/scene.mjs';
import {bundleModules} from '../toolkit/lib/bundle.mjs';
import {robotsAllows, robotsFromResponse, run as fetchRun, args as fetchArgs, parseServiceJSON, isTiff} from '../toolkit/fetch.mjs';
import {roofLevels, bestFlatHeight} from '../methods/lidar.mjs';
import {mainNetwork} from '../methods/graph.mjs';
import {readPacks} from '../methods/packs.mjs';
import {SegmentHash, crossing} from '../methods/collision.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A tiny uncompressed float32 GeoTIFF (classic, little endian) with placement tags. */
function geotiff(w, h, f, {x0, y0, sx, sy}) {
  const entries = [[256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 32], [259, 3, 1, 1], [273, 4, 1, 0], [277, 3, 1, 1],
                   [278, 3, 1, h], [279, 4, 1, w * h * 4], [339, 3, 1, 3], [33550, 12, 3, 0], [33922, 12, 6, 0]];
  const ifd = 8, n = entries.length, extra = ifd + 2 + n * 12 + 4, scale = extra, tie = scale + 24, data = tie + 48;
  const buf = Buffer.alloc(data + w * h * 4);
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifd, 4); buf.writeUInt16LE(n, ifd);
  entries.forEach(([tag, type, count, value], k) => {
    const e = ifd + 2 + k * 12;
    buf.writeUInt16LE(tag, e); buf.writeUInt16LE(type, e + 2); buf.writeUInt32LE(count, e + 4);
    if (tag === 273) buf.writeUInt32LE(data, e + 8);
    else if (tag === 33550) buf.writeUInt32LE(scale, e + 8);
    else if (tag === 33922) buf.writeUInt32LE(tie, e + 8);
    else if (type === 3) buf.writeUInt16LE(value, e + 8);
    else buf.writeUInt32LE(value, e + 8);
  });
  [sx, sy, 0].forEach((v, k) => buf.writeDoubleLE(v, scale + 8 * k));
  [0, 0, 0, x0, y0, 0].forEach((v, k) => buf.writeDoubleLE(v, tie + 8 * k));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) buf.writeFloatLE(f(x0 + (i + 0.5) * sx, y0 - (j + 0.5) * sy), data + 4 * (j * w + i));
  return buf;
}

test('OSM and structures conversion keeps geometry and generic tags only', () => {
  const osm = {osm3s: {timestamp_osm_base: '2026-01-01T00:00:00Z'}, elements: [
    {type: 'way', id: 1, tags: {building: 'apartments', 'building:levels': '4', name: 'Somebody House', 'addr:street': 'X'},
     geometry: [{lon: 0, lat: 0}, {lon: 0.0002, lat: 0}, {lon: 0.0002, lat: 0.0001}, {lon: 0, lat: 0.0001}, {lon: 0, lat: 0}]},
    {type: 'way', id: 2, tags: {highway: 'residential', name: 'Main St', lanes: '2'}, geometry: [{lon: -0.001, lat: 0.0005}, {lon: 0.001, lat: 0.0005}]},
    {type: 'way', id: 3, tags: {highway: 'service', tunnel: 'yes'}, geometry: [{lon: 0, lat: 0}, {lon: 0.0001, lat: 0}]},
    {type: 'node', id: 4, lon: 0.0001, lat: 0.0003, tags: {barrier: 'gate', width: '3'}},
    {type: 'node', id: 5, lon: 0.0001, lat: 0.0004, tags: {natural: 'tree'}},
    {type: 'way', id: 6, tags: {amenity: 'school'}, geometry: [{lon: 0, lat: 0}, {lon: 1, lat: 1}]},
  ]};
  const fc = osmToFeatures(osm, [-0.01, -0.01, 0.01, 0.01]);
  assert.deepEqual(fc.features.map((f) => f.properties.kind), ['road', 'building', 'tree', 'opening']);
  const text = JSON.stringify(fc);
  assert.ok(!text.includes('Somebody') && !text.includes('Main St') && !text.includes('addr:'));
  assert.equal(fc.features[1].properties.levels, 4);
  assert.equal(fc.features[3].properties.width, 3);
  assert.equal(kindOf({highway: 'footway', footway: 'sidewalk'}), 'sidewalk');
  const sc = structuresToFeatures([{features: [{properties: {HEIGHT: 9, OCC_CLS: 'Residential', ADDRESS: 'secret', SOURCE: 'x', IMAGE_DATE: 0, VAL_METHOD: 'Unverified'},
    geometry: {type: 'Polygon', coordinates: [[[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0]]]}}]}], [-1, -1, 1, 1]);
  assert.equal(sc.features[0].properties.height_m, 9);
  assert.ok(!JSON.stringify(sc).includes('secret'));
});

test('a GeoTIFF becomes the terrain grid format', () => {
  const plane = (lon, lat) => 100 + lon * 1000 + lat * 2000;
  const tif = geotiff(40, 40, plane, {x0: -0.002, y0: 0.002, sx: 0.0001, sy: 0.0001});
  const t = terrainFromTiff(tif, [-0.001, -0.001, 0.001, 0.001]);
  assert.equal(t.format, 'sample-terrain/1');
  assert.ok(t.nx > 100 && t.ny > 100);
  const z = (i, j) => t.z_base_m + t.z[j][i] / 100;
  // a plane stays a plane: equal steps along a row
  assert.ok(Math.abs((z(2, 5) - z(1, 5)) - (z(1, 5) - z(0, 5))) < 0.02);
  assert.throws(() => terrainFromTiff(tif, [-0.0035, -0.001, 0.001, 0.001]), /no elevation/);
});

test('grid-sized inputs do not overflow the call stack (a 1.2 km2 terrain, 300k lidar samples, many components)', () => {
  const tif = geotiff(160, 160, (lon, lat) => 100 + 300 * lat, {x0: -0.008, y0: 0.008, sx: 0.0001, sy: 0.0001});
  const t = terrainFromTiff(tif, [-0.005, -0.005, 0.005, 0.005]);
  assert.ok(t.nx * t.ny > 300000, `only ${t.nx * t.ny} nodes`);
  assert.equal(t.z_base_m, Math.floor(100 + 300 * -0.005));
  const samples = Array.from({length: 300000}, (_, k) => (k % 3 ? 12 : 6) + (k % 7) * 0.01);
  assert.equal(Math.round(roofLevels(samples).roof), 12);
  assert.ok(Number.isFinite(bestFlatHeight(samples).z));
  const nodes = Array.from({length: 200000}, (_, k) => ({x: k, y: 0, out: []}));
  assert.equal(mainNetwork({nodes, edges: []}).length, 200000);
});

/** A scripted stand-in for fetch(): routes by URL, records calls. */
function mockHttp(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [re, answer] of routes) if (re.test(url)) {
      const a = typeof answer === 'function' ? answer(url) : answer;
      const body = Buffer.isBuffer(a.body) ? a.body : Buffer.from(a.body ?? '');
      return {ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => body.toString('utf8'),
              arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)};
    }
    throw new Error('unexpected request ' + url);
  };
  return {impl, calls};
}

test('fetch keeps provenance through a partial run, verifies reuse, and refuses errors, tampering and a different bbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  const quiet = () => {};
  const tif = geotiff(4, 4, () => 50, {x0: -0.001, y0: 0.001, sx: 0.0005, sy: 0.0005});
  const osm = JSON.stringify({elements: [], osm3s: {timestamp_osm_base: 'x'}});
  const feats = JSON.stringify({type: 'FeatureCollection', features: []});
  const o = fetchArgs(['--bbox=-0.001,-0.001,0.001,0.001', `--out=${dir}`]);
  try {
    // 1. Overpass works, the structures host refuses: osm.json is saved AND recorded before the failure
    let m = mockHttp([[/robots\.txt$/, (u) => ({status: u.includes('arcgis') ? 403 : 404})], [/interpreter/, {status: 200, body: osm}]]);
    await assert.rejects(fetchRun(o, {fetchImpl: m.impl, logger: quiet}), /answered 403/);
    const prov = JSON.parse(fs.readFileSync(path.join(dir, 'source/provenance.json'), 'utf8'));
    assert.ok(prov.files['osm.json'].sha256 && prov.files['osm.json'].license === 'ODbL-1.0');
    // 2. a structures error body is a failure, not an empty page; nothing is saved for it
    m = mockHttp([[/robots\.txt$/, {status: 404}], [/query\?/, {status: 200, body: '{"error":{"code":500,"message":"busy"}}'}]]);
    await assert.rejects(fetchRun(o, {fetchImpl: m.impl, logger: quiet}), /reported an error/);
    assert.ok(!fs.existsSync(path.join(dir, 'source/structures-0.geojson')));
    assert.ok(!m.calls.some((u) => u.includes('interpreter')), 'verified osm.json was reused');
    // 3. a 3DEP answer that is not a TIFF is refused
    m = mockHttp([[/robots\.txt$/, {status: 404}], [/query\?/, {status: 200, body: feats}], [/exportImage/, {status: 200, body: '{"error":{}}'}]]);
    await assert.rejects(fetchRun(o, {fetchImpl: m.impl, logger: quiet}), /not a TIFF/);
    // 4. everything works: verified files are reused, the rest is fetched, structures marked complete
    m = mockHttp([[/robots\.txt$/, {status: 404}], [/exportImage/, {status: 200, body: tif}]]);
    const done = await fetchRun(o, {fetchImpl: m.impl, logger: quiet});
    assert.equal(done.structuresComplete, 1);
    assert.deepEqual(Object.keys(done.files).sort(), ['dem.tif', 'osm.json', 'structures-0.geojson']);
    assert.ok(isTiff(fs.readFileSync(path.join(dir, 'source/dem.tif'))));
    // 5. a changed file, or a different bbox, refuses
    fs.appendFileSync(path.join(dir, 'source/osm.json'), ' ');
    await assert.rejects(fetchRun(o, {fetchImpl: mockHttp([]).impl, logger: quiet}), /does not record it/);
    await assert.rejects(fetchRun(fetchArgs(['--bbox=-0.002,-0.001,0.001,0.001', `--out=${dir}`]), {fetchImpl: mockHttp([]).impl, logger: quiet}), /use a new --out/);
    assert.throws(() => parseServiceJSON('<html>', 'features', 'x'), /not JSON/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('robots.txt rules: longest match wins, Allow breaks ties, wildcards and anchors', () => {
  const r = 'User-agent: *\nDisallow: /private/\nAllow: /private/open/\nDisallow: /*.json$\n\nUser-agent: other\nDisallow: /';
  assert.equal(robotsAllows(r, '/api/interpreter'), true);
  assert.equal(robotsAllows(r, '/private/x'), false);
  assert.equal(robotsAllows(r, '/private/open/x'), true);
  assert.equal(robotsAllows(r, '/a/b.json'), false);
  assert.equal(robotsAllows(r, '/a/b.json5'), true);
  assert.equal(robotsAllows('', '/anything'), true);
});

test('a hand-downloaded source folder (map.osm, structures GeoJSON, dem.tif, --bbox) builds the same layers', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test" timestamp="2026-01-01T00:00:00Z">
 <bounds minlat="-0.001" minlon="-0.001" maxlat="0.001" maxlon="0.001"/>
 <node id="1" lat="0" lon="0"/><node id="2" lat="0" lon="0.0002"/><node id="3" lat="0.0001" lon="0.0002"/><node id="4" lat="0.0001" lon="0"/>
 <node id="5" lat="0.0005" lon="-0.0009"/><node id="6" lat="0.0005" lon="0.0009"/>
 <node id="7" lat="0.0003" lon="0.0001"><tag k="barrier" v="gate"/><tag k="width" v="3"/></node>
 <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="apartments"/><tag k="building:levels" v="4"/><tag k="name" v="A &amp; B"/></way>
 <way id="11"><nd ref="5"/><nd ref="6"/><tag k="highway" v="residential"/></way>
 <way id="12"><nd ref="5"/><nd ref="99"/><tag k="highway" v="footway"/></way>
</osm>`;
  const j = osmXmlToJson(xml);
  assert.equal(j.osm3s.timestamp_osm_base, '2026-01-01T00:00:00Z');
  assert.deepEqual(j.elements.map((e) => `${e.type}/${e.id}`), ['node/7', 'way/10', 'way/11']);   // way 12 is cut by the box
  assert.equal(j.elements[1].tags.name, 'A & B');
  const fc = osmToFeatures(j, [-0.01, -0.01, 0.01, 0.01]);
  assert.deepEqual(fc.features.map((f) => f.properties.kind), ['road', 'building', 'opening']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-'));
  try {
    const src = path.join(dir, 'source');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'map.osm'), xml);
    fs.writeFileSync(path.join(src, 'dem.tif'), geotiff(40, 40, () => 50, {x0: -0.002, y0: 0.002, sx: 0.0001, sy: 0.0001}));
    assert.throws(() => layersFromSource(src, path.join(dir, 'layers')), /no bbox/);
    const layers = layersFromSource(src, path.join(dir, 'layers'), [-0.001, -0.001, 0.001, 0.001]);
    const built = buildScene(loadLayers(layers), {name: 'manual'});
    assert.equal(built.summary.buildings, 1);
    assert.equal(built.packs.buildings.records[0].source, 'levels');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('robots.txt responses fail closed: only 404 and 410 mean "no rules"', () => {
  assert.equal(robotsFromResponse('https://h', 200, 'User-agent: *\nDisallow: /x'), 'User-agent: *\nDisallow: /x');
  assert.equal(robotsFromResponse('https://h', 404, ''), '');
  assert.equal(robotsFromResponse('https://h', 410, ''), '');
  for (const status of [301, 401, 403, 429, 500, 503]) assert.throws(() => robotsFromResponse('https://h', status, ''), /answered/);
});

test('the sample scene: deterministic packs, a crack-free terrain and a walking network that never crosses a wall', () => {
  const layers = loadLayers(path.join(ROOT, 'sample'));
  const a = buildScene(layers, {name: 'sample'}), b = buildScene(layers, {name: 'sample'});
  assert.equal(JSON.stringify(a.packs), JSON.stringify(b.packs));
  assert.equal(a.summary.terrain.cracks, 0);
  assert.equal(a.summary.buildings, 3);
  assert.deepEqual(a.packs.buildings.records.map((r) => r.source).sort(), ['default', 'structures', 'structures']);
  const {walk} = a.packs, hash = new SegmentHash(8);
  for (const w of walk.walls) hash.add({ax: w[0], ay: w[1], bx: w[2], by: w[3]});
  for (const [ia, ib, , off] of walk.edges) {
    const [ax, ay] = walk.nodes[ia], [bx, by] = walk.nodes[ib], L = Math.hypot(bx - ax, by - ay) || 1;
    const p = [ax + (by - ay) / L * off, ay - (bx - ax) / L * off], q = [bx + (by - ay) / L * off, by - (bx - ax) / L * off];
    assert.ok(!hash.near((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, L / 2 + 1).some((s) => crossing(p, q, s) !== null), 'edge crosses a wall');
  }
  assert.ok(walk.main.some(Boolean));
});

test('build writes packs that verify, and a standalone map with no imports or remote resources', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'toolkit/build.mjs'), '--sample', `--out=${out}`], {stdio: 'pipe'});
    const packs = readPacks(path.join(out, 'scene'));
    assert.deepEqual(Object.keys(packs).sort(), ['buildings', 'ground', 'info', 'sky', 'terrain', 'trees', 'walk']);
    const html = fs.readFileSync(path.join(out, 'map.html'), 'utf8');
    assert.ok(!/^\s*import\s/m.test(html), 'bundle left an import');
    assert.ok(!/<(script|link|img)[^>]+(src|href)="(https?:)?\/\//.test(html), 'remote resource');
    assert.ok(!/fetch\(\s*['"]https?:/.test(html));
    assert.match(bundleModules(path.join(ROOT, 'toolkit/viewer/viewer.mjs')), /const M\d+ = \(\(\) => \{/);
  } finally {
    fs.rmSync(out, {recursive: true, force: true});
  }
});
