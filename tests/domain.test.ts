import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMat, displayMatrix, invert, multiply, nativeRectFromDisplay, objectFrame, transformRect, viewMatrix } from '../src/rendering/geometry';
import { createMetrics } from '../src/rendering/fonts';
import { layoutText } from '../src/rendering/textLayout';
import { applyOps, cmdAddPage, cmdDeletePage, cmdDuplicatePage, cmdMovePage, cmdUpsertAnnotation, fromSnapshot, History, type EditorDoc } from '../src/domain/ops';
import { SaveQueue, MAX_PENDING_WHILE_FAILING } from '../src/domain/saveQueue';
import { rectForLocalSize } from '../src/features/editor/annotationGeometry';
import type { Annotation, DocumentSnapshot, Mutation, Rotation } from '../src/domain/types';

const metrics = createMetrics(new Uint8Array(readFileSync(join(__dirname, '../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf'))));
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

describe('Koordinatenvertrag (Property-Tests)', () => {
  it('Punkt → Viewport → Punkt ist für alle Drehungen und Zoomstufen verlustfrei', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const rot = ([0, 90, 180, 270] as Rotation[])[i % 4];
      const w = 100 + rnd() * 1500, h = 100 + rnd() * 1500, z = 0.5 + rnd() * 3.5;
      const m = viewMatrix(rot, w, h, z);
      const x = rnd() * w, y = rnd() * h;
      const [px, py] = applyMat(m, x, y);
      const [bx, by] = applyMat(invert(m), px, py);
      expect(Math.abs(bx - x)).toBeLessThan(1e-9);
      expect(Math.abs(by - y)).toBeLessThan(1e-9);
      // Seite bleibt im sichtbaren Bereich
      const dispW = rot % 180 ? h : w, dispH = rot % 180 ? w : h;
      expect(px).toBeGreaterThanOrEqual(-1e-9);
      expect(px).toBeLessThanOrEqual(dispW * z + 1e-9);
      expect(py).toBeLessThanOrEqual(dispH * z + 1e-9);
    }
  });

  it('Objektrahmen: lokaler Inhalt erscheint bei passender Darstellung aufrecht', () => {
    for (const rot of [0, 90, 180, 270] as Rotation[]) {
      const r = nativeRectFromDisplay(rot, 595, 842, 100, 50, 200, 40);
      const f = objectFrame(r.x, r.y, r.width, r.height, rot);
      expect(f.localWidth).toBeCloseTo(200, 6);
      const total = multiply(displayMatrix(rot, 595, 842), f.matrix);
      // Lokale x-Achse zeigt auf dem Bildschirm nach rechts, y nach unten
      expect(total[0]).toBeCloseTo(1, 9);
      expect(total[3]).toBeCloseTo(1, 9);
      const [sx, sy] = applyMat(total, 0, 0);
      expect(sx).toBeCloseTo(100, 6);
      expect(sy).toBeCloseTo(50, 6);
    }
  });

  it('Wachsen einer Textbox hält die obere linke Ecke im lokalen Rahmen fest', () => {
    for (const orient of [0, 90, 180, 270] as Rotation[]) {
      const p = { x: 100, y: 100, width: orient % 180 ? 40 : 200, height: orient % 180 ? 200 : 40, orient };
      const before = applyMat(objectFrame(p.x, p.y, p.width, p.height, orient).matrix, 0, 0);
      const r = rectForLocalSize(p, 200, 80);
      const after = applyMat(objectFrame(r.x, r.y, r.width, r.height, orient).matrix, 0, 0);
      expect(after[0]).toBeCloseTo(before[0], 1);
      expect(after[1]).toBeCloseTo(before[1], 1);
    }
  });

  it('transformRect liefert achsparallele Hüllen', () => {
    const r = transformRect(displayMatrix(90, 595, 842), 10, 20, 100, 50);
    expect(r).toEqual({ x: 842 - 70, y: 10, width: 50, height: 100 });
  });
});

