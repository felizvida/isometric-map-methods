#!/usr/bin/env node
// Step 3 (optional) of the toolkit: a still isometric picture of any layers folder, with the tutorial's software
// renderer (z-buffer, one camera, no GPU). Useful for reports and for checking a build without a browser.
//
//   node toolkit/render.mjs --layers=work/myarea/layers --out=work/myarea/preview.png [--heading=45] [--width=1200] [--height=900]
//   node toolkit/render.mjs --layers=sample --out=work/sample/preview.png
import fs from 'node:fs';
import path from 'node:path';
import {pipeline, encodePNG} from '../tutorial/lib.mjs';

const o = {heading: 45, width: 1200, height: 900, tolerance: 0.25, exaggeration: 1};
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z]+)=(.*)$/.exec(a);
  if (!m) throw new Error(`unknown argument ${a}`);
  o[m[1]] = ['layers', 'out'].includes(m[1]) ? m[2] : Number(m[2]);
}
if (!o.layers || !o.out) throw new Error('usage: node toolkit/render.mjs --layers=DIR --out=FILE.png [--heading=45] [--width=1200] [--height=900]');
const r = pipeline({dir: path.resolve(o.layers), heading: o.heading * Math.PI / 180, width: o.width, height: o.height,
                    tolerance: o.tolerance, exaggeration: o.exaggeration});
fs.mkdirSync(path.dirname(path.resolve(o.out)), {recursive: true});
fs.writeFileSync(o.out, encodePNG(r.image.rgba, r.image.width, r.image.height));
console.log(`${r.blocks.length} buildings, ${r.image.triangles} triangles -> ${o.out}`);
