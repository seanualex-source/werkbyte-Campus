// Lokales Dokumentmodell des Editors. Jede Nutzeraktion ist ein Fachbefehl (Op) mit Inversem;
// lokal wird optimistisch angewendet, persistiert wird über denselben Befehlsweg (§6.3, §16).

import type {
  Annotation,
  DocumentSnapshot,
  FormValue,
  FormValueRec,
  NoteBackground,
  Op,
  PageBundle,
  PageRec,
  Rotation,
  WidgetRec,
} from './types';

export interface EditorDoc {
  snapshot: DocumentSnapshot;
  /** Seiten in Reihenfolge. */
  pages: PageRec[];
  annotations: Record<string, Annotation>;
  widgets: WidgetRec[];
  formValues: Record<string, FormValueRec>;
  title: string;
}

export const fvKey = (groupId: string, fieldKey: string) => `${groupId}\u0000${fieldKey}`;

export function fromSnapshot(s: DocumentSnapshot): EditorDoc {
  const annotations: Record<string, Annotation> = {};
  for (const a of s.annotations) annotations[a.id] = { ...a, payload: { orient: 0, ...a.payload } } as Annotation;
  const formValues: Record<string, FormValueRec> = {};
  for (const v of s.formValues) formValues[fvKey(v.groupId, v.fieldKey)] = v;
  return { snapshot: s, pages: [...s.pages].sort((a, b) => a.position - b.position), annotations, widgets: s.widgets, formValues, title: s.document.title };
}

export function annotationsOfPage(doc: EditorDoc, pageId: string): Annotation[] {
  return Object.values(doc.annotations)
    .filter((a) => a.pageId === pageId)
    .sort((a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1));
}

export function bundleOf(doc: EditorDoc, pageId: string): PageBundle {
  const p = doc.pages.find((x) => x.id === pageId);
  if (!p) throw new Error('Seite nicht gefunden');
  return {
    id: p.id,
    kind: p.kind,
    sourceId: p.sourceId,
    sourcePageIndex: p.sourcePageIndex,
    widthPt: p.widthPt,
    heightPt: p.heightPt,
    rotation: p.rotation,
    background: p.background,
    annotations: annotationsOfPage(doc, pageId),
    widgets: doc.widgets.filter((w) => w.pageId === pageId),
  };
}

function reposition(pages: PageRec[]): PageRec[] {
  return pages.map((p, i) => (p.position === i ? p : { ...p, position: i }));
}

