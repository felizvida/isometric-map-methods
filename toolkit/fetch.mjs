#!/usr/bin/env node
// Optional: download the three public sources for a small area into <out>/source/ by script.
// Checked 2026-11-15: all three hosts refuse automated access through robots.txt (Overpass disallows /api/interpreter;
// the other two answer 403), so this script stops by design. Download by hand instead (toolkit/README.md).
//
//   node toolkit/fetch.mjs --bbox=W,S,E,N --out=work/myarea [--sources=osm,structures,terrain] [--dry-run]
//
// Sources (read their terms before reusing the data; see public-docs/DATA_SOURCES.md):
//   osm         OpenStreetMap through the Overpass API (ODbL; attribution "© OpenStreetMap contributors")
//   structures  USA Structures footprints with heights (CC BY 4.0; ORNL and FEMA Geospatial Response Office)
//   terrain     USGS 3DEP bare-earth elevation, float32 GeoTIFF at about 1 m (public domain)
// Every host's robots.txt is read first, and a path it disallows is never requested. Requests are few and small; the
// area is capped (default 4 km2). Existing files are kept, so a rerun only fetches what is missing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {overpassQuery} from './lib/osm.mjs';

const UA = 'isometric-map-methods-toolkit/1.0 (+https://github.com/felizvida/isometric-map-methods)';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const STRUCTURES = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0';
const DEP = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';

export function args(argv = process.argv.slice(2)) {
  const o = {sources: 'osm,structures,terrain', maxKm2: 4};
  for (const a of argv) {
    if (a === '--dry-run') { o.dryRun = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) throw new Error(`unknown argument ${a}`);
    o[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[2];
  }
  if (!o.bbox || !o.out) throw new Error('usage: node toolkit/fetch.mjs --bbox=W,S,E,N --out=DIR [--sources=osm,structures,terrain] [--dry-run]');
  const b = o.bbox.split(',').map(Number);
  if (b.length !== 4 || b.some((v) => !Number.isFinite(v)) || b[0] >= b[2] || b[1] >= b[3] || Math.abs(b[1]) > 85 || Math.abs(b[3]) > 85) throw new Error('bbox must be W,S,E,N in degrees');
  const km2 = (b[2] - b[0]) * 111.32 * Math.cos((b[1] + b[3]) / 2 * Math.PI / 180) * (b[3] - b[1]) * 110.57;
  if (km2 > Number(o.maxKm2)) throw new Error(`bbox is ${km2.toFixed(2)} km2; the cap is ${o.maxKm2} km2 (--max-km2=N to change it, politely)`);
  return {...o, bbox: b, km2, sources: o.sources.split(',')};
}

// ------------------------------------------------------------------ robots.txt (RFC 9309, the parts that matter here)
const robotsCache = new Map();
let http = (...a) => fetch(...a);                                  // replaceable for tests (run(..., {fetchImpl}))
let log = (...a) => console.log(...a);
export function robotsAllows(text, pathname, agent = 'isometric-map-methods-toolkit') {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = {agents: [], rules: []}; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      cur.rules.push({allow: key === 'allow', path: val}); lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathname) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function checkRobots(url, dryRun) {
  const u = new URL(url);
  if (dryRun) { log(`  would read ${u.origin}/robots.txt and refuse ${u.pathname} if disallowed`); return; }
  if (!robotsCache.has(u.origin)) {
    let r;
    try { r = await http(u.origin + '/robots.txt', {headers: {'User-Agent': UA}}); }
    catch (e) { throw new Error(`could not read ${u.origin}/robots.txt (${e.message}); not requesting anything there`); }
    robotsCache.set(u.origin, robotsFromResponse(u.origin, r.status, r.ok ? await r.text() : ''));
  }
  if (!robotsAllows(robotsCache.get(u.origin), u.pathname)) throw new Error(`robots.txt of ${u.origin} disallows ${u.pathname}; not requesting it`);
}

/**
 * What a robots.txt response means, failing closed: 2xx gives its rules; 404 or 410 means there is no robots.txt, so
 * everything is allowed; anything else (401/403, which may be a bot wall, 429, 5xx) stops all requests to that host.
 * This is stricter than RFC 9309, which lets crawlers treat every 4xx as "no rules".
 */
export function robotsFromResponse(origin, status, text) {
  if (status >= 200 && status < 300) return text;
  if (status === 404 || status === 410) return '';
  throw new Error(`${origin}/robots.txt answered ${status}; not requesting anything there (try again later, never work around it)`);
}

async function get(url, {method = 'GET', body = null, binary = false, dryRun = false} = {}) {
  await checkRobots(url, dryRun);
  if (dryRun) { log(`  ${method} ${url}${body ? '  (body: ' + body.slice(0, 80) + '...)' : ''}`); return null; }
  for (let attempt = 1; ; attempt++) {
    const r = await http(url, {method, body, headers: {'User-Agent': UA, ...(body ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})}});
    if (r.ok) return binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
    if (attempt >= 3 || ![429, 502, 503, 504].includes(r.status)) throw new Error(`${r.status} from ${url}`);
    await new Promise((res) => setTimeout(res, 5000 * attempt));
  }
}

