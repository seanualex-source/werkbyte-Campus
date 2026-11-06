// PDF-Golden-Tests (§13): Export mit pdf-lib, unabhängige Prüfung mit PDF.js-Rendering.

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { analyzeWithPdfLib, ImportRejected } from '../src/pdf/analyzeForms';
import { composeExport, ExportError } from '../src/pdf/composeExport';
import type { Annotation, DocumentSnapshot, PageRec, Rotation, SourcePageRec, WidgetRec } from '../src/domain/types';
import { makeFormPdf, makeRotatedPdf, makeUserUnitPdf } from './fixtures/makeFixtures';
import { displayMatrix, applyMat, totalRotation } from '../src/rendering/geometry';

const root = join(__dirname, '..');
const fontBytes = new Uint8Array(readFileSync(join(root, 'node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf')));
const outDir = join(root, 'tests', 'output');
mkdirSync(outDir, { recursive: true });

let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function geometryOf(bytes: Uint8Array): Promise<SourcePageRec[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const res: SourcePageRec[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const [x1, y1, x2, y2] = p.view;
    const uu = (p as unknown as { userUnit?: number }).userUnit ?? 1;
    res.push({ sourceId: 'src', pageIndex: i - 1, cropX: Math.min(x1, x2), cropY: Math.min(y1, y2), widthPt: Math.abs(x2 - x1) * uu, heightPt: Math.abs(y2 - y1) * uu, intrinsicRotation: p.rotate as Rotation, userUnit: uu });
  }
  await task.destroy();
  return res;
}

async function render(bytes: Uint8Array, pageNo: number, scale = 1) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as never, viewport: vp, canvas: canvas as never }).promise;
  const text = (await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
  const info = { width: canvas.width, height: canvas.height, rotate: page.rotate, view: page.view };
  const pixel = (x: number, y: number) => {
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const png = canvas.toBuffer('image/png');
  await task.destroy();
  return { info, pixel, text, png };
}

function snapshotFor(pages: PageRec[], sourcePages: SourcePageRec[], annotations: Annotation[], extra: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    document: { id: uid(), folderId: null, title: 'Test', revision: 3, createdAt: '', updatedAt: '', lastOpenedAt: null, pageCount: pages.length },
    pages,
    annotations,
    sources: [],
    sourcePages,
    formGroups: [],
    formValues: [],
    widgets: [],
    view: null,
    ...extra,
  };
}

const square = (pageId: string, x: number, y: number, color = '#FF0000'): Annotation => ({
  id: uid(),
  pageId,
  kind: 'ink',
  zIndex: 1,
  payloadVersion: 1,
  payload: { points: [{ x, y, pressure: 0.5 }, { x: x + 0.5, y: y + 0.5, pressure: 0.5 }], baseWidth: 16, color, opacity: 1, smoothingVersion: 1 },
});

