// Step 5: the toolkit's building rules on the same sample: height by source priority, roof forms on an oriented box,
// seating on the slope, and facade bays. Same data as step 3, stricter and fuller rules (methods/buildings.mjs).
//   node tutorial/step5-buildings.mjs
import {loadLayers, buildScene} from '../toolkit/lib/scene.mjs';
import {orientedBox, chooseHeight, bayLayout, roofTriangles} from '../methods/buildings.mjs';
import {SAMPLE_DIR} from './lib.mjs';

const {packs} = buildScene(loadLayers(SAMPLE_DIR), {name: 'sample'});
console.log('Building            height  from         match  roof  fall along walls');
for (const r of packs.buildings.records) {
  console.log(`${r.osm.padEnd(18)} ${r.height.toFixed(2).padStart(6)} m  ${r.source.padEnd(11)} ${r.coverage.toFixed(2).padStart(5)}  ${r.roof.padEnd(5)} ${(r.pad - r.base).toFixed(2)} m`);
}

// Why does one building fall back to the default although a structure covers 81 % of it? The structures rule also
// asks that the two footprints have similar areas (0.55-1.8x), so a structure that also covers a neighbour is refused.
console.log('\nThe structures rule, three ways:');
for (const match of [{coverage: 0.9, areaRatio: 1.1, height: 17.4}, {coverage: 0.81, areaRatio: 2.4, height: 7.1}, {coverage: 0.4, areaRatio: 1, height: 7.1}]) {
  const h = chooseHeight({match, levels: null, storey: 3.5, defaultLevels: 2});
  console.log(`  coverage ${match.coverage}, area ratio ${match.areaRatio} -> ${h.height.toFixed(1)} m from ${h.source}`);
}

// Roof forms are built on the footprint's minimum-area rectangle; a footprint that fills less than 72 % of it keeps a flat roof.
const ring = packs.buildings.records[2].ring, box = orientedBox(ring);
console.log(`\nTallest footprint: box ${(2 * box.hu).toFixed(1)} x ${(2 * box.hv).toFixed(1)} m, fill ${box.fill.toFixed(2)} -> ` +
            (box.fill > 0.72 ? 'a pitched roof would fit' : 'too irregular for a pitched roof; flat'));
for (const shape of ['gabled', 'hipped', 'barrel']) console.log(`  ${shape.padEnd(7)} ${roofTriangles(box, 10, 13, shape).length} triangles`);

// Facade bays: an apartment front 30 m long and 17 m tall
const bays = bayLayout(30, 17.4, 'apartment', 3.0);
console.log(`\nFacade 30 m x 17.4 m, apartment style: ${bays.columns} bays of ${bays.bay.toFixed(2)} m, ${bays.storeys} storeys, ${bays.windows.length} windows`);