describe('Textlayout', () => {
  const base = { fontSize: 12, lineHeight: 1.3, align: 'left' as const };
  it('bricht an Wortgrenzen um und erhält Absätze', () => {
    const l = layoutText({ ...base, text: 'Definition und eigene Anmerkung zur Vorlesung\n\nZweiter Absatz', width: 120 }, metrics);
    expect(l.lines.length).toBeGreaterThan(3);
    for (const line of l.lines) expect(line.width).toBeLessThanOrEqual(120.001);
    expect(l.lines.some((x) => x.text === '')).toBe(true);
  });
  it('trennt überlange Wörter', () => {
    const l = layoutText({ ...base, text: 'Donaudampfschifffahrtsgesellschaftskapitän', width: 60 }, metrics);
    expect(l.lines.length).toBeGreaterThan(2);
    expect(l.lines.map((x) => x.text).join('')).toBe('Donaudampfschifffahrtsgesellschaftskapitän');
  });
  it('richtet rechts und zentriert aus', () => {
    const r = layoutText({ ...base, align: 'right', text: 'abc', width: 200 }, metrics);
    expect(r.lines[0].x + r.lines[0].width).toBeCloseTo(200, 6);
    const c = layoutText({ ...base, align: 'center', text: 'abc', width: 200 }, metrics);
    expect(c.lines[0].x).toBeCloseTo((200 - c.lines[0].width) / 2, 6);
  });
});

function makeDoc(): EditorDoc {
  const p1 = uid(), p2 = uid();
  const snap: DocumentSnapshot = {
    document: { id: uid(), folderId: null, title: 'T', revision: 0, createdAt: '', updatedAt: '', lastOpenedAt: null, pageCount: 2 },
    pages: [
      { id: p1, position: 0, kind: 'pdf', sourceId: 's', sourcePageIndex: 0, widthPt: 595, heightPt: 842, rotation: 0, background: null },
      { id: p2, position: 1, kind: 'note', sourceId: null, sourcePageIndex: null, widthPt: 595, heightPt: 842, rotation: 0, background: { type: 'grid', spacingPt: 14, color: '#000000', lineWidthPt: 0.5 } },
    ],
    annotations: [],
    sources: [],
    sourcePages: [],
    formGroups: [{ id: 'g1', sourceId: 's' }],
    formValues: [{ groupId: 'g1', fieldKey: 'name', fieldType: 'text', value: 'Alex' }],
    widgets: [{ id: uid(), pageId: p1, groupId: 'g1', fieldKey: 'name', sourceWidgetKey: 'name#0', geometry: { x: 1, y: 1, width: 10, height: 10, onValue: null } }],
    view: null,
  };
  return fromSnapshot(snap);
}

const ink = (pageId: string): Annotation => ({ id: uid(), pageId, kind: 'ink', zIndex: 1, payloadVersion: 1, payload: { points: [{ x: 1, y: 1, pressure: 0.5 }], baseWidth: 2, color: '#000000', opacity: 1, smoothingVersion: 1 } });

describe('Befehle und Undo/Redo', () => {
  it('100 Aktionen rückgängig und wiederholt ergeben konsistente Zustände ohne doppelte IDs', () => {
    let doc = makeDoc();
    const h = new History(200);
    const initial = JSON.stringify(doc.pages.map((p) => p.id));
    const snapshots: string[] = [];
    for (let i = 0; i < 100; i++) {
      let cmd;
      const r = i % 5;
      if (r === 0) cmd = cmdUpsertAnnotation(doc, ink(doc.pages[i % doc.pages.length].id));
      else if (r === 1) cmd = cmdDuplicatePage(doc, doc.pages[0].id, uid);
      else if (r === 2) cmd = cmdMovePage(doc, doc.pages[doc.pages.length - 1].id, 0);
      else if (r === 3 && doc.pages.length > 2) cmd = cmdDeletePage(doc, doc.pages[1].id);
      else cmd = cmdAddPage({ id: uid(), kind: 'note', sourceId: null, sourcePageIndex: null, widthPt: 595, heightPt: 842, rotation: 0, background: { type: 'blank', spacingPt: 20, color: '#000000', lineWidthPt: 0.5 }, annotations: [], widgets: [] }, 1);
      snapshots.push(JSON.stringify(doc.pages.map((p) => p.id)));
      doc = applyOps(doc, cmd.ops);
      h.push(cmd);
      const ids = doc.pages.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(doc.widgets.map((w) => w.id)).size).toBe(doc.widgets.length);
    }
    const final = JSON.stringify(doc.pages.map((p) => p.id));
    for (let i = 99; i >= 0; i--) {
      doc = applyOps(doc, h.popUndo()!.inverse);
      expect(JSON.stringify(doc.pages.map((p) => p.id))).toBe(snapshots[i]);
    }
    expect(JSON.stringify(doc.pages.map((p) => p.id))).toBe(initial);
    expect(Object.keys(doc.annotations).length).toBe(0);
    for (let i = 0; i < 100; i++) doc = applyOps(doc, h.popRedo()!.ops);
    expect(JSON.stringify(doc.pages.map((p) => p.id))).toBe(final);
  });

  it('Duplizieren einer Formularseite erzeugt eine neue Gruppe mit kopierten Werten', () => {
    const doc = makeDoc();
    const cmd = cmdDuplicatePage(doc, doc.pages[0].id, uid);
    const next = applyOps(doc, cmd.ops);
    expect(next.pages.length).toBe(3);
    const copy = next.pages[1];
    const w = next.widgets.find((x) => x.pageId === copy.id)!;
    expect(w.groupId).not.toBe('g1');
    expect(Object.values(next.formValues).find((v) => v.groupId === w.groupId)?.value).toBe('Alex');
  });

  it('Texteingabe wird zu einem Verlaufsschritt zusammengefasst', () => {
    const doc = makeDoc();
    const h = new History();
    const a = ink(doc.pages[0].id);
    h.push({ ...cmdUpsertAnnotation(doc, a), coalesceKey: 'k' });
    h.push({ ...cmdUpsertAnnotation(applyOps(doc, [{ op: 'upsertAnnotation', annotation: a }]), { ...a, zIndex: 5 }), coalesceKey: 'k' });
    expect(h.undoStack.length).toBe(1);
    expect(h.undoStack[0].inverse[0].op).toBe('deleteAnnotation');
  });
});