describe('Import-Klassifikation', () => {
  it('erkennt unterstützte Formularfelder mit Widgets und Seiten', async () => {
    const bytes = await makeFormPdf();
    const a = await analyzeWithPdfLib(bytes, 1000);
    const byKey = Object.fromEntries(a.fields.map((f) => [f.key, f]));
    expect(Object.keys(byKey).sort()).toEqual(['agree', 'person.name', 'semester', 'studiengang']);
    expect(byKey['person.name'].widgets.map((w) => w.pageIndex)).toEqual([0, 1]);
    expect(byKey['studiengang'].options).toEqual(['Informatik', 'Mathematik']);
    const w = byKey['person.name'].widgets[0];
    // Widget-Rechteck schließt den Rahmen (1 pt) ein.
    expect(w.x).toBeCloseTo(49.5, 3);
    expect(w.y).toBeCloseTo(842 - 724.5, 3);
  });

  it('lehnt defekte Dateien ab', async () => {
    await expect(analyzeWithPdfLib(new TextEncoder().encode('%PDF-1.7 kaputt'), 1000)).rejects.toBeInstanceOf(ImportRejected);
  });

  it('erzwingt das Seitenlimit', async () => {
    const bytes = await makeRotatedPdf();
    await expect(analyzeWithPdfLib(bytes, 2)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

describe('Export', () => {
  it('Koordinatenvertrag: Annotationen bei allen vier Rotationen und CropBox-Versatz exakt platziert', async () => {
    const bytes = await makeRotatedPdf();
    const geo = await geometryOf(bytes);
    expect(geo.map((g) => g.intrinsicRotation)).toEqual([0, 90, 180, 270]);
    expect(geo[0].cropX).toBe(50);
    const pages: PageRec[] = [];
    const anns: Annotation[] = [];
    // Je Quellseite zusätzlich alle Nutzerdrehungen kombinieren.
    for (const sp of geo) {
      for (const userRot of [0, 90] as Rotation[]) {
        const id = uid();
        pages.push({ id, position: pages.length, kind: 'pdf', sourceId: 'src', sourcePageIndex: sp.pageIndex, widthPt: sp.widthPt, heightPt: sp.heightPt, rotation: userRot, background: null });
        anns.push(square(id, 40, 60, '#FF0000'));
        anns.push(square(id, sp.widthPt - 40, sp.heightPt - 60, '#0000FF'));
      }
    }
    const snap = snapshotFor(pages, geo, anns);
    const out = await composeExport({ snapshot: snap, pageIds: pages.map((p) => p.id), sources: { src: bytes }, images: {}, fontBytes });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(8);
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const sp = geo[page.sourcePageIndex!];
      const rot = totalRotation(page, sp);
      const r = await render(out, i + 1, 1);
      expect(r.info.rotate).toBe(rot);
      const m = displayMatrix(rot, sp.widthPt, sp.heightPt);
      const [rx, ry] = applyMat(m, 40, 60);
      const [bx, by] = applyMat(m, sp.widthPt - 40, sp.heightPt - 60);
      const red = r.pixel(rx, ry);
      const blue = r.pixel(bx, by);
      expect(red[0]).toBeGreaterThan(200);
      expect(red[2]).toBeLessThan(60);
      expect(blue[2]).toBeGreaterThan(200);
      expect(blue[0]).toBeLessThan(60);
      if (i === 3) writeFileSync(join(outDir, 'rotation-90-plus-user-90.png'), r.png);
    }
  });

  it('UserUnit wird berücksichtigt', async () => {
    const bytes = await makeUserUnitPdf();
    const geo = await geometryOf(bytes);
    const id = uid();
    const page: PageRec = { id, position: 0, kind: 'pdf', sourceId: 'src', sourcePageIndex: 0, widthPt: geo[0].widthPt, heightPt: geo[0].heightPt, rotation: 0, background: null };
    const out = await composeExport({ snapshot: snapshotFor([page], geo, [square(id, geo[0].widthPt - 30, 30)]), pageIds: [id], sources: { src: bytes }, images: {}, fontBytes });
    const r = await render(out, 1, 1);
    // PDF.js berücksichtigt UserUnit beim Viewport; die Markierung muss rechts oben liegen.
    const sx = r.info.width / geo[0].widthPt;
    const px = r.pixel((geo[0].widthPt - 30) * sx, 30 * sx);
    expect(px[0]).toBeGreaterThan(200);
    expect(px[1]).toBeLessThan(60);
  });

  it('Notizseite mit Text (Umlaute, Mathematik), Stift, Textmarker und Bild; Formular-Kopien mit getrennten Werten', async () => {
    const form = await makeFormPdf();
    const fa = await analyzeWithPdfLib(form, 1000);
    const geo = await geometryOf(form);
    const pForm1 = uid(), pForm2 = uid(), pNote = uid();
    const gA = uid(), gB = uid();
    const pages: PageRec[] = [
      { id: pForm1, position: 0, kind: 'pdf', sourceId: 'src', sourcePageIndex: 0, widthPt: 595, heightPt: 842, rotation: 0, background: null },
      { id: pForm2, position: 1, kind: 'pdf', sourceId: 'src', sourcePageIndex: 0, widthPt: 595, heightPt: 842, rotation: 0, background: null },
      { id: pNote, position: 2, kind: 'note', sourceId: null, sourcePageIndex: null, widthPt: 595, heightPt: 842, rotation: 0, background: { type: 'grid', spacingPt: 14.17, color: '#B9C3CE', lineWidthPt: 0.5 } },
    ];
    const widgets: WidgetRec[] = [];
    for (const [pid, gid] of [[pForm1, gA], [pForm2, gB]] as const) {
      for (const f of fa.fields) for (const w of f.widgets.filter((w) => w.pageIndex === 0)) widgets.push({ id: uid(), pageId: pid, groupId: gid, fieldKey: f.key, sourceWidgetKey: w.widgetKey, geometry: { x: w.x, y: w.y, width: w.width, height: w.height, onValue: w.onValue } });
    }
    // 1x1-PNG (rot), selbst erzeugt
    const pngCanvas = createCanvas(4, 4);
    const pc = pngCanvas.getContext('2d');
    pc.fillStyle = '#00AA00';
    pc.fillRect(0, 0, 4, 4);
    const png = new Uint8Array(pngCanvas.toBuffer('image/png'));
    const anns: Annotation[] = [
      { id: uid(), pageId: pNote, kind: 'text', zIndex: 1, payloadVersion: 1, payload: { x: 60, y: 60, width: 300, height: 80, text: 'Prüfung Äöü ß – ∫ x² dx ≤ ∑ π', fontAssetId: 'bundled-font-regular-v1', fontSize: 16, lineHeight: 1.3, color: '#17212B', align: 'left', orient: 0 } },
      { id: uid(), pageId: pNote, kind: 'highlight', zIndex: 2, payloadVersion: 1, payload: { points: [{ x: 60, y: 70, pressure: 0.5 }, { x: 260, y: 70, pressure: 0.5 }], baseWidth: 18, color: '#FFE600', opacity: 0.5, smoothingVersion: 1 } },
      { id: uid(), pageId: pNote, kind: 'highlight', zIndex: 2, payloadVersion: 1, payload: { points: [{ x: 60, y: 600, pressure: 0.5 }, { x: 200, y: 600, pressure: 0.5 }], baseWidth: 18, color: '#FFE600', opacity: 0.5, smoothingVersion: 1 } },
      { id: uid(), pageId: pNote, kind: 'ink', zIndex: 3, payloadVersion: 1, payload: { points: Array.from({ length: 40 }, (_, i) => ({ x: 80 + i * 6, y: 300 + Math.sin(i / 4) * 30, pressure: 0.3 + (i % 10) / 20 })), baseWidth: 3, color: '#1F4E8C', opacity: 1, smoothingVersion: 1 } },
      { id: uid(), pageId: pNote, kind: 'image', zIndex: 4, payloadVersion: 1, payload: { blobHash: 'a'.repeat(64), x: 400, y: 400, width: 100, height: 100, opacity: 1, orient: 0 } },
      { id: uid(), pageId: pForm1, kind: 'text', zIndex: 1, payloadVersion: 1, payload: { x: 300, y: 300, width: 200, height: 40, text: 'Gedreht 90', fontAssetId: 'bundled-font-regular-v1', fontSize: 14, lineHeight: 1.2, color: '#C62828', align: 'center', orient: 90 } },
    ];
    const snap = snapshotFor(pages, geo, anns, {
      formGroups: [{ id: gA, sourceId: 'src' }, { id: gB, sourceId: 'src' }],
      formValues: [
        { groupId: gA, fieldKey: 'person.name', fieldType: 'text', value: 'Alex Müller' },
        { groupId: gA, fieldKey: 'agree', fieldType: 'checkbox', value: true },
        { groupId: gA, fieldKey: 'studiengang', fieldType: 'radio', value: 'Mathematik' },
        { groupId: gA, fieldKey: 'semester', fieldType: 'dropdown', value: '3' },
        { groupId: gB, fieldKey: 'person.name', fieldType: 'text', value: 'Zweite Kopie' },
      ],
      widgets,
    });
    const out = await composeExport({ snapshot: snap, pageIds: pages.map((p) => p.id), sources: { src: form }, images: { ['a'.repeat(64)]: { bytes: png, kind: 'png' } }, fontBytes });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getForm().getFields().length).toBe(0); // abgeflacht
    const r1 = await render(out, 1, 1.5);
    const r2 = await render(out, 2, 1.5);
    const r3 = await render(out, 3, 1.5);
    writeFileSync(join(outDir, 'form-copy-1.png'), r1.png);
    writeFileSync(join(outDir, 'note-page.png'), r3.png);
    expect(r1.text).toContain('Alex Müller');
    expect(r1.text).not.toContain('Zweite Kopie');
    expect(r2.text).toContain('Zweite Kopie');
    expect(r2.text).not.toContain('Alex Müller');
    expect(r3.text.replace(/\s+/g, ' ')).toContain('Prüfung Äöü ß');
    expect(r3.text).toContain('∫');
    // Bild sichtbar (grün) an der richtigen Stelle
    const g = r3.pixel(450 * 1.5, 450 * 1.5);
    expect(g[1]).toBeGreaterThan(120);
    expect(g[0]).toBeLessThan(60);
    // Textmarker: gelb mit Multiply, darunterliegendes Weiß wird gelb
    const y = r3.pixel(131 * 1.5, 603 * 1.5);
    expect(y[0]).toBeGreaterThan(200);
    expect(y[2]).toBeLessThan(170);
  });

  it('meldet nicht darstellbare Glyphen statt Kästchen zu exportieren', async () => {
    const id = uid();
    const page: PageRec = { id, position: 0, kind: 'note', sourceId: null, sourcePageIndex: null, widthPt: 595, heightPt: 842, rotation: 0, background: { type: 'blank', spacingPt: 20, color: '#000000', lineWidthPt: 0.5 } };
    const ann: Annotation = { id: uid(), pageId: id, kind: 'text', zIndex: 1, payloadVersion: 1, payload: { x: 10, y: 10, width: 200, height: 40, text: 'Hallo 漢字', fontAssetId: 'bundled-font-regular-v1', fontSize: 12, lineHeight: 1.2, color: '#000000', align: 'left', orient: 0 } };
    await expect(composeExport({ snapshot: snapshotFor([page], [], [ann]), pageIds: [id], sources: {}, images: {}, fontBytes })).rejects.toMatchObject({ code: 'GLYPH_MISSING' });
    expect(ExportError).toBeTruthy();
  });

  it('Seitenauswahl: nur gewählte Seiten in gewählter Reihenfolge', async () => {
    const bytes = await makeRotatedPdf();
    const geo = await geometryOf(bytes);
    const pages: PageRec[] = geo.map((sp, i) => ({ id: uid(), position: i, kind: 'pdf', sourceId: 'src', sourcePageIndex: sp.pageIndex, widthPt: sp.widthPt, heightPt: sp.heightPt, rotation: 0, background: null }));
    const sel = [pages[2].id, pages[0].id];
    const out = await composeExport({ snapshot: snapshotFor(pages, geo, []), pageIds: sel, sources: { src: bytes }, images: {}, fontBytes });
    const r1 = await render(out, 1);
    const r2 = await render(out, 2);
    expect(r1.text).toContain('Rotation 180');
    expect(r2.text).toContain('Rotation 0');
  });
});
