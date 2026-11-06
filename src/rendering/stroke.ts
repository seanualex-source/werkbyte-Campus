// Stiftgeometrie: aus denselben Punkten und derselben Glättungsversion entsteht ein gefüllter
// Vektorumriss, der in Vorschau und Export identisch verwendet wird (§5.3).

import { getStroke } from 'perfect-freehand';
import type { InkPayload, InkPoint } from '../domain/types';

export const DEFAULT_PRESSURE = 0.5;

function options(kind: 'ink' | 'highlight', baseWidth: number, last: boolean) {
  // smoothingVersion 1 – Parameter dürfen sich nur mit einer neuen Version ändern.
  if (kind === 'highlight') {
    return { size: baseWidth, thinning: 0, smoothing: 0.5, streamline: 0.45, simulatePressure: false, last, start: { cap: true }, end: { cap: true } };
  }
  return { size: baseWidth, thinning: 0.55, smoothing: 0.55, streamline: 0.45, simulatePressure: false, last, start: { cap: true }, end: { cap: true } };
}

/** Umriss als flaches Array [x0, y0, x1, y1, …] im nativen Seitenraum. */
export function strokeOutline(kind: 'ink' | 'highlight', p: Pick<InkPayload, 'points' | 'baseWidth'>, last = true): number[] {
  const pts = p.points.map((q: InkPoint) => [q.x, q.y, Number.isFinite(q.pressure) ? q.pressure : DEFAULT_PRESSURE]);
  if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1] + 0.01, pts[0][2]]);
  const outline = getStroke(pts, options(kind, p.baseWidth, last));
  const flat: number[] = [];
  for (const [x, y] of outline) flat.push(Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000);
  return flat;
}

export function inkBounds(points: InkPoint[], pad: number) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX - pad, y: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
}

/** Kleinster Abstand eines Punkts zur Polylinie (für Radierer und Auswahl). */
export function distanceToPolyline(points: InkPoint[], x: number, y: number): number {
  if (points.length === 1) return Math.hypot(points[0].x - x, points[0].y - y);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
    if (d < best) best = d;
  }
  return best;
}

/** Punktreduktion für lange Striche (Ramer-Douglas-Peucker), Druck bleibt an Stützpunkten erhalten. */
export function simplify(points: InkPoint[], tolerance = 0.15): InkPoint[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    const a = points[s], b = points[e];
    for (let i = s + 1; i < e; i++) {
      const d = distanceToPolyline([a, b], points[i].x, points[i].y) + Math.abs(points[i].pressure - (a.pressure + b.pressure) / 2) * 2;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