describe('Autosave-Warteschlange', () => {
  const ops = [{ op: 'rename' as const, title: 'x' }];
  it('meldet „gespeichert“ erst nach Bestätigung und wiederholt mit derselben Request-ID', async () => {
    const seen: string[] = [];
    let fail = 2;
    const statuses: string[] = [];
    const q = new SaveQueue('d', 0, async (m: Mutation) => {
      seen.push(m.requestId);
      if (fail-- > 0) throw { code: 'DISK_FULL', message: 'voll', retryable: true };
      return { revision: m.expectedRevision + 1, committedAt: '' };
    }, { onStatus: (s) => statuses.push(s), onRejected: () => undefined }, uid, async () => undefined);
    q.enqueue(ops);
    await new Promise((r) => setTimeout(r, 20));
    expect(new Set(seen).size).toBe(1);
    expect(seen.length).toBe(3);
    expect(q.confirmedRevision).toBe(1);
    expect(statuses.at(-1)).toBe('saved');
    expect(statuses).toContain('error');
  });

  it('flush liefert false bei Fehler statt Erfolg zu melden', async () => {
    const q = new SaveQueue('d', 0, async () => { throw { code: 'DISK_FULL', message: 'voll', retryable: true }; }, { onStatus: () => undefined, onRejected: () => undefined }, uid, () => new Promise((r) => setTimeout(r, 5)));
    q.enqueue(ops);
    expect(await q.flush()).toBe(false);
    expect(q.hasUnsaved).toBe(true);
    q.stop();
  });

  it('nicht wiederholbare Fehler verwerfen den lokalen Stand und melden ihn', async () => {
    let rejected = 0;
    const q = new SaveQueue('d', 0, async () => { throw { code: 'REVISION_CONFLICT', message: 'k', retryable: false }; }, { onStatus: () => undefined, onRejected: () => rejected++ }, uid, async () => undefined);
    q.enqueue(ops);
    expect(await q.flush()).toBe(false);
    expect(rejected).toBe(1);
    expect(q.hasUnsaved).toBe(false);
  });

  it('begrenzt weitere Bearbeitung bei dauerhaftem Speicherfehler', async () => {
    const q = new SaveQueue('d', 0, async () => { throw { code: 'DISK_FULL', message: 'voll', retryable: true }; }, { onStatus: () => undefined, onRejected: () => undefined }, uid, () => new Promise((r) => setTimeout(r, 1)));
    q.enqueue(ops);
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < MAX_PENDING_WHILE_FAILING; i++) q.enqueue(ops);
    await new Promise((r) => setTimeout(r, 20));
    expect(q.editingBlocked).toBe(true);
    q.stop();
  });
});
