// Koordinatenvertrag (Spezifikation §5.3)
//
// Annotationen liegen im *nativen Seitenraum*: Punkte (72 pt/Zoll), Ursprung oben links der
// sichtbaren, ungedrehten CropBox, y wächst nach unten. Die ursprüngliche PDF-Rotation und die
// zusätzliche Nutzerdrehung sind reine Darstellungstransformationen. Eine Matrix
// [a, b, c, d, e, f] bildet (x, y) auf (a·x + c·y + e, b·x + d·y + f) ab (Canvas-Konvention).

import type { PageRec, Rotation, SourcePageRec } from '../domain/types';

export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function normRotation(r: number): Rotation {
  const v = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
  return v as Rotation;
}

/** Gesamtdrehung für die Darstellung: ursprüngliche PDF-Rotation plus Nutzerdrehung. */
export function totalRotation(page: PageRec, sp?: SourcePageRec | null): Rotation {
  return normRotation((sp?.intrinsicRotation ?? 0) + page.rotation);
}

/** Größe der Seite in Darstellungsorientierung. */
export function displaySize(w: number, h: number, rot: Rotation): [number, number] {
  return rot === 90 || rot === 270 ? [h, w] : [w, h];
}

/** Nativer Seitenraum → Darstellungsraum (gedreht im Uhrzeigersinn um `rot`). */
export function displayMatrix(rot: Rotation, w: number, h: number): Mat {
  switch (rot) {
    case 0:
      return [1, 0, 0, 1, 0, 0];
    case 90:
      return [0, 1, -1, 0, h, 0];
    case 180:
      return [-1, 0, 0, -1, w, h];
    case 270:
      return [0, -1, 1, 0, 0, w];
  }
}

/** m1 ∘ m2: zuerst m2, dann m1. */
export function multiply(m1: Mat, m2: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function invert(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error('Matrix nicht invertierbar');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function applyMat(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function translate(x: number, y: number): Mat {
  return [1, 0, 0, 1, x, y];
}

export function scale(sx: number, sy = sx): Mat {
  return [sx, 0, 0, sy, 0, 0];
}

/** Drehung um `deg` Grad im y-nach-unten-Raum (positiv = im Uhrzeigersinn auf dem Bildschirm). */
export function rotate(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 1e12) / 1e12;
  const s = Math.round(Math.sin(r) * 1e12) / 1e12;
  return [c, s, -s, c, 0, 0];
}

/** Achsparallele Hülle eines Rechtecks nach Transformation. */
export function transformRect(m: Mat, x: number, y: number, w: number, h: number) {
  const pts = [applyMat(m, x, y), applyMat(m, x + w, y), applyMat(m, x, y + h), applyMat(m, x + w, y + h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * Vollständige Bildschirmtransformation: nativer Seitenraum → CSS-Pixel innerhalb des Seitencontainers.
 * Geräteskalierung (devicePixelRatio) wird nur für Canvas-Backbuffer zusätzlich multipliziert.
 */
export function viewMatrix(rot: Rotation, w: number, h: number, zoom: number): Mat {
  return multiply(scale(zoom), displayMatrix(rot, w, h));
}

/**
 * Lokaler Rahmen eines Text- oder Bildobjekts. `orient` ist die Darstellungsdrehung zum
 * Zeitpunkt der Erstellung; der Inhalt wird gegengedreht und erscheint dadurch aufrecht.
 * Rückgabe: Matrix lokal → nativ sowie lokale Breite/Höhe.
 */
export function objectFrame(x: number, y: number, w: number, h: number, orient: Rotation) {
  const swap = orient === 90 || orient === 270;
  const lw = swap ? h : w;
  const lh = swap ? w : h;
  const m = multiply(translate(x + w / 2, y + h / 2), multiply(rotate(-orient), translate(-lw / 2, -lh / 2)));
  return { matrix: m, localWidth: lw, localHeight: lh };
}

/** Wandelt ein im Darstellungsraum aufgezogenes Rechteck in ein natives Objektrechteck. */
export function nativeRectFromDisplay(
  rot: Rotation,
  w: number,
  h: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  return transformRect(invert(displayMatrix(rot, w, h)), dx, dy, dw, dh);
}

/** Natives PDF-Ziel: nativer Seitenraum (pt, y unten) → PDF-Nutzerraum der Quellseite. */
export function pdfUserSpaceMatrix(cropX: number, cropY: number, heightPt: number, userUnit = 1): Mat {
  const u = userUnit || 1;
  return [1 / u, 0, 0, -1 / u, cropX, cropY + heightPt / u];
}
