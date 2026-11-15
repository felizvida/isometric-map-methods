// A GeoTIFF elevation raster (WGS84 lon/lat placement) -> the tutorial's terrain grid format (sample-terrain/1):
// nodes every `cell` metres in a local tangent plane around an origin, stored as integer centimetres above a base.
import {readTiff} from './tiff.mjs';

const A = 6378137, E2 = 0.00669437999014;                          // WGS84

/** Metres per degree of longitude (kx) and latitude (ky) at latitude lat0, and the conversions. */
export function tangentPlane(lon0, lat0) {
  const phi = lat0 * Math.PI / 180, s2 = Math.sin(phi) ** 2;
  const kx = A * Math.cos(phi) / Math.sqrt(1 - E2 * s2) * Math.PI / 180;
  const ky = A * (1 - E2) / (1 - E2 * s2) ** 1.5 * Math.PI / 180;
  return {kx, ky, toLocal: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky], toLonLat: (x, y) => [lon0 + x / kx, lat0 + y / ky]};
}

/** Bilinear sampler over a GeoTIFF in lon/lat degrees. Returns NaN outside or at no-data. */
export function tiffSampler(buf) {
  const t = readTiff(buf);
  if (!t.geo) throw new Error('the raster has no GeoTIFF placement');
  const half = t.pixelIsPoint ? 0 : 0.5;
  return {raster: {width: t.width, height: t.height, compression: t.compression, nodata: t.nodata}, at(lon, lat) {
    const c = (lon - t.geo.x) / t.geo.sx + t.geo.i - half, r = (t.geo.y - lat) / t.geo.sy + t.geo.j - half;
    const c0 = Math.floor(c), r0 = Math.floor(r);
    if (c0 < 0 || r0 < 0 || c0 + 1 >= t.width || r0 + 1 >= t.height) return NaN;
    const fc = c - c0, fr = r - r0, d = t.data, k = r0 * t.width + c0;
    const v = [d[k], d[k + 1], d[k + t.width], d[k + t.width + 1]];
    if (v.some((z) => !Number.isFinite(z) || z === t.nodata || z < -1000)) return NaN;
    return (v[0] * (1 - fc) + v[1] * fc) * (1 - fr) + (v[2] * (1 - fc) + v[3] * fc) * fr;
  }};
}

/** Grid the raster over bbox [W, S, E, N] with the origin at the bbox centre. */
export function terrainFromTiff(buf, bbox, {cell = 2, datum = 'NAVD88', source = {}} = {}) {
  const [W, S, E, N] = bbox, lon0 = +((W + E) / 2).toFixed(6), lat0 = +((S + N) / 2).toFixed(6);
  const tp = tangentPlane(lon0, lat0), smp = tiffSampler(buf);
  const [xa, ya] = tp.toLocal(W, S), [xb, yb] = tp.toLocal(E, N);
  const x0 = Math.floor(xa / cell) * cell, y0 = Math.floor(ya / cell) * cell;
  const nx = Math.ceil((xb - x0) / cell) + 1, ny = Math.ceil((yb - y0) / cell) + 1;
  const z = [];
  let lowest = Infinity;                                             // a loop, not Math.min(...grid): grids reach 10^6 nodes
  for (let j = 0; j < ny; j++) {
    const row = [];
    for (let i = 0; i < nx; i++) {
      const v = smp.at(...tp.toLonLat(x0 + i * cell, y0 + j * cell));
      if (!Number.isFinite(v)) throw new Error(`no elevation at node ${i},${j}: request a slightly larger raster`);
      row.push(v);
      if (v < lowest) lowest = v;
    }
    z.push(row);
  }
  const base = Math.floor(lowest);
  return {format: 'sample-terrain/1', description: 'Bare-earth elevation on a regular grid of nodes in the local frame below.',
          frame: {type: 'local tangent plane', ellipsoid: 'WGS84', origin_lon: lon0, origin_lat: lat0,
                  x: 'metres east of the origin', y: 'metres north of the origin'},
          cell_m: cell, x0, y0, nx, ny, rows: 'z[j][i] is the node at x = x0 + i * cell_m, y = y0 + j * cell_m',
          vertical: {datum, unit: 'centimetres above z_base_m'}, z_base_m: base,
          z: z.map((row) => row.map((v) => Math.round((v - base) * 100))),
          license: 'Public domain (U.S. Government work)',
          credit: 'Map services and data available from U.S. Geological Survey, National Geospatial Program.',
          source: {name: 'USGS 3D Elevation Program (3DEP) via the 3DEPElevation image service', raster: smp.raster, ...source}};
}
