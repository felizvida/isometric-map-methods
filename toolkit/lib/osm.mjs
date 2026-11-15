// OpenStreetMap (Overpass JSON with `out geom`) -> a trimmed GeoJSON layer with one generic `kind` per feature.
// Keeps geometry and a few descriptive tags (levels, height, roof shape, widths, surface); drops names, addresses and
// every other tag. Coordinates stay WGS84 lon/lat, rounded to 7 decimals (about 1 cm).

const NDP = 1e7;
const rnd = (p) => [Math.round(p[0] * NDP) / NDP, Math.round(p[1] * NDP) / NDP];

/** The generic kind of an OSM element from its tags, or null to skip it. */
export function kindOf(t, type = 'way') {
  if (type === 'node') {
    if (t.natural === 'tree') return 'tree';
    if (OPENINGS.has(t.barrier) || t.entrance) return 'opening';
    return null;
  }
  if (t.building && t.building !== 'no') return 'building';
  if (t.barrier === 'fence' || t.barrier === 'wall' || t.barrier === 'hedge' || t.barrier === 'retaining_wall') return t.barrier === 'retaining_wall' ? 'wall' : t.barrier;
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  if (t.leisure === 'playground') return 'playground';
  if (t.leisure === 'pitch') return 'pitch';
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'basin') return 'water';
  if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
  if (t.landuse === 'grass' || t.landuse === 'meadow' || t.leisure === 'common') return 'grass';
  if (t.amenity === 'parking' && !t.building) return 'parking';
  if (t.waterway === 'stream' || t.waterway === 'ditch') return 'stream';
  const h = t.highway;
  if (h === 'footway') return {sidewalk: 'sidewalk', crossing: 'crossing'}[t.footway] || 'footway';
  if (h === 'pedestrian' || h === 'steps') return 'footway';
  if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street'].includes(h)) return 'road';
  if (h === 'service' || h === 'cycleway' || h === 'path' || h === 'track') return h === 'track' ? 'path' : h;
  return null;
}

export const OPENINGS = new Set(['gate', 'swing_gate', 'sliding_gate', 'lift_gate', 'kissing_gate', 'turnstile',
  'full-height_turnstile', 'entrance', 'bollard', 'cycle_barrier', 'stile']);

const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : undefined; };