export function applyOp(doc: EditorDoc, op: Op): EditorDoc {
  switch (op.op) {
    case 'addPage': {
      const b = op.page;
      const page: PageRec = { id: b.id, position: 0, kind: b.kind, sourceId: b.sourceId, sourcePageIndex: b.sourcePageIndex, widthPt: b.widthPt, heightPt: b.heightPt, rotation: b.rotation, background: b.background };
      const pages = [...doc.pages];
      pages.splice(Math.max(0, Math.min(op.position, pages.length)), 0, page);
      const annotations = { ...doc.annotations };
      for (const a of b.annotations) annotations[a.id] = a;
      return { ...doc, pages: reposition(pages), annotations, widgets: [...doc.widgets, ...b.widgets] };
    }
    case 'deletePage': {
      const annotations: Record<string, Annotation> = {};
      for (const [k, a] of Object.entries(doc.annotations)) if (a.pageId !== op.pageId) annotations[k] = a;
      return { ...doc, pages: reposition(doc.pages.filter((p) => p.id !== op.pageId)), annotations, widgets: doc.widgets.filter((w) => w.pageId !== op.pageId) };
    }
    case 'movePage': {
      const page = doc.pages.find((p) => p.id === op.pageId);
      if (!page) return doc;
      const pages = doc.pages.filter((p) => p.id !== op.pageId);
      pages.splice(Math.max(0, Math.min(op.toPosition, pages.length)), 0, page);
      return { ...doc, pages: reposition(pages) };
    }
    case 'rotatePage':
      return { ...doc, pages: doc.pages.map((p) => (p.id === op.pageId ? { ...p, rotation: op.rotation } : p)) };
    case 'setBackground':
      return { ...doc, pages: doc.pages.map((p) => (p.id === op.pageId ? { ...p, background: op.background } : p)) };
    case 'upsertAnnotation':
      return { ...doc, annotations: { ...doc.annotations, [op.annotation.id]: op.annotation } };
    case 'deleteAnnotation': {
      const annotations = { ...doc.annotations };
      delete annotations[op.annotationId];
      return { ...doc, annotations };
    }
    case 'createFormGroup': {
      const formValues = { ...doc.formValues };
      for (const v of op.values) formValues[fvKey(v.groupId, v.fieldKey)] = v;
      const groups = doc.snapshot.formGroups.some((g) => g.id === op.groupId)
        ? doc.snapshot.formGroups
        : [...doc.snapshot.formGroups, { id: op.groupId, sourceId: op.sourceId }];
      return { ...doc, formValues, snapshot: { ...doc.snapshot, formGroups: groups } };
    }
    case 'setFormValue': {
      const k = fvKey(op.groupId, op.fieldKey);
      const prev = doc.formValues[k];
      const fieldType = prev?.fieldType ?? 'text';
      return { ...doc, formValues: { ...doc.formValues, [k]: { groupId: op.groupId, fieldKey: op.fieldKey, fieldType, value: op.value } } };
    }
    case 'rename':
      return { ...doc, title: op.title };
  }
}

export function applyOps(doc: EditorDoc, ops: Op[]): EditorDoc {
  return ops.reduce(applyOp, doc);
}

// ───────────── Befehle mit Inversem ─────────────

export interface Command {
  label: string;
  ops: Op[];
  inverse: Op[];
}

export function cmdUpsertAnnotation(doc: EditorDoc, a: Annotation, label = 'Objekt ändern'): Command {
  const prev = doc.annotations[a.id];
  return {
    label,
    ops: [{ op: 'upsertAnnotation', annotation: a }],
    inverse: prev ? [{ op: 'upsertAnnotation', annotation: prev }] : [{ op: 'deleteAnnotation', annotationId: a.id }],
  };
}

export function cmdDeleteAnnotations(doc: EditorDoc, ids: string[], label = 'Objekt löschen'): Command {
  const prev = ids.map((id) => doc.annotations[id]).filter(Boolean);
  return {
    label,
    ops: prev.map((a) => ({ op: 'deleteAnnotation', annotationId: a.id }) as Op),
    inverse: prev.map((a) => ({ op: 'upsertAnnotation', annotation: a }) as Op),
  };
}

export function cmdAddPage(bundle: PageBundle, position: number, label = 'Seite einfügen'): Command {
  return { label, ops: [{ op: 'addPage', page: bundle, position }], inverse: [{ op: 'deletePage', pageId: bundle.id }] };
}

export function cmdDeletePage(doc: EditorDoc, pageId: string): Command {
  const idx = doc.pages.findIndex((p) => p.id === pageId);
  return { label: 'Seite löschen', ops: [{ op: 'deletePage', pageId }], inverse: [{ op: 'addPage', page: bundleOf(doc, pageId), position: idx }] };
}

export function cmdMovePage(doc: EditorDoc, pageId: string, to: number): Command {
  const from = doc.pages.findIndex((p) => p.id === pageId);
  return { label: 'Seite verschieben', ops: [{ op: 'movePage', pageId, toPosition: to }], inverse: [{ op: 'movePage', pageId, toPosition: from }] };
}

export function cmdRotatePage(doc: EditorDoc, pageId: string, rotation: Rotation): Command {
  const prev = doc.pages.find((p) => p.id === pageId)!.rotation;
  return { label: 'Seite drehen', ops: [{ op: 'rotatePage', pageId, rotation }], inverse: [{ op: 'rotatePage', pageId, rotation: prev }] };
}

