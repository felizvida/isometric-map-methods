// Step 7: the sky for any moment: where the sun is (and how long the shadows are), the moon's place and phase, and
// which stars are up. Everything is computed; only the star list is data (sample/stars.json, CC0).
//   node tutorial/step7-sky.mjs [--date=2026-06-21T12:00:00-04:00]
import fs from 'node:fs';
import {sunPosition, moonPosition, starPosition, starVisibility, lightWeights} from '../methods/sky.mjs';
import {loadSample, SAMPLE_DIR, pipeline} from './lib.mjs';
import {options} from './args.mjs';

const o = options({date: '2026-06-21T12:00:00-04:00'});
const date = new Date(o.date);
if (Number.isNaN(date.getTime())) throw new Error('--date must be an ISO date and time, e.g. 2026-12-21T16:30:00-05:00');
const {terrain} = loadSample();
const lat = terrain.frame.origin_lat, lon = terrain.frame.origin_lon;

const sun = sunPosition(date, lat, lon), w = lightWeights(sun.elevation);
console.log(`${date.toISOString()} at ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
console.log(`Sun: elevation ${sun.elevation.toFixed(2)}°, azimuth ${sun.azimuth.toFixed(2)}° (equation of time ${sun.equationOfTime.toFixed(1)} min)`);
console.log(`Light weights: sun ${w.sun.toFixed(2)}, warm ${w.warm.toFixed(2)}, night ${w.night.toFixed(2)}`);
if (sun.elevation > 0) {
  const tall = pipeline().blocks.reduce((m, b) => (b.height > m.height ? b : m));
  console.log(`The ${tall.height} m building casts a shadow ${(tall.height / Math.tan(sun.elevation * Math.PI / 180)).toFixed(1)} m long, towards ${((sun.azimuth + 180) % 360).toFixed(0)}°`);
}
const moon = moonPosition(date, lat, lon);
const phaseName = ['new', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full', 'waning gibbous', 'last quarter', 'waning crescent'][Math.round(moon.phase * 8) % 8];
console.log(`Moon: elevation ${moon.elevation.toFixed(1)}°, azimuth ${moon.azimuth.toFixed(1)}°, ${phaseName}, ${(100 * moon.illuminated).toFixed(0)} % lit`);

const stars = JSON.parse(fs.readFileSync(new URL('stars.json', `file://${SAMPLE_DIR}/`), 'utf8')).stars;
const solarHour = ((date.getUTCHours() + date.getUTCMinutes() / 60 + lon / 15) % 24 + 24) % 24;
const vis = starVisibility({localHour: solarHour, sunElevation: sun.elevation, moonElevation: moon.elevation, moonIlluminated: moon.illuminated});
const up = stars.filter(([ra, dec]) => starPosition(ra, dec, date, lat, lon).elevation > 0);
const shown = up.filter(([, , v]) => v <= vis.limit);
console.log(`Stars: ${up.length} of ${stars.length} above the horizon; limit magnitude ${vis.limit.toFixed(1)}, twilight factor ${vis.twilight.toFixed(2)} -> ` +
            `${vis.twilight > 0 ? shown.length : 0} drawn`);
const brightest = [...up].sort((a, b) => a[2] - b[2]).slice(0, 3)
  .map(([ra, dec, v]) => { const p = starPosition(ra, dec, date, lat, lon); return `mag ${v} at ${p.elevation.toFixed(0)}° up, azimuth ${p.azimuth.toFixed(0)}°`; });
console.log('Brightest up now:', brightest.join('; '));
