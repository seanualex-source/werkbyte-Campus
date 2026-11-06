// Rendering-Hilfen des Editors: PDF-Seiten-Bitmaps (begrenzter Cache, veraltete Aufträge verworfen),
// Bilder aus dem Objektspeicher und die gemeinsame Seitenkomposition für Seiten und Thumbnails.

import { create } from 'zustand';
import type { Annotation, PageRec, SourcePageRec } from '../../domain/types';
import { api } from '../../ipc/api';
import { SourceCache, type PDFPageProxy } from '../../pdf/pdfjs';
import { drawPrims } from '../../rendering/canvasRenderer';
import { loadBundledFont, type FontMetrics } from '../../rendering/fonts';
import { displayMatrix, displaySize, multiply, scale as scaleM, totalRotation } from '../../rendering/geometry';
import { annotationPrims, backgroundPrims, sortedAnnotations, type Prim } from '../../rendering/primitives';

// ───────── Schrift ─────────

export const useFont = create<{ metrics: FontMetrics | null; error: string | null }>(() => ({ metrics: null, error: null }));
loadBundledFont().then(
  (f) => useFont.setState({ metrics: f.metrics }),
  (e) => useFont.setState({ error: String(e?.message ?? e) }),
);

// ───────── Bilder ─────────

export const useImages = create<{ version: number }>(() => ({ version: 0 }));
const images = new Map<string, ImageBitmap | 'loading' | 'error'>();

export function imageFor(hash: string): ImageBitmap | null {
  const v = images.get(hash);
  if (v instanceof ImageBitmap) return v;
  if (!v) {
    images.set(hash, 'loading');
    api
      .blobRead(hash)
      .then((bytes) => createImageBitmap(new Blob([bytes.slice().buffer])))
      .then(
        (bmp) => images.set(hash, bmp),
        () => images.set(hash, 'error'),
      )
      .finally(() => useImages.setState((s) => ({ version: s.version + 1 })));
  }
  return null;
}

// ───────── PDF-Seiten ─────────

export const sources = { cache: new SourceCache() };

export function resetSources() {
  void sources.cache.destroy();
  sources.cache = new SourceCache();
  bitmapCache.clear();
}

const bitmapCache = new Map<string, HTMLCanvasElement>();
const MAX_BITMAPS = 24;

function remember(key: string, c: HTMLCanvasElement) {
  bitmapCache.delete(key);
  bitmapCache.set(key, c);
  while (bitmapCache.size > MAX_BITMAPS) {
    const first = bitmapCache.keys().next().value as string;
    const old = bitmapCache.get(first);
    if (old) {
      old.width = 0;
      old.height = 0;
    }
    bitmapCache.delete(first);
  }
}

export async function getPdfPage(blobHash: string, pageIndex: number): Promise<PDFPageProxy> {
  const doc = await sources.cache.get(blobHash);
  return doc.getPage(pageIndex + 1);
}

/** Rendert eine Quellseite in Darstellungsorientierung mit vorgegebener Pixelbreite. */
export async function renderPdfBitmap(blobHash: string, pageIndex: number, rotation: number, pixelWidth: number, isStale: () => boolean): Promise<HTMLCanvasElement | null> {
  const bucket = Math.max(64, Math.round(pixelWidth / 32) * 32);
  const key = `${blobHash}:${pageIndex}:${rotation}:${bucket}`;
  const hit = bitmapCache.get(key);
  if (hit) {
    remember(key, hit);
    return hit;
  }
  const page = await getPdfPage(blobHash, pageIndex);
  if (isStale()) return null;
  const base = page.getViewport({ scale: 1, rotation });
  const viewport = page.getViewport({ scale: bucket / base.width, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Formularfelder werden im Editor als eigene Eingabeelemente dargestellt (ENABLE_FORMS).
  const task = page.render({ canvas, canvasContext: ctx, viewport, annotationMode: 2 });
  try {
    await task.promise;
  } catch (e) {
    if ((e as Error)?.name === 'RenderingCancelledException') return null;
    throw e;
  }
  remember(key, canvas);
  return canvas;
}

// ───────── Komposition ─────────

export interface CompositeInput {
  page: PageRec;
  sp: SourcePageRec | null;
  annotations: Annotation[];
  metrics: FontMetrics | null;
  pdfBitmap: CanvasImageSource | null;
  /** Darstellungspixel pro Punkt (Zoom · Geräteskalierung). */
  pxPerPt: number;
  hiddenIds?: Set<string>;
  extra?: Prim[];
}

export function drawComposite(canvas: HTMLCanvasElement, inp: CompositeInput) {
  const rot = totalRotation(inp.page, inp.sp);
  const [dw, dh] = displaySize(inp.page.widthPt, inp.page.heightPt, rot);
  const w = Math.max(1, Math.round(dw * inp.pxPerPt));
  const h = Math.max(1, Math.round(dh * inp.pxPerPt));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (inp.pdfBitmap) ctx.drawImage(inp.pdfBitmap, 0, 0, w, h);
  const m = multiply(scaleM(w / dw, h / dh), displayMatrix(rot, inp.page.widthPt, inp.page.heightPt));
  ctx.setTransform(...m);
  const prims: Prim[] = [...backgroundPrims(inp.page)];
  if (inp.metrics) {
    for (const a of sortedAnnotations(inp.annotations)) {
      if (inp.hiddenIds?.has(a.id)) continue;
      prims.push(...annotationPrims(a, inp.metrics));
    }
  }
  if (inp.extra) prims.push(...inp.extra);
  drawPrims(ctx, prims, (hash) => imageFor(hash));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