export function cmdSetBackground(doc: EditorDoc, pageId: string, background: NoteBackground): Command {
  const prev = doc.pages.find((p) => p.id === pageId)!.background!;
  return { label: 'Hintergrund ändern', ops: [{ op: 'setBackground', pageId, background }], inverse: [{ op: 'setBackground', pageId, background: prev }] };
}

export function cmdSetFormValue(doc: EditorDoc, groupId: string, fieldKey: string, value: FormValue): Command {
  const prev = doc.formValues[fvKey(groupId, fieldKey)]?.value ?? null;
  return {
    label: 'Formularfeld ändern',
    ops: [{ op: 'setFormValue', groupId, fieldKey, value }],
    inverse: [{ op: 'setFormValue', groupId, fieldKey, value: prev }],
  };
}

export function cmdRename(doc: EditorDoc, title: string): Command {
  return { label: 'Umbenennen', ops: [{ op: 'rename', title }], inverse: [{ op: 'rename', title: doc.title }] };
}

/**
 * Seite duplizieren: neue Seiten- und Objekt-IDs. Formular-Widgets erhalten eine neue Gruppe
 * mit kopierten Werten (§5.4), damit die Kopie unabhängig bleibt.
 */
export function cmdDuplicatePage(doc: EditorDoc, pageId: string, newId: () => string): Command {
  const src = bundleOf(doc, pageId);
  const idx = doc.pages.findIndex((p) => p.id === pageId);
  const pid = newId();
  const ops: Op[] = [];
  const groupMap = new Map<string, string>();
  for (const w of src.widgets) {
    if (!groupMap.has(w.groupId)) {
      const g = newId();
      groupMap.set(w.groupId, g);
      const sourceId = doc.snapshot.formGroups.find((x) => x.id === w.groupId)?.sourceId ?? src.sourceId!;
      const values = Object.values(doc.formValues).filter((v) => v.groupId === w.groupId).map((v) => ({ ...v, groupId: g }));
      ops.push({ op: 'createFormGroup', groupId: g, sourceId, values });
    }
  }
  const bundle: PageBundle = {
    ...src,
    id: pid,
    annotations: src.annotations.map((a) => ({ ...a, id: newId(), pageId: pid }) as Annotation),
    widgets: src.widgets.map((w) => ({ ...w, id: newId(), pageId: pid, groupId: groupMap.get(w.groupId)! })),
  };
  ops.push({ op: 'addPage', page: bundle, position: idx + 1 });
  return { label: 'Seite duplizieren', ops, inverse: [{ op: 'deletePage', pageId: pid }] };
}

export function nextZ(doc: EditorDoc, pageId: string): number {
  let z = 0;
  for (const a of Object.values(doc.annotations)) if (a.pageId === pageId && a.zIndex > z) z = a.zIndex;
  return z + 1;
}

// ───────────── Verlauf ─────────────

export interface HistoryEntry extends Command {
  coalesceKey?: string;
}

export class History {
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  constructor(public limit = 200) {}

  push(entry: HistoryEntry) {
    const top = this.undoStack[this.undoStack.length - 1];
    if (entry.coalesceKey && top?.coalesceKey === entry.coalesceKey) {
      // Laufende Texteingabe zu einem Schritt zusammenfassen: Inverses des ersten Schritts behalten.
      top.ops = entry.ops;
      top.label = entry.label;
    } else {
      this.undoStack.push(entry);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
  }
  /** Beendet eine Zusammenfassungs-Sitzung, damit die nächste Eingabe ein neuer Schritt wird. */
  seal() {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.coalesceKey = undefined;
  }
  popUndo(): HistoryEntry | undefined {
    const e = this.undoStack.pop();
    if (e) this.redoStack.push(e);
    return e;
  }
  popRedo(): HistoryEntry | undefined {
    const e = this.redoStack.pop();
    if (e) this.undoStack.push(e);
    return e;
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