/** Overpass JSON -> FeatureCollection. bbox [W, S, E, N] keeps only features touching it. */
export function osmToFeatures(osm, bbox) {
  const [W, S, E, N] = bbox, feats = [];
  const touches = (pts) => pts.some(([x, y]) => x >= W && x <= E && y >= S && y <= N);
  for (const e of osm.elements || []) {
    const t = e.tags || {};
    const kind = kindOf(t, e.type);
    if (!kind) continue;
    const props = {kind, osm: `${e.type}/${e.id}`};
    if (e.type === 'node') {
      if (!touches([[e.lon, e.lat]])) continue;
      if (kind === 'opening') { props.barrier = t.barrier || 'entrance'; const w = num(t.width) ?? num(t.maxwidth); if (w) props.width = w; }
      feats.push({type: 'Feature', properties: props, geometry: {type: 'Point', coordinates: rnd([e.lon, e.lat])}});
      continue;
    }
    if (e.type !== 'way' || !e.geometry) continue;
    const pts = e.geometry.map((g) => [g.lon, g.lat]);
    if (!touches(pts)) continue;
    const closed = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    if (kind === 'building') {
      if (!closed) continue;
      const lv = num(t['building:levels']); if (lv) props.levels = lv;
      const h = num(t.height); if (h) props.height = h;
      if (t['roof:shape']) props.roof_shape = t['roof:shape'];
      const rh = num(t['roof:height']); if (rh) props.roof_height = rh;
      if (t.building !== 'yes') props.building = t.building;
      feats.push({type: 'Feature', properties: props, geometry: {type: 'Polygon', coordinates: [pts.map(rnd)]}});
    } else if (['park', 'playground', 'pitch', 'water', 'wood', 'grass', 'parking'].includes(kind)) {
      if (!closed) continue;
      if (kind === 'pitch' && t.sport) props.sport = t.sport;
      feats.push({type: 'Feature', properties: props, geometry: {type: 'Polygon', coordinates: [pts.map(rnd)]}});
    } else {
      if (t.surface) props.surface = t.surface;
      const w = num(t.width); if (w) props.width = w;
      const lanes = num(t.lanes); if (lanes) props.lanes = lanes;
      if (t.oneway === 'yes') props.oneway = true;
      if (t.bridge === 'yes') props.bridge = true;
      if (t.tunnel === 'yes') continue;                                // tunnels are not on the surface
      if (kind === 'road') props.road = t.highway;
      feats.push({type: 'Feature', properties: props, geometry: {type: 'LineString', coordinates: pts.map(rnd)}});
    }
  }
  const order = ['grass', 'wood', 'park', 'water', 'parking', 'playground', 'pitch', 'stream', 'road', 'service', 'cycleway',
                 'path', 'footway', 'sidewalk', 'crossing', 'fence', 'wall', 'hedge', 'building', 'tree', 'opening'];
  feats.sort((a, b) => order.indexOf(a.properties.kind) - order.indexOf(b.properties.kind) || (a.properties.osm < b.properties.osm ? -1 : 1));
  return {type: 'FeatureCollection', bbox, license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors',
          source: {name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright', snapshot: osm.osm3s?.timestamp_osm_base ?? null, via: 'Overpass API'},
          note: 'Geometry and a few generic tags only; names, addresses and all other tags removed. WGS84 lon/lat.', features: feats};
}

/**
 * OpenStreetMap XML (the `map.osm` file from the Export page of openstreetmap.org, or any OSM XML extract) -> the same
 * shape as Overpass JSON with `out geom`, so osmToFeatures reads both. Nodes, ways and tags only; relations (for
 * example multipolygon buildings) are skipped.
 */
export function osmXmlToJson(xml) {
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
  const attr = (s, k) => { const m = new RegExp(`\\s${k}="([^"]*)"`).exec(s); return m ? unescape(m[1]) : undefined; };
  const tagsOf = (body) => Object.fromEntries([...body.matchAll(/<tag\s[^>]*?k="([^"]*)"[^>]*?v="([^"]*)"[^>]*\/>/g)].map((m) => [unescape(m[1]), unescape(m[2])]));
  const nodes = new Map(), elements = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
    const id = Number(attr(m[1], 'id')), lat = Number(attr(m[1], 'lat')), lon = Number(attr(m[1], 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    nodes.set(id, {lat, lon});
    const tags = m[3] ? tagsOf(m[3]) : {};
    if (Object.keys(tags).length) elements.push({type: 'node', id, lat, lon, tags});
  }
  for (const m of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
    const refs = [...m[2].matchAll(/<nd\s[^>]*?ref="(\d+)"/g)].map((r) => Number(r[1]));
    if (refs.some((r) => !nodes.has(r))) continue;                    // a way cut by the export box: skip it whole
    elements.push({type: 'way', id: Number(attr(m[1], 'id')), tags: tagsOf(m[2]), geometry: refs.map((r) => nodes.get(r))});
  }
  const ts = /<osm\b[^>]*\stimestamp="([^"]*)"/.exec(xml) || /<meta\b[^>]*\sosm_base="([^"]*)"/.exec(xml);
  return {osm3s: {timestamp_osm_base: ts ? ts[1] : null}, elements};
}

/** The Overpass query for a bbox [W, S, E, N]. */
export function overpassQuery([W, S, E, N]) {
  const b = `(${S},${W},${N},${E})`;
  return `[out:json][timeout:90];(way["building"]${b};way["highway"]${b};way["leisure"]${b};way["landuse"]${b};` +
         `way["natural"]${b};way["waterway"]${b};way["amenity"="parking"]${b};way["barrier"]${b};node["barrier"]${b};` +
         `node["entrance"]${b};node["natural"="tree"]${b};);out geom;`;
}

/** USA Structures GeoJSON pages -> trimmed FeatureCollection (height and four descriptive fields). */
export function structuresToFeatures(pages, bbox) {
  const [W, S, E, N] = bbox, feats = [];
  const day = (v) => { if (v == null || v === '') return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };   // epoch ms (service) or a date string (GIS export)
  for (const page of pages) for (const f of page.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
    if (!ring) continue;
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    if (cx < W || cx > E || cy < S || cy > N) continue;
    const p = f.properties || {};
    feats.push({type: 'Feature', properties: {height_m: p.HEIGHT ?? null, occupancy_class: p.OCC_CLS ?? null, source: p.SOURCE ?? null,
                                              image_date: day(p.IMAGE_DATE), validation: p.VAL_METHOD ?? null},
                geometry: {type: 'Polygon', coordinates: [ring.map((q) => rnd(q))]}});
  }
  feats.sort((a, b) => a.geometry.coordinates[0][0][0] - b.geometry.coordinates[0][0][0] || a.geometry.coordinates[0][0][1] - b.geometry.coordinates[0][0][1]);
  return {type: 'FeatureCollection', bbox, license: 'CC-BY-4.0',
          attribution: 'USA Structures: Oak Ridge National Laboratory (ORNL) and FEMA Geospatial Response Office',
          source: {name: 'USA Structures', page: 'https://gis-fema.hub.arcgis.com/datasets/fedmaps::usa-structures/about'},
          note: 'Footprints whose centroid lies in the bbox; height and four descriptive fields only. WGS84 lon/lat.', features: feats};
}