/** Parse a service's JSON answer; an error object or a missing list is a failure, never "no features". */
export function parseServiceJSON(text, listKey, what) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${what}: the answer is not JSON (${text.slice(0, 120)})`); }
  if (j && j.error) throw new Error(`${what}: the service reported an error: ${JSON.stringify(j.error).slice(0, 200)}`);
  if (!j || !Array.isArray(j[listKey])) throw new Error(`${what}: the answer has no "${listKey}" list`);
  if (listKey === 'elements' && /error/i.test(j.remark || '')) throw new Error(`${what}: incomplete answer: ${j.remark}`);
  return j;
}

/** A TIFF starts with II*\0, MM\0* or (BigTIFF) II+\0 / MM\0+; anything else (an HTML or JSON error page) is refused. */
export function isTiff(buf) {
  if (!buf || buf.length < 8) return false;
  const h = buf.subarray(0, 4).toString('latin1');
  return h === 'II*\0' || h === 'MM\0*' || h === 'II+\0' || h === 'MM\0+';
}

/**
 * Download into <out>/source/. Provenance (time, bytes, SHA-256, licence) is written after every file, so an interrupted
 * run never leaves an unrecorded file. On a rerun a file is reused only if provenance.json records it with the same
 * bytes and hash; an unrecorded or changed file refuses. A folder made for a different bbox refuses. Structures pages
 * resume from the first page not yet verified, and are complete only when a page holds fewer than 2000 features.
 */
export async function run(o, {fetchImpl = null, logger = null} = {}) {
  if (fetchImpl) http = fetchImpl;
  if (logger) log = logger;
  robotsCache.clear();
  const dir = path.join(o.out, 'source');
  const [W, S, E, N] = o.bbox;
  log(`area ${o.km2.toFixed(3)} km2 -> ${dir}`);
  if (!o.dryRun) fs.mkdirSync(dir, {recursive: true});
  const provFile = path.join(dir, 'provenance.json');
  const prov = fs.existsSync(provFile) ? JSON.parse(fs.readFileSync(provFile, 'utf8')) : {bbox: o.bbox, files: {}};
  if (!Array.isArray(prov.bbox) || prov.bbox.length !== 4 || prov.bbox.some((v, k) => Math.abs(v - o.bbox[k]) > 1e-9)) {
    throw new Error(`${dir} was made for bbox ${prov.bbox}, not ${o.bbox.join(',')}: use a new --out`);
  }
  const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
  const writeProv = () => {
    const tmp = provFile + '.part';
    fs.writeFileSync(tmp, JSON.stringify(prov, null, 1) + '\n');
    fs.renameSync(tmp, provFile);
  };
  const save = (name, data, meta) => {
    fs.writeFileSync(path.join(dir, name), data);
    prov.files[name] = {retrieved: new Date().toISOString(), bytes: Buffer.byteLength(data), sha256: sha(data), ...meta};
    writeProv();
    log(`  saved ${name} (${Buffer.byteLength(data)} bytes)`);
  };
  /** true if the file exists and matches its provenance; throws if it exists without matching provenance. */
  const have = (name) => {
    if (o.dryRun) return false;
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) return false;
    const rec = prov.files[name], data = fs.readFileSync(f);
    if (!rec || rec.bytes !== data.length || rec.sha256 !== sha(data)) {
      throw new Error(`${f} exists but provenance.json does not record it with this content; delete it or use a new --out`);
    }
    log(`  have ${name} (verified)`);
    return true;
  };

  if (o.sources.includes('osm') && !have('osm.json')) {
    const text = await get(OVERPASS, {method: 'POST', body: 'data=' + encodeURIComponent(overpassQuery(o.bbox)), dryRun: o.dryRun});
    if (text !== null) {
      parseServiceJSON(text, 'elements', 'Overpass');
      save('osm.json', text, {source: 'OpenStreetMap via Overpass API', license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', url: OVERPASS});
    }
  }
  if (o.sources.includes('structures')) {
    for (let page = 0; ; page++) {
      if (page >= 20) throw new Error('more than 20 pages of structures: choose a smaller box');
      const name = `structures-${page}.geojson`;
      let n;
      if (have(name)) n = parseServiceJSON(fs.readFileSync(path.join(dir, name), 'utf8'), 'features', name).features.length;
      else {
        const q = new URLSearchParams({where: '1=1', geometry: `${W},${S},${E},${N}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
          spatialRel: 'esriSpatialRelIntersects', outFields: 'HEIGHT,OCC_CLS,SOURCE,IMAGE_DATE,VAL_METHOD', returnGeometry: 'true',
          outSR: '4326', orderByFields: 'OBJECTID', resultOffset: String(page * 2000), resultRecordCount: '2000', f: 'geojson'});
        const text = await get(`${STRUCTURES}/query?${q}`, {dryRun: o.dryRun});
        if (text === null) break;
        n = parseServiceJSON(text, 'features', `USA Structures page ${page}`).features.length;
        save(name, text, {source: 'USA Structures (ORNL, FEMA Geospatial Response Office)', license: 'CC-BY-4.0', url: STRUCTURES, page});
      }
      if (n < 2000) {
        if (!o.dryRun) { prov.structuresComplete = page + 1; writeProv(); }
        break;
      }
    }
  }
  if (o.sources.includes('terrain') && !have('dem.tif')) {
    // a 20 m margin so every grid node has four raster neighbours; about 1 m pixels, uncompressed float32
    const mx = 20 / (111320 * Math.cos((S + N) / 2 * Math.PI / 180)), my = 20 / 110570;
    const bb = [W - mx, S - my, E + mx, N + my];
    const w = Math.min(4000, Math.ceil((bb[2] - bb[0]) * 111320 * Math.cos((S + N) / 2 * Math.PI / 180)));
    const h = Math.min(4000, Math.ceil((bb[3] - bb[1]) * 110570));
    const q = new URLSearchParams({bbox: bb.join(','), bboxSR: '4326', imageSR: '4326', size: `${w},${h}`, format: 'tiff', pixelType: 'F32',
      compression: 'None', interpolation: 'RSP_BilinearInterpolation', noDataInterpretation: 'esriNoDataMatchAny', f: 'image'});
    const tif = await get(`${DEP}/exportImage?${q}`, {binary: true, dryRun: o.dryRun});
    if (tif) {
      if (!isTiff(tif)) throw new Error(`3DEP: the answer is not a TIFF (${tif.subarray(0, 120).toString('latin1')})`);
      save('dem.tif', tif, {source: 'USGS 3DEP bare-earth DEM (3DEPElevation image service)', license: 'public-domain',
                            credit: 'Map services and data available from U.S. Geological Survey, National Geospatial Program.', url: DEP});
    }
  }
  log(o.dryRun ? 'dry run: nothing requested' : `done. Next: node toolkit/build.mjs --source=${dir} --out=${o.out}`);
  return prov;
}

async function main() {
  await run(args());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
