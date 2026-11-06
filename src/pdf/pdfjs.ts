// Anzeigeadapter: PDF.js mit lokal gebündeltem Worker und Ressourcen (keine CDN-Zugriffe).

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { ImportAnalysis, Rotation } from '../domain/types';
import { api } from '../ipc/api';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy };

function resource(path: string) {
  return new URL(`pdfjs/${path}`, document.baseURI).href;
}

export function openPdf(data: Uint8Array) {
  const task = pdfjs.getDocument({
    data: data.slice(),
    cMapUrl: resource('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: resource('standard_fonts/'),
    wasmUrl: resource('wasm/'),
    iccUrl: resource('iccs/'),
    enableXfa: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  // Passwortgeschützte Dateien werden im MVP nicht geöffnet.
  task.onPassword = () => {
    void task.destroy();
  };
  return task;
}

export class GeometryError extends Error {
  constructor(public code: 'PDF_UNSUPPORTED' | 'PDF_CORRUPT' | 'LIMIT_EXCEEDED', message: string) {
    super(message);
  }
}

/** Seitengeometrie über PDF.js (CropBox = page.view, Rotation, UserUnit). */
export async function analyzeGeometry(bytes: Uint8Array, maxPages: number): Promise<ImportAnalysis['pages']> {
  const task = openPdf(bytes);
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as Error)?.name ?? '';
    if (name === 'PasswordException' || /password/i.test(String((e as Error)?.message))) {
      throw new GeometryError('PDF_UNSUPPORTED', 'Die Datei ist passwortgeschützt. Passwortgeschützte PDFs werden in dieser Version nicht unterstützt.');
    }
    throw new GeometryError('PDF_CORRUPT', 'Die Datei ist beschädigt oder kein gültiges PDF.');
  }
  try {
    if (doc.numPages > maxPages) throw new GeometryError('LIMIT_EXCEEDED', `Das PDF hat ${doc.numPages} Seiten; unterstützt werden zunächst höchstens ${maxPages}.`);
    const pages: ImportAnalysis['pages'] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const [x1, y1, x2, y2] = p.view;
      const uu = p.userUnit || 1;
      const w = Math.abs(x2 - x1) * uu;
      const h = Math.abs(y2 - y1) * uu;
      if (!(w > 0 && h > 0 && w <= 14400 && h <= 14400)) throw new GeometryError('PDF_UNSUPPORTED', `Seite ${i} hat eine nicht unterstützte Größe.`);
      pages.push({ index: i - 1, cropX: Math.min(x1, x2), cropY: Math.min(y1, y2), widthPt: w, heightPt: h, intrinsicRotation: ((p.rotate % 360) + 360) % 360 as Rotation, userUnit: uu });
      p.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** Geladene Quell-PDFs je Editor-Sitzung; gibt Ressourcen beim Schließen frei. */
export class SourceCache {
  private docs = new Map<string, Promise<PDFDocumentProxy>>();
  private tasks: { destroy(): Promise<void> }[] = [];

  get(blobHash: string): Promise<PDFDocumentProxy> {
    let pr = this.docs.get(blobHash);
    if (!pr) {
      pr = api.blobRead(blobHash).then((bytes) => {
        const task = openPdf(bytes);
        this.tasks.push(task);
        return task.promise;
      });
      pr.catch(() => this.docs.delete(blobHash));
      this.docs.set(blobHash, pr);
    }
    return pr;
  }

  async destroy() {
    const t = this.tasks.splice(0);
    this.docs.clear();
    await Promise.allSettled(t.map((x) => x.destroy()));
  }
}

/** Überprüft ein erzeugtes PDF mit einem unabhängigen Lesevorgang (§8.2 Schritt 7). */
export async function verifyExport(bytes: Uint8Array, expected: { w: number; h: number; rotation: number }[]): Promise<void> {
  const task = openPdf(bytes);
  try {
    const doc = await task.promise;
    if (doc.numPages !== expected.length) throw new Error(`Seitenzahl stimmt nicht (${doc.numPages} statt ${expected.length}).`);
    for (let i = 0; i < expected.length; i++) {
      const p = await doc.getPage(i + 1);
      const [x1, y1, x2, y2] = p.view;
      const uu = p.userUnit || 1;
      const w = Math.abs(x2 - x1) * uu, h = Math.abs(y2 - y1) * uu;
      if (Math.abs(w - expected[i].w) > 0.5 || Math.abs(h - expected[i].h) > 0.5) throw new Error(`Seitengröße von Seite ${i + 1} weicht ab.`);
      if (((p.rotate % 360) + 360) % 360 !== expected[i].rotation) throw new Error(`Drehung von Seite ${i + 1} weicht ab.`);
    }
  } finally {
    await task.destroy();
  }
}
