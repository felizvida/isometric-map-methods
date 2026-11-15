#!/usr/bin/env node
// Step 2 of the toolkit: turn the sources (or the bundled sample) into layers, a scene, and a map you can open.
//
//   node toolkit/build.mjs --sample --out=work/sample                    # the bundled open-data sample, offline
//   node toolkit/build.mjs --source=work/myarea/source --out=work/myarea # downloaded sources (by hand or fetch.mjs)
//   node toolkit/build.mjs --layers=work/mylayers --out=work/mymap         # layer files you made or edited
//
// Writes <out>/layers/ (features, structures, terrain: the tutorial's formats), <out>/scene/ (content-addressed packs and
// meta.json; see methods/packs.mjs), <out>/map.html (a self-contained viewer: open it in a browser, no server needed)
// and <out>/summary.json. Options: --name=label --tolerance=0.25 (terrain mesh, metres) --no-stars, and --bbox=W,S,E,N
// for a source folder without provenance.json. A source folder holds osm.json (Overpass JSON) or map.osm (OSM XML),
// optional structures-N.geojson pages, and dem.tif (bare-earth GeoTIFF, float, lon/lat placement).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {osmToFeatures, structuresToFeatures, osmXmlToJson} from './lib/osm.mjs';
import {terrainFromTiff} from './lib/terrain.mjs';
import {loadLayers, buildScene} from './lib/scene.mjs';
import {standaloneHTML} from './lib/bundle.mjs';
import {writePacks} from '../methods/packs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');

function args() {
  const o = {tolerance: 0.25};
  for (const a of process.argv.slice(2)) {
    if (a === '--sample') { o.sample = true; continue; }
    if (a === '--no-stars') { o.noStars = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) throw new Error(`unknown argument ${a}`);
    o[m[1]] = m[1] === 'tolerance' ? Number(m[2]) : m[2];
  }
  if (!o.out || [o.sample, o.source, o.layers].filter(Boolean).length !== 1) throw new Error('usage: node toolkit/build.mjs (--sample | --source=DIR [--bbox=W,S,E,N] | --layers=DIR) --out=DIR [--name=..] [--tolerance=0.25] [--no-stars]');
  if (o.bbox) {
    o.bbox = o.bbox.split(',').map(Number);
    if (o.bbox.length !== 4 || o.bbox.some((v) => !Number.isFinite(v)) || o.bbox[0] >= o.bbox[2] || o.bbox[1] >= o.bbox[3]) throw new Error('--bbox must be W,S,E,N in degrees');
  }
  return o;
}

/** A source folder (downloaded by hand or by fetch.mjs) -> the three layer files. */
export function layersFromSource(source, dest, bboxArg = null) {
  const provFile = path.join(source, 'provenance.json');
  const prov = fs.existsSync(provFile) ? JSON.parse(fs.readFileSync(provFile, 'utf8')) : {files: {}};
  const bbox = bboxArg || prov.bbox;
  if (!bbox) throw new Error('no bbox: give --bbox=W,S,E,N (the area you downloaded) or a provenance.json');
  fs.mkdirSync(dest, {recursive: true});
  const xmlFile = path.join(source, 'map.osm'), jsonFile = path.join(source, 'osm.json');
  if (!fs.existsSync(jsonFile) && !fs.existsSync(xmlFile)) throw new Error(`no OpenStreetMap data: put osm.json or map.osm in ${source}`);
  if (!fs.existsSync(path.join(source, 'dem.tif'))) throw new Error(`no elevation: put a bare-earth GeoTIFF (float, lon/lat) at ${path.join(source, 'dem.tif')}`);
  const osm = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, 'utf8')) : osmXmlToJson(fs.readFileSync(xmlFile, 'utf8'));
  fs.writeFileSync(path.join(dest, 'features.geojson'), JSON.stringify(osmToFeatures(osm, bbox), null, 1) + '\n');
  const pages = fs.readdirSync(source).filter((f) => /^structures-\d+\.geojson$/.test(f)).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(source, f), 'utf8')));
  fs.writeFileSync(path.join(dest, 'structures.geojson'), JSON.stringify(structuresToFeatures(pages, bbox), null, 1) + '\n');
  const dem = (prov.files || {})['dem.tif'] || {};
  const terrain = terrainFromTiff(fs.readFileSync(path.join(source, 'dem.tif')), bbox, {source: {retrieved: dem.retrieved, sha256: dem.sha256}});
  fs.writeFileSync(path.join(dest, 'terrain.json'), JSON.stringify(terrain) + '\n');
  return dest;
}

async function main() {
  const o = args();
  const layersDir = o.sample ? path.join(ROOT, 'sample') : o.layers ? path.resolve(o.layers) : layersFromSource(o.source, path.join(o.out, 'layers'), o.bbox);
  const starsFile = path.join(ROOT, 'sample/stars.json');
  const stars = !o.noStars && fs.existsSync(starsFile) ? JSON.parse(fs.readFileSync(starsFile, 'utf8')) : null;
  const t0 = Date.now();
  const {packs, summary} = buildScene(loadLayers(layersDir), {name: o.name || path.basename(path.resolve(o.out)), stars, tolerance: o.tolerance});
  const meta = writePacks(path.join(o.out, 'scene'), packs);
  const html = standaloneHTML(path.join(HERE, 'viewer/index.html'), path.join(HERE, 'viewer/viewer.mjs'), {packs, manifest: meta});
  fs.writeFileSync(path.join(o.out, 'map.html'), html);
  fs.writeFileSync(path.join(o.out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  console.log(JSON.stringify(summary));
  console.log(`layers: ${layersDir}\nscene:  ${path.join(o.out, 'scene')} (${Object.keys(meta.packs).length} packs)\nmap:    ${path.join(o.out, 'map.html')} ` +
              `(${(html.length / 1e6).toFixed(2)} MB; open it in a browser)  [${((Date.now() - t0) / 1000).toFixed(1)} s]`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(process.env.DEBUG ? e.stack : e.message); process.exit(1); });
