import test from 'node:test';
import assert from 'node:assert/strict';
import {sunPosition, moonPosition, siderealTime, starPosition, starVisibility, starSize, seasonWeights, lightWeights,
        dayOfYear, direction, smoothstep, equatorialToLocal} from '../methods/sky.mjs';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

test('the sun peaks at 90 - |lat - declination| and rises in the east at an equinox', () => {
  const lat = 40, lon = -75;
  let best = -90, decl = 0;
  for (let m = 0; m < 1440; m += 1) {
    const s = sunPosition(new Date(Date.UTC(2026, 5, 21, 0, m)), lat, lon);
    if (s.elevation > best) { best = s.elevation; decl = s.declination; }
  }
  close(decl, 23.44, 0.05, 'solstice declination');
  close(best, 90 - (lat - decl), 0.05, 'noon elevation');
  // March equinox: near sunrise the azimuth is close to due east
  let rise = null;
  for (let m = 0; m < 1440 && !rise; m++) {
    const s = sunPosition(new Date(Date.UTC(2026, 2, 20, 0, m)), lat, lon);
    if (s.elevation > 0) rise = s;
  }
  close(rise.azimuth, 90, 1.5, 'equinox sunrise azimuth');
});

test('equation of time has its known extremes', () => {
  close(sunPosition(new Date(Date.UTC(2026, 10, 3, 12)), 0, 0).equationOfTime, 16.4, 0.3, 'early November');
  close(sunPosition(new Date(Date.UTC(2026, 1, 11, 12)), 0, 0).equationOfTime, -14.2, 0.3, 'mid February');
});

test('sidereal time advances about 3 min 56 s per solar day and stars circle the pole', () => {
  const a = siderealTime(new Date(Date.UTC(2026, 0, 1, 0))).gmst, b = siderealTime(new Date(Date.UTC(2026, 0, 2, 0))).gmst;
  close(((b - a + 360) % 360), 0.9856, 0.001, 'daily sidereal gain (degrees)');
  // Polaris (ra 37.95, dec 89.26) stays within a degree of the latitude's elevation
  for (let h = 0; h < 24; h += 3) close(starPosition(37.95, 89.26, new Date(Date.UTC(2026, 3, 1, h)), 45, 10).elevation, 45, 0.8, 'pole star');
});

test('moon phase follows a known full and new moon', () => {
  // full moon 2026-05-01 17:23 UTC, new moon 2026-05-16 20:01 UTC
  close(moonPosition(new Date(Date.UTC(2026, 4, 1, 17, 23)), 0, 0).illuminated, 1, 0.02, 'full');
  close(moonPosition(new Date(Date.UTC(2026, 4, 16, 20, 1)), 0, 0).illuminated, 0, 0.02, 'new');
  const m = moonPosition(new Date(Date.UTC(2026, 4, 8, 12)), 40, -75);
  assert.ok(m.elevation >= -90 && m.elevation <= 90 && m.azimuth >= 0 && m.azimuth < 360);
  close(Math.hypot(...direction(m.elevation, m.azimuth)), 1, 1e-12, 'unit direction');
});

test('the equatorial-to-local matrix agrees with per-star alt/az', () => {
  const date = new Date(Date.UTC(2026, 10, 15, 3, 30)), lat = 39, lon = -77;
  const M = equatorialToLocal(siderealTime(date, lon).lst, lat);
  for (const [ra, dec] of [[101.29, -16.72], [279.23, 38.78], [37.95, 89.26], [213.9, 19.18]]) {
    const e = [Math.cos(dec * Math.PI / 180) * Math.cos(ra * Math.PI / 180), Math.cos(dec * Math.PI / 180) * Math.sin(ra * Math.PI / 180), Math.sin(dec * Math.PI / 180)];
    const v = M.map((row) => row[0] * e[0] + row[1] * e[1] + row[2] * e[2]);
    const p = starPosition(ra, dec, date, lat, lon), d = direction(p.elevation, p.azimuth);
    for (let k = 0; k < 3; k++) close(v[k], d[k], 1e-9, `component ${k}`);
  }
});

test('star limits, sizes, seasons and light weights behave as documented', () => {
  const evening = starVisibility({localHour: 20, sunElevation: -20});
  const late = starVisibility({localHour: 1, sunElevation: -40});
  const moonlit = starVisibility({localHour: 1, sunElevation: -40, moonElevation: 50, moonIlluminated: 1});
  assert.equal(evening.limit, 3.5); close(late.limit, 4.3, 1e-9); close(moonlit.limit, 2.7, 1e-9);
  assert.equal(starVisibility({localHour: 18, sunElevation: 0}).twilight, 0);
  assert.equal(late.twilight, 1);
  assert.ok(starSize(10, 4) < 1.41); assert.equal(starSize(-5, 4), 4.2);
  assert.ok(seasonWeights(200).leaf > 0.99 && seasonWeights(20).leaf === 0 && seasonWeights(285).autumn > 0.8);
  assert.equal(dayOfYear(new Date(Date.UTC(2026, 11, 31))), 365);
  const day = lightWeights(45), night = lightWeights(-20);
  assert.ok(day.sun === 1 && day.night === 0 && night.sun === 0 && night.night === 1);
  assert.equal(smoothstep(10, 0, 0), 1);
});
