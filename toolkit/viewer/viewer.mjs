// The toolkit's map viewer: an isometric map you can turn, zoom and click, with the real sun, moon and stars for any
// date and time, seasons, shadows, and a ground-level walk that can never pass through a wall.
// Data: window.SCENE (from toolkit/build.mjs map.html) or ?scene=<folder with meta.json> when served over http.
import {sunPosition, moonPosition, siderealTime, lightWeights, starVisibility, seasonWeights, dayOfYear, direction,
        equatorialToLocal, smoothstep} from '../../methods/sky.mjs';
import {SegmentHash, sweep, pushOut} from '../../methods/collision.mjs';
import {aStar} from '../../methods/graph.mjs';
import {ISOMETRIC_TILT} from '../../methods/projection.mjs';
import {mul, ortho, perspective, lookAt, invert, unproject, program, mesh, shadowTarget, vec} from './gl.mjs';
import {LIT_VS, LIT_FS, DEPTH_VS, DEPTH_FS, ID_VS, ID_FS, SKY_VS, SKY_FS, STAR_VS, STAR_FS, MOON_VS, MOON_FS} from './shaders.mjs';

const $ = (id) => document.getElementById(id);
const D = Math.PI / 180;
const WINDOW_STYLES = [                   // must follow STYLE_INDEX in toolkit/lib/scene.mjs: [bay m, x0, x1, y0, y1]
  [3.2, 0.26, 0.74, 0.30, 0.80], [1.6, 0, 1, 0.36, 0.80], [1.5, 0, 1, 0.06, 0.94], [3.0, 0.34, 0.66, 0.26, 0.84],
  [2.8, 0.17, 0.83, 0.32, 0.80], [3.6, 0.32, 0.68, 0.36, 0.80], [3.2, 0.22, 0.78, 0.30, 0.82], [7.5, 0.05, 0.95, 0.30, 0.86],
  [6.0, 0.20, 0.80, 0.72, 0.86], [4.0, 0.40, 0.60, 0.16, 0.86]];
const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
const mix3 = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
const SKY = {dayTop: hex('#a7c3dc'), dayBottom: hex('#e6ece4'), goldTop: hex('#93a7c9'), goldBottom: hex('#f2c79e'),
             nightTop: hex('#0b1120'), nightBottom: hex('#1c2742')};

async function loadScene() {
  if (window.SCENE) return window.SCENE.packs;
  const base = new URLSearchParams(location.search).get('scene');
  if (!base) throw new Error('No scene: open the map.html that toolkit/build.mjs wrote, or serve the repository and add ?scene=<folder>.');
  const url = (f) => new URL(f, new URL(base.replace(/\/?$/, '/'), location.href)).href;
  const meta = await (await fetch(url('meta.json'), {cache: 'no-cache'})).json();
  const packs = {};
  for (const [name, e] of Object.entries(meta.packs)) {
    if (!/^[a-z][a-z0-9-]*\.[0-9a-f]{12}\.json$/.test(e.file)) throw new Error('bad pack name ' + e.file);
    const text = await (await fetch(url(e.file))).text();
    if (crypto.subtle) {
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hash !== e.sha256) throw new Error(`pack ${name} does not match its manifest`);
    }
    packs[name] = JSON.parse(text);
  }
  return packs;
}

function terrainSampler(t) {
  const at = (x, y) => {
    const fi = Math.min(t.nx - 1.000001, Math.max(0, (x - t.x0) / t.cell)), fj = Math.min(t.ny - 1.000001, Math.max(0, (y - t.y0) / t.cell));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j, z = t.heights;
    return (z[j][i] * (1 - u) + z[j][i + 1] * u) * (1 - v) + (z[j + 1][i] * (1 - u) + z[j + 1][i + 1] * u) * v;
  };
  const normal = (x, y) => {
    const e = Math.max(2.5, t.cell);
    const n = [-(at(x + e, y) - at(x - e, y)) / (2 * e), -(at(x, y + e) - at(x, y - e)) / (2 * e), 1], l = Math.hypot(...n);
    return n.map((v) => v / l);
  };
  return {at, normal};
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, ya] = ring[a], [xb, yb] = ring[b];
    if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

