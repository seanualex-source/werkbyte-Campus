// Trefferprüfung, Hüllrechtecke und Transformationen eigener Objekte im nativen Seitenraum.

import type { Annotation, Rotation, TextPayload } from '../../domain/types';
import { distanceToPolyline, inkBounds } from '../../rendering/stroke';
import { applyMat, objectFrame, rotate, multiply, translate } from '../../rendering/geometry';

export function bounds(a: Annotation) {
  if (a.kind === 'ink' || a.kind === 'highlight') return inkBounds(a.payload.points, a.payload.baseWidth / 2);
  const p = (a as Exclude<Annotation, { kind: 'ink' | 'highlight' }>).payload;
  return { x: p.x, y: p.y, width: p.width, height: p.height };
}

export function hitTest(anns: Annotation[], x: number, y: number, tol: number): Annotation | null {
  for (let i = anns.length - 1; i >= 0; i--) {
    const a = anns[i];
    if (a.kind === 'ink' || a.kind === 'highlight') {
      if (distanceToPolyline(a.payload.points, x, y) <= a.payload.baseWidth / 2 + tol) return a;
    } else {
      const b = bounds(a);
      if (x >= b.x - tol && x <= b.x + b.width + tol && y >= b.y - tol && y <= b.y + b.height + tol) return a;
    }
  }
  return null;
}

export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  if (a.kind === 'ink' || a.kind === 'highlight') {
    return { ...a, payload: { ...a.payload, points: a.payload.points.map((p) => ({ ...p, x: round(p.x + dx), y: round(p.y + dy) })) } };
  }
  const b = a as Exclude<Annotation, { kind: 'ink' | 'highlight' }>;
  return { ...b, payload: { ...b.payload, x: round(b.payload.x + dx), y: round(b.payload.y + dy) } } as Annotation;
}

export function round(v: number) {
  return Math.round(v * 100) / 100;
}

/**
 * Neues natives Rechteck für eine geänderte lokale Größe; die obere linke Ecke im lokalen
 * (aufrechten) Rahmen bleibt fest.
 */
export function rectForLocalSize(p: { x: number; y: number; width: number; height: number; orient: Rotation }, lw: number, lh: number) {
  const { matrix } = objectFrame(p.x, p.y, p.width, p.height, p.orient);
  const [cx0, cy0] = applyMat(matrix, 0, 0);
  const r = rotate(-p.orient);
  const [ox, oy] = applyMat(r, lw / 2, lh / 2);
  const cx = cx0 + ox, cy = cy0 + oy;
  const swap = p.orient === 90 || p.orient === 270;
  const w = swap ? lh : lw;
  const h = swap ? lw : lh;
  return { x: round(cx - w / 2), y: round(cy - h / 2), width: round(w), height: round(h) };
}

export function localSize(p: Pick<TextPayload, 'width' | 'height' | 'orient'>) {
  const swap = p.orient === 90 || p.orient === 270;
  return swap ? { lw: p.height, lh: p.width } : { lw: p.width, lh: p.height };
}

export { multiply, translate };
