// Airborne lidar for building heights: grid the points into surface and ground rasters, find roof levels, compare a
// model with the measurement, and classify each building. Points: {x, y, z, cls, ret, nret} with ASPRS classes
// (2 ground, 7 and 18 noise). No dependencies; rasters are row-major Float32Array with NaN for no data.

/** Minimum and maximum by a loop (spreading a large array into Math.min overflows the call stack). */
function range(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

/** Grid points into {dsm: highest non-noise return, dsm1: highest single return (roofs, little canopy), dtm: mean
 * ground, count} over bbox [x0, y0, x1, y1] at `cell` metres. */
export function rasterize(points, [x0, y0, x1, y1], cell = 0.5) {
  const w = Math.ceil((x1 - x0) / cell), h = Math.ceil((y1 - y0) / cell), n = w * h;
  const dsm = new Float32Array(n).fill(NaN), dsm1 = new Float32Array(n).fill(NaN), sum = new Float64Array(n), cnt = new Uint32Array(n), count = new Uint32Array(n);
  for (const p of points) {
    if (p.cls === 7 || p.cls === 18 || p.withheld) continue;
    const i = Math.floor((p.x - x0) / cell), j = Math.floor((p.y - y0) / cell);
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    const k = j * w + i;
    count[k]++;
    if (!(dsm[k] >= p.z)) dsm[k] = p.z;
    if (p.ret === 1 && p.nret === 1 && !(dsm1[k] >= p.z)) dsm1[k] = p.z;
    if (p.cls === 2) { sum[k] += p.z; cnt[k]++; }
  }
  const dtm = new Float32Array(n).map((_, k) => (cnt[k] ? sum[k] / cnt[k] : NaN));
  return {w, h, cell, x0, y0, dsm, dsm1, dtm, count};
}

/** Fill holes that touch data, up to `passes` cells deep, with the 3x3 maximum (surfaces) or mean (ground). */
export function fillHoles(grid, w, h, {passes = 2, mode = 'max'} = {}) {
  let cur = Float32Array.from(grid);
  for (let p = 0; p < passes; p++) {
    const next = Float32Array.from(cur);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!Number.isNaN(cur[j * w + i])) continue;
      let best = NaN, s = 0, c = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        const x = i + a, y = j + b;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const v = cur[y * w + x];
        if (Number.isNaN(v)) continue;
        if (!(best >= v)) best = v;
        s += v; c++;
      }
      if (c) next[j * w + i] = mode === 'max' ? best : s / c;
    }
    cur = next;
  }
  return cur;
}

/**
 * Roof levels from height samples (metres above the pad): a 0.25 m histogram smoothed with [0.25, 0.5, 0.25]; a peak
 * counts if at least 8 % of samples lie within +-0.75 m of it; each peak is refined to the mean of samples within
 * 0.3 m; peaks closer than 1 m merge; the 5 largest are kept. The roof is the largest level above 2.5 m (else the
 * median). Returns {levels: [{z, share}], roof}.
 */
export function roofLevels(samples, {bin = 0.25, window = 0.75, minShare = 0.08, refine = 0.3, merge = 1, keep = 5, high = 2.5} = {}) {
  if (!samples.length) return {levels: [], roof: NaN};
  const [lo, top] = range(samples), nb = Math.floor((top - lo) / bin) + 1;
  const hist = new Float64Array(nb);
  for (const z of samples) hist[Math.floor((z - lo) / bin)]++;
  const sm = hist.map((v, k) => 0.25 * (hist[k - 1] || 0) + 0.5 * v + 0.25 * (hist[k + 1] || 0));
  const peaks = [];
  for (let k = 0; k < nb; k++) {
    if (!(sm[k] > 0) || sm[k] < (sm[k - 1] ?? -1) || sm[k] < (sm[k + 1] ?? -1)) continue;
    const zc = lo + (k + 0.5) * bin;
    const share = samples.filter((z) => Math.abs(z - zc) <= window).length / samples.length;
    if (share < minShare) continue;
    const near = samples.filter((z) => Math.abs(z - zc) <= refine);
    peaks.push({z: near.length ? near.reduce((a, b) => a + b, 0) / near.length : zc, share, mass: sm[k]});
  }
  peaks.sort((a, b) => b.share - a.share || b.mass - a.mass);
  for (const p of peaks) delete p.mass;
  const levels = [];
  for (const p of peaks) if (!levels.some((q) => Math.abs(q.z - p.z) < merge)) levels.push(p);
  levels.splice(keep);
  const tall = levels.filter((l) => l.z > high);
  const sorted = [...samples].sort((a, b) => a - b);
  return {levels, roof: tall.length ? tall[0].z : sorted[Math.floor(sorted.length / 2)]};
}

/**
 * Compare measured and modelled heights at the same sample points (drop samples within one cell of a drawn edge
 * before calling). agree: |d| < 2 m; over: model higher by > 3 m; under: model lower by > 3 m.
 */
export function agreement(measured, modelled, {tol = 2, gross = 3} = {}) {
  let agree = 0, over = 0, under = 0, n = 0;
  for (let k = 0; k < measured.length; k++) {
    const m = measured[k], d = modelled[k];
    if (!Number.isFinite(m) || !Number.isFinite(d)) continue;
    n++;
    const diff = m - d;
    if (Math.abs(diff) < tol) agree++;
    if (diff < -gross) over++;
    if (diff > gross) under++;
  }
  return {n, agree: n ? agree / n : NaN, over: n ? over / n : NaN, under: n ? under / n : NaN};
}

/** The single flat height that explains most samples: the 0.5 m bin with most samples within +-2 m, refined to their
 * median. Returns {z, share}. */
export function bestFlatHeight(samples, {bin = 0.5, tol = 2} = {}) {
  if (!samples.length) return {z: NaN, share: 0};
  const [smin, smax] = range(samples), lo = Math.floor(smin), hi = Math.ceil(smax);
  let best = {z: NaN, share: -1};
  for (let z = lo; z <= hi; z += bin) {
    const near = samples.filter((s) => Math.abs(s - z) < tol);
    if (near.length / samples.length > best.share) {
      const v = near.sort((a, b) => a - b);
      best = {z: v[Math.floor(v.length / 2)], share: near.length / samples.length};
    }
  }
  return best;
}

/**
 * Audit class of one building: ok (agree >= 0.8), phantom (>= 70 % of the outline is bare ground in the lidar),
 * trees (canopy > 40 %), single-height fix (one flat height explains >= 80 %), or multi-level.
 */
export function auditClass({agree, groundShare = 0, canopyShare = 0, flatShare = 0}) {
  if (agree >= 0.8) return 'ok';
  if (groundShare >= 0.7) return 'phantom';
  if (canopyShare > 0.4) return 'trees';
  if (flatShare >= 0.8) return 'single-height';
  return 'multi-level';
}