/** Low-poly trees: hexagonal trunk, icosahedral crown (deciduous) or two cones (conifer). */
function treeGeometry(trees, ground) {
  const pos = [], nrm = [], col = [], fac = [], ids = [], idx = [];
  const t0 = (1 + Math.sqrt(5)) / 2;
  const ico = [[-1, t0, 0], [1, t0, 0], [-1, -t0, 0], [1, -t0, 0], [0, -1, t0], [0, 1, t0], [0, -1, -t0], [0, 1, -t0], [t0, 0, -1], [t0, 0, 1], [-t0, 0, -1], [-t0, 0, 1]].map(vec.norm);
  const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const tri = (a, b, c, f) => {
    const n = vec.norm(vec.cross(vec.sub(b, a), vec.sub(c, a))), k = pos.length / 3;
    for (const p of [a, b, c]) { pos.push(...p); nrm.push(...n); col.push(0.36, 0.28, 0.2); fac.push(...f); ids.push(0); }
    idx.push(k, k + 1, k + 2);
  };
  for (const t of trees) {
    const z = ground.at(t.x, t.y) - 0.2, seed = (t.seed % 1000) / 1000, trunkH = t.conifer ? 0.25 * t.h : 0.42 * t.h, tr = Math.max(0.15, 0.06 * t.r);
    for (let k = 0; k < 6; k++) {
      const a0 = k * Math.PI / 3, a1 = (k + 1) * Math.PI / 3;
      const p0 = [t.x + tr * Math.cos(a0), t.y + tr * Math.sin(a0)], p1 = [t.x + tr * Math.cos(a1), t.y + tr * Math.sin(a1)];
      tri([...p0, z], [...p1, z], [...p1, z + trunkH + 0.5], [seed, 0, 0, 0]);
      tri([...p0, z], [...p1, z + trunkH + 0.5], [...p0, z + trunkH + 0.5], [seed, 0, 0, 0]);
    }
    if (t.conifer) {
      for (const [zb, zt, rb] of [[z + trunkH, z + 0.72 * t.h, t.r], [z + 0.5 * t.h, z + t.h, 0.7 * t.r]]) {
        for (let k = 0; k < 7; k++) {
          const a0 = k * 2 * Math.PI / 7, a1 = (k + 1) * 2 * Math.PI / 7;
          tri([t.x + rb * Math.cos(a0), t.y + rb * Math.sin(a0), zb], [t.x + rb * Math.cos(a1), t.y + rb * Math.sin(a1), zb], [t.x, t.y, zt], [seed, 1, 1, 0]);
        }
      }
    } else {
      const cz = z + trunkH + (t.h - trunkH) / 2, rz = (t.h - trunkH) / 2;
      for (const [a, b, c] of faces) {
        const P = (v) => [t.x + v[0] * t.r, t.y + v[1] * t.r, cz + v[2] * rz];
        tri(P(ico[a]), P(ico[b]), P(ico[c]), [seed, 1, 0, 0]);
      }
    }
  }
  return {pos, nrm, col, fac, ids, idx};
}

