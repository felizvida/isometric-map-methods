// Small traffic references: car following (Intelligent Driver Model), lane offsets, junction zone size, a dead-end
// U-turn path and turn preferences. Units: metres, seconds, radians.

export const IDM = {a: 1.5, b: 2.8, T: 1.25, s0: 2, bMax: 8.5};

/**
 * IDM acceleration for speed v (m/s), desired speed v0, gap to the leader (m, bumper to bumper) and closing speed dv
 * (v - leader speed). acc = a[1 - (v/v0)^4 - (sStar / gap)^2], sStar = s0 + max(0, vT + v dv / (2 sqrt(ab)));
 * clamped >= -bMax.
 */
export function idmAcceleration(v, v0, gap, dv = 0, p = IDM) {
  if (v0 < 0.05) return v > 0 ? -p.b * 1.4 : -p.b;
  const sStar = p.s0 + Math.max(0, v * p.T + v * dv / (2 * Math.sqrt(p.a * p.b)));
  const free = 1 - (v / v0) ** 4;
  const inter = Number.isFinite(gap) ? (sStar / Math.max(gap, 0.01)) ** 2 : 0;
  return Math.max(-p.bMax, p.a * (free - inter));
}

/** Lateral offset of lane `lane` (0 = rightmost) from the centreline: one-way roads centre their lanes; two-way roads
 * keep each direction right of centre, at least 1.35 m out. */
export function laneOffset(width, lanes, lane, oneway) {
  if (oneway) return (lane - (lanes - 1) / 2) * Math.min(3.2, width / lanes);
  return Math.min(1.7, Math.max(1.35, width / 4)) + 3.2 * lane;
}

/** Junction zone radius from the widest road and the smallest angle between approaches: wide or sharp junctions get
 * bigger zones, capped at 22 m. */
export function junctionRadius(maxWidth, minAngle) {
  return Math.min(22, Math.max(maxWidth / 2 + 1.5, 2.6 / (2 * Math.sin(Math.max(minAngle, 0.12) / 2))));
}

/**
 * Point on a dead-end U-turn from lane offset offA (arriving) to offB (leaving) at node `node` with arrival direction d
 * and left normal n: radius R = max(2, (offA + offB) / 2), theta from 0 to pi.
 */
export function uTurnPoint(node, d, offA, offB, theta) {
  const R = Math.max(2, (offA + offB) / 2), r = (offA + offB) / 2;
  const n = [-d[1], d[0]];
  // start on the right of d (offset offA), end on its left (offset offB, the right of the way back)
  const c = [node[0] - d[0] * R + n[0] * (offB - offA) / 2, node[1] - d[1] * R + n[1] * (offB - offA) / 2];
  return [c[0] - n[0] * r * Math.cos(theta) + d[0] * R * Math.sin(theta), c[1] - n[1] * r * Math.cos(theta) + d[1] * R * Math.sin(theta)];
}

/**
 * Preference for the next edge at a junction: prefer straight on and roads of equal or higher rank; U-turns only when
 * nothing else exists. turn = angle between directions (0 straight).
 */
export function turnWeight({rank, currentRank, turn, uTurn = false, onlyWay = false}) {
  if (uTurn) return onlyWay ? 1 : 0;
  return (rank + 1) ** 1.6 * (0.25 + 2.2 * Math.max(0, Math.cos(turn)) ** 2) * (rank >= currentRank ? 1.4 : 0.7);
}
