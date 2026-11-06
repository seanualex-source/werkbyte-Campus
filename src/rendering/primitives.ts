// Annotationen und Notizhintergründe → geräteunabhängige Zeichenprimitive im nativen Seitenraum.
// Canvas-Renderer und PDF-Export konsumieren exakt dieselben Primitive.

import type { Annotation, NoteBackground, PageRec } from '../domain/types';
import type { FontMetrics } from './fonts';
import { objectFrame, type Mat } from './geometry';
import { layoutText, type LaidLine } from './textLayout';
import { strokeOutline } from './stroke';

export type Blend = 'normal' | 'multiply';

export type Prim =
  | { t: 'poly'; pts: number[]; color: string; alpha: number; blend: Blend }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: string }
  | { t: 'text'; lines: LaidLine[]; size: number; color: string; frame: Mat }
  | { t: 'image'; hash: string; width: number; height: number; alpha: number; frame: Mat };

export const HIGHLIGHT_BLEND: Blend = 'multiply';

export function backgroundPrims(page: PageRec): Prim[] {
  const bg: NoteBackground | null = page.background;
  if (page.kind !== 'note' || !bg || bg.type === 'blank') return [];
  const prims: Prim[] = [];
  const s = bg.spacingPt;
  const W = page.widthPt, H = page.heightPt;
  if (bg.type === 'ruled') {
    const top = Math.max(s * 3, 56);
    for (let y = top; y < H - s * 0.5; y += s) prims.push({ t: 'line', x1: 0, y1: y, x2: W, y2: y, width: bg.lineWidthPt, color: bg.color });
    // Randlinie links wie bei Collegeblock
    prims.push({ t: 'line', x1: 70, y1: 0, x2: 70, y2: H, width: bg.lineWidthPt, color: '#E3A6A6' });
  } else if (bg.type === 'grid') {
    const offX = (W % s) / 2, offY = (H % s) / 2;
    for (let x = offX; x <= W; x += s) prims.push({ t: 'line', x1: x, y1: 0, x2: x, y2: H, width: bg.lineWidthPt, color: bg.color });
    for (let y = offY; y <= H; y += s) prims.push({ t: 'line', x1: 0, y1: y, x2: W, y2: y, width: bg.lineWidthPt, color: bg.color });
  }
  return prims;
}

export function annotationPrims(a: Annotation, m: FontMetrics): Prim[] {
  switch (a.kind) {
    case 'text': {
      const p = a.payload;
      const { matrix, localWidth } = objectFrame(p.x, p.y, p.width, p.height, p.orient ?? 0);
      const layout = layoutText({ text: p.text, width: localWidth, fontSize: p.fontSize, lineHeight: p.lineHeight, align: p.align }, m);
      return [{ t: 'text', lines: layout.lines, size: p.fontSize, color: p.color, frame: matrix }];
    }
    case 'image': {
      const p = a.payload;
      const { matrix, localWidth, localHeight } = objectFrame(p.x, p.y, p.width, p.height, p.orient ?? 0);
      return [{ t: 'image', hash: p.blobHash, width: localWidth, height: localHeight, alpha: p.opacity, frame: matrix }];
    }
    case 'ink':
    case 'highlight': {
      const p = a.payload;
      return [
        {
          t: 'poly',
          pts: strokeOutline(a.kind, p),
          color: p.color,
          alpha: p.opacity,
          blend: a.kind === 'highlight' ? HIGHLIGHT_BLEND : 'normal',
        },
      ];
    }
  }
}

export function sortedAnnotations(list: Annotation[]): Annotation[] {
  return [...list].sort((a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1));
}

/** Benötigte Texthöhe einer Textbox (für automatisches Wachsen beim Tippen). */
export function textContentHeight(a: Extract<Annotation, { kind: 'text' }>, m: FontMetrics): number {
  const p = a.payload;
  const { localWidth } = objectFrame(p.x, p.y, p.width, p.height, p.orient ?? 0);
  return layoutText({ text: p.text, width: localWidth, fontSize: p.fontSize, lineHeight: p.lineHeight, align: p.align }, m).height;
}
