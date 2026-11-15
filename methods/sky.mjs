// Sun, moon and stars for a map's lighting and night sky. Plain formulas, no dependencies, degrees in and out.
// Accuracy: the sun to about 0.01 degrees (NOAA spreadsheet formulas), the moon to about 0.3 degrees (low-precision
// Meeus terms), stars to visual precision (precession since J2000 is ignored, about 0.4 degrees by 2026). That is ample
// for shading and a believable sky; it is not an ephemeris.
const D = Math.PI / 180;
const wrap360 = (x) => ((x % 360) + 360) % 360;

/** Julian day number of a JavaScript Date (UTC). */
export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Solar position (NOAA formulas, no refraction). Returns degrees: elevation above the horizon, azimuth clockwise from
 * north, declination, and the equation of time in minutes.
 */
export function sunPosition(date, lat, lon) {
  const jc = (julianDay(date) - 2451545) / 36525;
  const L0 = wrap360(280.46646 + jc * (36000.76983 + jc * 0.0003032));
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C = Math.sin(M * D) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
            Math.sin(2 * M * D) * (0.019993 - 0.000101 * jc) + Math.sin(3 * M * D) * 0.000289;
  const omega = 125.04 - 1934.136 * jc;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * D);
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * D);
  const decl = Math.asin(Math.sin(eps * D) * Math.sin(lambda * D)) / D;
  const y = Math.tan(eps * D / 2) ** 2;
  const eot = 4 / D * (y * Math.sin(2 * L0 * D) - 2 * e * Math.sin(M * D) + 4 * e * y * Math.sin(M * D) * Math.cos(2 * L0 * D) -
                       0.5 * y * y * Math.sin(4 * L0 * D) - 1.25 * e * e * Math.sin(2 * M * D));
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;
  const tst = ((utcMin + eot + 4 * lon) % 1440 + 1440) % 1440;
  const ha = tst / 4 - 180;
  return {...altAz(ha, decl, lat), declination: decl, equationOfTime: eot};
}

/** Horizontal coordinates from hour angle and declination (degrees). Azimuth clockwise from north. */
export function altAz(hourAngle, dec, lat) {
  const h = hourAngle * D, d = dec * D, p = lat * D;
  const elevation = Math.asin(Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(h)) / D;
  const azimuth = wrap360(Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(p) - Math.tan(d) * Math.cos(p)) / D + 180);
  return {elevation, azimuth};
}

/** Greenwich mean sidereal time and local sidereal time in degrees. */
export function siderealTime(date, lon = 0) {
  const d = julianDay(date) - 2451545;
  const gmst = wrap360(280.46061837 + 360.98564736629 * d);
  return {gmst, lst: wrap360(gmst + lon)};
}

/** A star (right ascension and declination in degrees) seen from lat/lon at `date`. */
export function starPosition(ra, dec, date, lat, lon) {
  return altAz(siderealTime(date, lon).lst - ra, dec, lat);
}

/**
 * Moon position and phase (low-precision terms). phase: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter;
 * illuminated: lit fraction of the disc.
 */
export function moonPosition(date, lat, lon) {
  const jd = julianDay(date), d = jd - 2451545, eps = 23.4397 * D;
  const L = (218.316 + 13.176396 * d) * D, M = (134.963 + 13.064993 * d) * D, F = (93.272 + 13.22935 * d) * D;
  const l = L + 6.289 * D * Math.sin(M), b = 5.128 * D * Math.sin(F);
  const ra = Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l)) / D;
  const dec = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l)) / D;
  const lst = 280.16 + 360.9856235 * d + lon;
  const phase = (((jd - 2451550.1) / 29.530588853) % 1 + 1) % 1;
  return {...altAz(lst - ra, dec, lat), ra: wrap360(ra), dec, distanceKm: 385001 - 20905 * Math.cos(M),
          phase, illuminated: (1 - Math.cos(2 * Math.PI * phase)) / 2};
}

/** Hermite smoothstep; edges may be given in either order (e0 > e1 gives a falling ramp). */
export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Light weights from the sun's elevation (degrees): direct sun, warm low-sun tint, and night. These drive the colour
 * of the key light, the sky gradient, window and lamp glow.
 */
export function lightWeights(sunElevation) {
  return {sun: smoothstep(-3, 10, sunElevation),
          warm: (1 - smoothstep(4, 24, sunElevation)) * smoothstep(-4, 2, sunElevation),
          night: 1 - smoothstep(-9, 1, sunElevation)};
}

/**
 * Faintest star magnitude to draw. Starts at 3.5 in the evening and deepens by 0.8 between 21:00 and 01:00 local
 * time (and stays deeper until 09:00); a bright, high moon washes out up to 1.6 magnitudes; never brighter than 1.5. Twilight fades stars in between
 * sun elevations -4 and -13 degrees (multiply brightness by `twilight`).
 */
export function starVisibility({localHour, sunElevation, moonElevation = -90, moonIlluminated = 0}) {
  const h = localHour < 9 ? localHour + 24 : localHour;                 // 21:00 -> 21, 01:00 -> 25; resets at 09:00
  const late = Math.min(1, Math.max(0, (h - 21) / 4));
  const moonWash = 1.6 * moonIlluminated * smoothstep(0, 0.4, moonElevation * D);
  return {limit: Math.max(1.5, 3.5 + 0.8 * late - moonWash), twilight: smoothstep(-4, -13, sunElevation)};
}

/** Point size in pixels for a star of magnitude `v` when `limit` is the faintest drawn. */
export function starSize(v, limit) {
  const flux = 10 ** (-0.4 * (v - limit));
  return Math.min(4.2, Math.max(1.4, 1.4 + 0.9 * Math.log(1 + flux)));
}

/**
 * Season weights by day of year (1-366, northern temperate climate): leaves out, autumn colour, browning and spring
 * blossom. Each is 0..1 and blends smoothly.
 */
export function seasonWeights(dayOfYear) {
  const s = (a, b) => smoothstep(a, b, dayOfYear);
  return {leaf: s(80, 118) * (1 - s(305, 338)), autumn: s(262, 292) * (1 - s(330, 345)),
          brown: s(312, 335) * (1 - s(350, 365)), bloom: s(84, 94) * (1 - s(104, 116))};
}

/** Day of year (1-based) of a Date in UTC. */
export function dayOfYear(date) {
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000) + 1;
}

/** Unit vector pointing towards a body at elevation/azimuth (degrees), in a frame x east, y north, z up. */
export function direction(elevation, azimuth) {
  const e = elevation * D, a = azimuth * D;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

/**
 * Rotation from equatorial unit vectors (x towards right ascension 0, z towards the north celestial pole) to local
 * east-north-up at latitude `lat` and local sidereal time `lst` (degrees). Row-major 3x3: local = M * equatorial.
 * One matrix per frame turns a whole star catalogue.
 */
export function equatorialToLocal(lst, lat) {
  const t = lst * D, p = lat * D, ct = Math.cos(t), st = Math.sin(t), cp = Math.cos(p), sp = Math.sin(p);
  return [[-st, ct, 0], [-sp * ct, -sp * st, cp], [cp * ct, cp * st, sp]];
}