async function main() {
  const S = await loadScene();
  const canvas = $('map'), gl = canvas.getContext('webgl2', {antialias: true, preserveDrawingBuffer: true});
  if (!gl) throw new Error('This browser has no WebGL2.');
  $('name').textContent = S.info.name;
  $('credit').textContent = 'Data: ' + S.info.attribution.join(' · ');
  const ground = terrainSampler(S.terrain);
  const [bx0, by0, bx1, by1] = S.info.bounds, centre = [(bx0 + bx1) / 2, (by0 + by1) / 2];
  const {lon, lat} = S.info.origin;

  // ---------------------------------------------------------------- programs and meshes
  const lit = program(gl, LIT_VS, LIT_FS), depth = program(gl, DEPTH_VS, DEPTH_FS), pick = program(gl, ID_VS, ID_FS);
  const sky = program(gl, SKY_VS, SKY_FS), starP = program(gl, STAR_VS, STAR_FS), moonP = program(gl, MOON_VS, MOON_FS);
  const progs = [lit, depth, pick];
  const tp = S.terrain.mesh.positions, tn = [];
  for (let k = 0; k < tp.length; k += 3) tn.push(...ground.normal(tp[k], tp[k + 1]));
  const terrainMesh = mesh(gl, {a_pos: {data: tp, size: 3}, a_nrm: {data: tn, size: 3}}, S.terrain.mesh.indices, progs);
  const B = S.buildings.mesh;
  const buildingMesh = mesh(gl, {a_pos: {data: B.positions, size: 3}, a_nrm: {data: B.normals, size: 3}, a_col: {data: B.colours.map((c) => c / 255), size: 3},
                                 a_fac: {data: B.facade, size: 4}, a_id: {data: B.ids, size: 1}}, B.indices, progs);
  const T = treeGeometry(S.trees, ground);
  const treeMesh = T.idx.length ? mesh(gl, {a_pos: {data: T.pos, size: 3}, a_nrm: {data: T.nrm, size: 3}, a_col: {data: T.col, size: 3},
                                             a_fac: {data: T.fac, size: 4}, a_id: {data: T.ids, size: 1}}, T.idx, progs) : null;
  const quad = gl.createVertexArray();
  gl.bindVertexArray(quad);
  const qb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, qb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(sky.attrib('a_xy'));
  gl.vertexAttribPointer(sky.attrib('a_xy'), 2, gl.FLOAT, false, 0, 0);
  const stars = S.sky ? S.sky.stars : [];
  const starVao = gl.createVertexArray();
  if (stars.length) {
    gl.bindVertexArray(starVao);
    const dirs = [], mags = [];
    for (const [ra, dec, v] of stars) {
      dirs.push(Math.cos(dec * D) * Math.cos(ra * D), Math.cos(dec * D) * Math.sin(ra * D), Math.sin(dec * D));
      mags.push(v);
    }
    for (const [name, data, size] of [['a_dir', dirs, 3], ['a_mag', mags, 1]]) {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(starP.attrib(name));
      gl.vertexAttribPointer(starP.attrib(name), size, gl.FLOAT, false, 0, 0);
    }
  }
  const moonVao = gl.createVertexArray();
  gl.bindVertexArray(null);

  const groundTex = gl.createTexture();
  await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, groundTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      resolve();
    };
    img.onerror = () => reject(new Error('ground texture failed to decode'));
    img.src = 'data:image/png;base64,' + S.ground.png;
  });
  const shadow = shadowTarget(gl, Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE)));

  // ---------------------------------------------------------------- walls and the walking network
  const walls = new SegmentHash(8);
  for (const w of S.walk.walls) walls.add({ax: w[0], ay: w[1], bx: w[2], by: w[3]});
  const graph = {nodes: S.walk.nodes.map(([x, y]) => ({x, y, out: []})), edges: []};
  S.walk.edges.forEach(([a, b, cost, off]) => {
    graph.nodes[a].out.push(graph.edges.length);
    graph.edges.push({a, b, len: Math.hypot(graph.nodes[b].x - graph.nodes[a].x, graph.nodes[b].y - graph.nodes[a].y), cost, off});
  });
  const records = new Map(S.buildings.records.map((r) => [r.id, r]));
  const insideBuilding = (p) => S.buildings.records.find((r) => pointInRing(p, r.ring));
  const nearestMain = (x, y) => {
    let best = -1, bd = Infinity;
    graph.nodes.forEach((n, k) => { if (!S.walk.main[k]) return; const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = k; } });
    return {node: best, dist: bd};
  };

  // ---------------------------------------------------------------- state
  const view = {az: 225 * D, el: ISOMETRIC_TILT, zoom: 1, target: [...centre, ground.at(...centre)], turn: null};
  const walker = {on: false, x: 0, y: 0, z: 0, yaw: 0, pitch: -0.035, speed: 0, route: null, keys: new Set()};
  const clock = {daylight: false, date: new Date()};
  let W = 1, H = 1, dpr = 1;
  // a square area seen at 45 degrees is about 1.41 times its side wide on screen and 0.82 times tall (tilt 35.3 degrees)
  const fit = () => { const side = Math.max(bx1 - bx0, by1 - by0); return 0.92 * Math.min(W / (1.42 * side), (H - 120) / (0.9 * side)); };
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  resize();
  view.zoom = fit();
  window.addEventListener('resize', resize);

  const now = new Date();
  $('date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  $('hour').value = now.getHours() + now.getMinutes() / 60;
  const readClock = () => {
    const [y, m, d] = $('date').value.split('-').map(Number), h = Number($('hour').value);
    clock.date = new Date(y, m - 1, d, Math.floor(h), Math.round((h % 1) * 60));
  };
  readClock();
  $('hour').oninput = $('date').oninput = () => { clock.daylight = false; $('daylight').setAttribute('aria-pressed', 'false'); readClock(); };
  const toggleDaylight = () => {
    clock.daylight = !clock.daylight;
    $('daylight').setAttribute('aria-pressed', String(clock.daylight));
  };
  $('daylight').onclick = toggleDaylight;
  const turn = () => { const from = view.turn ? view.turn.to : view.az; view.turn = {from: view.az, to: from + Math.PI / 2, t0: performance.now()}; };
  $('turn').onclick = turn;
  $('walk').onclick = () => setWalk(!walker.on);

  function setWalk(on) {
    if (on) {
      let [x, y] = [view.target[0], view.target[1]];
      const near = nearestMain(x, y);
      if (insideBuilding([x, y]) || (near.node >= 0 && near.dist < 12)) {
        if (near.node < 0) return;
        x = graph.nodes[near.node].x; y = graph.nodes[near.node].y;
      }
      Object.assign(walker, {on: true, x, y, z: ground.at(x, y) + 1.7, yaw: view.az + Math.PI, pitch: -0.035, route: null, speed: 0});
    } else {
      walker.on = false;
      view.target = [walker.x, walker.y, ground.at(walker.x, walker.y)];
    }
    $('walk').setAttribute('aria-pressed', String(walker.on));
    $('walk').textContent = walker.on ? 'Map' : 'Walk';
  }

  // ---------------------------------------------------------------- cameras
  function mapCamera() {
    const D0 = 2000, {az, el, zoom, target} = view;
    const eye = [target[0] + D0 * Math.sin(az) * Math.cos(el), target[1] + D0 * Math.cos(az) * Math.cos(el), target[2] + D0 * Math.sin(el)];
    const v = lookAt(eye, target), p = ortho(-W / 2 / zoom, W / 2 / zoom, -H / 2 / zoom, H / 2 / zoom, 1, 4000);
    return {vp: mul(p, v), eye, persp: false, viewDir: vec.norm(vec.sub(eye, target))};
  }
  function walkCamera() {
    const fov = 68 * D, dir = [Math.sin(walker.yaw) * Math.cos(walker.pitch), Math.cos(walker.yaw) * Math.cos(walker.pitch), Math.sin(walker.pitch)];
    const eye = [walker.x, walker.y, walker.z], p = perspective(fov, W / H, 0.12, 2600);
    return {vp: mul(p, lookAt(eye, vec.sub(eye, dir.map((v) => -v)))), rvp: mul(p, lookAt([0, 0, 0], dir)), eye, persp: true, fov, viewDir: dir.map((v) => -v)};
  }
  const screenToGroundMap = (sx, sy) => {
    const inv = invert(mapCamera().vp), x = (sx / W) * 2 - 1, y = 1 - (sy / H) * 2;
    const a = unproject(inv, x, y, -1), b = unproject(inv, x, y, 1), t = (view.target[2] - a[2]) / (b[2] - a[2]);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  // ---------------------------------------------------------------- input
  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = {x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, rotate: e.button === 2 || e.shiftKey, moved: 0};
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY; drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0));
    if (walker.on) { walker.yaw += dx * 0.004; walker.pitch = Math.max(-70 * D, Math.min(60 * D, walker.pitch - dy * 0.004)); return; }
    if (drag.rotate) { view.az -= dx * 0.006; return; }
    const right = [-Math.cos(view.az), Math.sin(view.az)], fwd = [-Math.sin(view.az), -Math.cos(view.az)];   // screen right and up, on the ground
    view.target[0] += (-right[0] * dx + fwd[0] * dy / Math.sin(view.el)) / view.zoom;
    view.target[1] += (-right[1] * dx + fwd[1] * dy / Math.sin(view.el)) / view.zoom;
    view.target[0] = Math.min(bx1, Math.max(bx0, view.target[0]));
    view.target[1] = Math.min(by1, Math.max(by0, view.target[1]));
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && drag.moved < 5) click(e.clientX, e.clientY);
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (walker.on) return;
    const before = screenToGroundMap(e.clientX, e.clientY);
    view.zoom = Math.min(14, Math.max(fit() * 0.8, view.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016))));
    const after = screenToGroundMap(e.clientX, e.clientY);
    view.target[0] += before[0] - after[0]; view.target[1] += before[1] - after[1];
  }, {passive: false});
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'e') turn();
    else if (k === 'v') setWalk(!walker.on);
    else if (k === 'l') toggleDaylight();
    else if (k === 'escape') { if (walker.on) setWalk(false); $('card').style.display = 'none'; }
    walker.keys.add(k);
    if (walker.on && k.startsWith('arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => walker.keys.delete(e.key.toLowerCase()));

  function pickId(sx, sy, cam) {
    const fb = gl.createFramebuffer(), tex = gl.createTexture(), rb = gl.createRenderbuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, canvas.width, canvas.height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, canvas.width, canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(pick.p);
    gl.uniformMatrix4fv(pick.u.u_vp, false, cam.vp);
    terrainMesh.draw(pick); buildingMesh.draw(pick); if (treeMesh) treeMesh.draw(pick);
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(sx * dpr), Math.round(canvas.height - sy * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb); gl.deleteTexture(tex); gl.deleteRenderbuffer(rb);
    return px[3] ? px[0] + 256 * px[1] + 65536 * px[2] : -1;
  }

  function showCard(r) {
    const c = $('card');
    if (!r) { c.style.display = 'none'; return; }
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    c.innerHTML = `<h3>${r.type === 'yes' ? 'Building' : r.type[0].toUpperCase() + r.type.slice(1)}</h3><table>` +
      row('Height', `${r.height.toFixed(1)} m`) + row('Height from', {structures: 'USA Structures', levels: 'mapped levels', tag: 'mapped height', default: 'default (no data)', curated: 'checked by hand'}[r.source] || r.source) +
      row('Roof', r.roof) + row('Footprint', `${Math.round(r.area)} m²`) + row('Ground fall', `${(r.pad - r.base).toFixed(1)} m along the walls`) +
      (r.osm ? row('Mapped as', `OpenStreetMap ${r.osm}`) : '') + '</table>';
    c.style.display = 'block';
  }

  function click(sx, sy) {
    const cam = walker.on ? walkCamera() : mapCamera();
    const id = pickId(sx, sy, cam);
    if (id > 0) { showCard(records.get(id)); return; }
    showCard(null);
    if (!walker.on) return;
    // ray-march to the ground: step 0.5 + 0.02 t, then 12 bisections
    const inv = invert(cam.vp), x = (sx / W) * 2 - 1, y = 1 - (sy / H) * 2;
    const a = unproject(inv, x, y, -1), b = unproject(inv, x, y, 1), d = vec.norm(vec.sub(b, a));
    let t0 = 0, t1 = 0, hit = false;
    for (let t = 0.5; t < 600; t += 0.5 + 0.02 * t) {
      const p = a.map((v, k) => v + d[k] * t);
      if (p[2] < ground.at(p[0], p[1])) { t1 = t; hit = true; break; }
      t0 = t;
    }
    if (!hit) return;
    for (let k = 0; k < 12; k++) { const m = (t0 + t1) / 2, p = a.map((v, j) => v + d[j] * m); if (p[2] < ground.at(p[0], p[1])) t1 = m; else t0 = m; }
    const goal = a.map((v, k) => v + d[k] * t1);
    const from = nearestMain(walker.x, walker.y), to = nearestMain(goal[0], goal[1]);
    const route = from.node >= 0 && to.node >= 0 && to.dist < 40 ? aStar(graph, from.node, to.node, (e) => e.cost) : null;
    const pts = [];
    if (route) {
      for (const ei of route.edges) {
        const e = graph.edges[ei], A = graph.nodes[e.a], Bn = graph.nodes[e.b], L = e.len || 1;
        const ox = (Bn.y - A.y) / L * e.off, oy = -(Bn.x - A.x) / L * e.off;
        pts.push([A.x + ox, A.y + oy], [Bn.x + ox, Bn.y + oy]);
      }
    }
    pts.push([goal[0], goal[1]]);
    walker.route = {pts, k: 0};
  }

  // ---------------------------------------------------------------- simulation
  function stepWalker(dt) {
    let mx = 0, my = 0;
    const k = walker.keys, fwd = [Math.sin(walker.yaw), Math.cos(walker.yaw)], right = [Math.cos(walker.yaw), -Math.sin(walker.yaw)];
    const f = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const s = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
    if (k.has('arrowleft')) walker.yaw -= 1.7 * dt;
    if (k.has('arrowright')) walker.yaw += 1.7 * dt;
    if (f || s) {
      walker.route = null;
      const v = 1.4 * (k.has('shift') ? 2.3 : 1) * dt;
      mx = (fwd[0] * f + right[0] * s) * v; my = (fwd[1] * f + right[1] * s) * v;
    } else if (walker.route) {
      const r = walker.route;
      while (r.k < r.pts.length && Math.hypot(r.pts[r.k][0] - walker.x, r.pts[r.k][1] - walker.y) < 0.6) r.k++;
      if (r.k >= r.pts.length) walker.route = null;
      else {
        const [tx, ty] = r.pts[r.k], d = Math.hypot(tx - walker.x, ty - walker.y), v = Math.min(d, 1.35 * dt);
        mx = (tx - walker.x) / d * v; my = (ty - walker.y) / d * v;
        const want = Math.atan2(tx - walker.x, ty - walker.y);
        let dy = ((want - walker.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        walker.yaw += dy * Math.min(1, dt / 0.35);
      }
    }
    if (mx || my) {
      const p = sweep(walls, [walker.x, walker.y], [walker.x + mx, walker.y + my]);
      const q = pushOut(walls, [p.x, p.y], 0.3);
      // pushing out is swept too, so it can never carry the walker through another wall
      const r = sweep(walls, [p.x, p.y], q);
      walker.x = Math.min(bx1 - 1, Math.max(bx0 + 1, r.x)); walker.y = Math.min(by1 - 1, Math.max(by0 + 1, r.y));
    }
    const want = ground.at(walker.x, walker.y) + 1.7;
    walker.z += (want - walker.z) * Math.min(1, dt / 0.2);
    walker.z = Math.min(want + 0.5, Math.max(want - 0.5, walker.z));
  }

  // ---------------------------------------------------------------- lighting for the moment shown
  function environment() {
    let date = clock.date;
    if (clock.daylight) { const d = new Date(); d.setHours(12, 0, 0, 0); date = d; }
    const sun = sunPosition(date, lat, lon), moon = moonPosition(date, lat, lon), w = lightWeights(sun.elevation);
    const sunDir = direction(Math.max(9, sun.elevation), sun.azimuth);
    let ldir = sunDir, lcol = mix3([1, 0.94, 0.84], [1, 0.6, 0.34], w.warm).map((v) => v * 0.78 * w.sun), lightEl = sun.elevation;
    if (w.sun <= 0.04) {
      const illum = 0.35 + 0.65 * moon.illuminated;
      ldir = moon.elevation > 8.6 ? direction(moon.elevation, moon.azimuth) : direction(55, 200);
      lcol = [0.42, 0.52, 0.8].map((v) => v * 0.16 * illum);
      lightEl = moon.elevation > 8.6 ? moon.elevation : 55;
    }
    const top = mix3(mix3(SKY.dayTop, SKY.goldTop, w.warm), SKY.nightTop, w.night);
    const bottom = mix3(mix3(SKY.dayBottom, SKY.goldBottom, w.warm), SKY.nightBottom, w.night);
    const asky = mix3(mix3([0.62, 0.67, 0.75], [0.58, 0.5, 0.54], w.warm), [0.05, 0.07, 0.13], w.night);
    const agnd = mix3(mix3([0.44, 0.42, 0.37], [0.42, 0.33, 0.28], w.warm), [0.03, 0.035, 0.05], w.night);
    const solarHour = ((date.getUTCHours() + date.getUTCMinutes() / 60 + lon / 15) % 24 + 24) % 24;
    const vis = starVisibility({localHour: solarHour, sunElevation: sun.elevation, moonElevation: moon.elevation, moonIlluminated: moon.illuminated});
    const occupancy = 0.12 + 0.28 * smoothstep(16, 19, solarHour) * (1 - smoothstep(22, 24, solarHour));   // lit rooms: evenings busiest
    return {date, sun, moon, w, ldir, lcol, lightEl, top, bottom, asky, agnd, vis, occupancy, season: seasonWeights(dayOfYear(date))};
  }

  // ---------------------------------------------------------------- drawing
  function draw(env, cam) {
    // shadow pass: an orthographic light box over the whole area
    const r = Math.hypot(bx1 - bx0, by1 - by0) / 2 + 20, c = [...centre, ground.at(...centre)];
    const leye = c.map((v, k) => v + env.ldir[k] * 1500);
    const svp = mul(ortho(-r, r, -r, r, Math.max(1, 1400 - r), 1600 + r), lookAt(leye, c));
    const shadowsOn = env.lightEl > 2;
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.fb);
    gl.viewport(0, 0, shadow.size, shadow.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    if (shadowsOn) {
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 2.0);
      gl.useProgram(depth.p);
      gl.uniformMatrix4fv(depth.u.u_svp, false, svp);
      terrainMesh.draw(depth); buildingMesh.draw(depth); if (treeMesh) treeMesh.draw(depth);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(...env.bottom, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // sky
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(sky.p);
    gl.uniform3fv(sky.u.u_top, env.top); gl.uniform3fv(sky.u.u_bottom, env.bottom);
    gl.uniformMatrix4fv(sky.u.u_inv, false, invert(cam.vp)); gl.uniform1f(sky.u.u_persp, cam.persp ? 1 : 0);
    gl.bindVertexArray(quad); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.DEPTH_TEST);
    // scene
    gl.useProgram(lit.p);
    const u = lit.u;
    gl.uniformMatrix4fv(u.u_vp, false, cam.vp); gl.uniformMatrix4fv(u.u_svp, false, svp);
    gl.uniform3fv(u.u_ldir, env.ldir); gl.uniform3fv(u.u_lcol, env.lcol); gl.uniform3fv(u.u_asky, env.asky); gl.uniform3fv(u.u_agnd, env.agnd);
    gl.uniform3fv(u.u_eye, cam.eye); gl.uniform3fv(u.u_viewDir, cam.viewDir); gl.uniform3fv(u.u_horizon, env.bottom);
    gl.uniform1f(u.u_night, env.w.night); gl.uniform1f(u.u_fogk, 0.00032); gl.uniform1f(u.u_persp, cam.persp ? 1 : 0);
    gl.uniform1f(u.u_exposure, 1 + 0.6 * env.w.night); gl.uniform1f(u.u_occupancy, env.occupancy);
    gl.uniform4f(u.u_season, env.season.leaf, env.season.autumn, env.season.brown, env.season.bloom);
    gl.uniform1fv(u.u_sp, WINDOW_STYLES.map((s) => s[0]));
    gl.uniform4fv(u.u_win, WINDOW_STYLES.flatMap((s) => s.slice(1)));
    gl.uniform1f(u.u_shadowOn, shadowsOn ? 1 : 0); gl.uniform1f(u.u_texel, 1 / shadow.size);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, groundTex); gl.uniform1i(u.u_ground, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, shadow.tex); gl.uniform1i(u.u_shadow, 1);
    gl.uniform4f(u.u_grect, S.ground.x0, S.ground.y0, S.ground.w * S.ground.res, S.ground.h * S.ground.res);
    gl.uniform1i(u.u_mode, 1); terrainMesh.draw(lit);
    gl.uniform1i(u.u_mode, 0); buildingMesh.draw(lit);
    if (treeMesh) { gl.uniform1i(u.u_mode, 2); treeMesh.draw(lit); }
    // the night sky, seen only from the ground
    if (cam.persp) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
      const lst = siderealTime(env.date, lon).lst, M = equatorialToLocal(lst, lat);
      if (stars.length && env.vis.twilight > 0) {
        gl.useProgram(starP.p);
        gl.uniformMatrix3fv(starP.u.u_eq2w, false, new Float32Array([M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]));
        gl.uniformMatrix4fv(starP.u.u_rvp, false, cam.rvp);
        gl.uniform1f(starP.u.u_limit, env.vis.limit); gl.uniform1f(starP.u.u_vis, env.vis.twilight); gl.uniform1f(starP.u.u_scale, dpr);
        gl.bindVertexArray(starVao); gl.drawArrays(gl.POINTS, 0, stars.length);
      }
      if (env.moon.elevation > -1) {
        const el = env.moon.elevation * D, k = 2.1 - 0.8 * smoothstep(0, 0.6, el);
        gl.useProgram(moonP.p);
        gl.uniform3fv(moonP.u.u_dir, direction(env.moon.elevation, env.moon.azimuth));
        gl.uniformMatrix4fv(moonP.u.u_rvp, false, cam.rvp);
        gl.uniform1f(moonP.u.u_size, Math.max(3, 0.0091 * k / cam.fov * canvas.height));
        gl.uniform1f(moonP.u.u_illum, env.moon.illuminated); gl.uniform1f(moonP.u.u_waxing, env.moon.phase < 0.5 ? 1 : 0);
        gl.uniform1f(moonP.u.u_vis, 0.3 + 0.7 * smoothstep(2, -6, env.sun.elevation));
        gl.bindVertexArray(moonVao); gl.drawArrays(gl.POINTS, 0, 1);
      }
      gl.disable(gl.BLEND); gl.depthMask(true); gl.depthFunc(gl.LESS);
    }
    gl.bindVertexArray(null);
  }

  let last = performance.now();
  function frame(t) {
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    if (view.turn) {
      const f = Math.min(1, (t - view.turn.t0) / 700), e = f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2;
      view.az = view.turn.from + (view.turn.to - view.turn.from) * e;
      if (f >= 1) view.turn = null;
    }
    if (walker.on) stepWalker(dt);
    const env = environment();
    $('clock').textContent = env.date.toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) +
      ` · sun ${env.sun.elevation.toFixed(0)}°`;
    draw(env, walker.on ? walkCamera() : mapCamera());
    requestAnimationFrame(frame);
  }
  // Start-up options, for links and screenshots: #time=2026-06-21T18:30&daylight&az=135&zoom=2&walk=x,y,headingDeg
  // (or window.VIEWER_OPTIONS = {time, daylight, az, zoom, walk: [x, y, headingDeg, pitchDeg]} set before the viewer).
  const opt = {...Object.fromEntries(new URLSearchParams(location.hash.slice(1))), ...(window.VIEWER_OPTIONS || {})};
  if (opt.time) {
    const t = new Date(opt.time);
    if (!Number.isNaN(t.getTime())) {
      $('date').value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      $('hour').value = t.getHours() + t.getMinutes() / 60;
      readClock();
    }
  }
  if ('daylight' in opt && opt.daylight !== false && opt.daylight !== 'false') toggleDaylight();
  if (opt.az !== undefined) view.az = Number(opt.az) * D;
  if (opt.zoom !== undefined) view.zoom = fit() * Number(opt.zoom);
  if (opt.walk) {
    const [x, y, h = 0, p = -2] = (Array.isArray(opt.walk) ? opt.walk : String(opt.walk).split(',')).map(Number);
    view.target = [x, y, ground.at(x, y)];
    setWalk(true);
    Object.assign(walker, {x, y, z: ground.at(x, y) + 1.7, yaw: h * D, pitch: p * D});
  }
  window.viewer = {view, walker, clock, setWalk, environment, draw: () => draw(environment(), walker.on ? walkCamera() : mapCamera())};
  requestAnimationFrame(frame);
  draw(environment(), mapCamera());
}

main().catch((e) => { const el = $('err'); el.style.display = 'flex'; el.textContent = e.message; console.error(e); });
