// In-Memory-IPC-Double für Browser-Entwicklung und UI-Tests (§13.1). Bildet die Semantik der
// Rust-Befehle vereinfacht nach (Revisionen, Idempotenz, Kopiersemantik), speichert aber nichts dauerhaft.

import type { Transport } from './api';
import type {
  Annotation,
  DocumentSnapshot,
  DocumentSummary,
  FolderRec,
  FormGroupRec,
  ImportAnalysis,
  Mutation,
  PageRec,
  SourcePageRec,
  SourceRec,
  StageReport,
  TrashItem,
  WidgetRec,
  FormValueRec,
} from '../domain/types';
import { applyOps, fromSnapshot, type EditorDoc } from '../domain/ops';

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface StoredDoc {
  summary: DocumentSummary;
  doc: EditorDoc;
  deletedAt: string | null;
  batch: string | null;
}

function err(code: string, message: string, retryable = false) {
  return { code: code as never, message, retryable };
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export function createMemoryTransport(): Transport {
  const folders: (FolderRec & { deletedAt: string | null; batch: string | null })[] = [];
  const docs = new Map<string, StoredDoc>();
  const sources = new Map<string, { rec: SourceRec; pages: SourcePageRec[] }>();
  const blobs = new Map<string, Uint8Array>();
  const staged = new Map<string, { name: string; bytes: Uint8Array; hash: string }>();
  const applied = new Map<string, unknown>();
  const listeners = new Map<string, ((p: unknown) => void)[]>();

  const liveFolder = (id: string | null) => id === null || folders.some((f) => f.id === id && !f.deletedAt);

  function snapshot(s: StoredDoc): DocumentSnapshot {
    const d = s.doc;
    const srcIds = new Set<string>();
    d.pages.forEach((p) => p.sourceId && srcIds.add(p.sourceId));
    d.snapshot.formGroups.forEach((g) => srcIds.add(g.sourceId));
    const sp: SourcePageRec[] = [];
    const recs: SourceRec[] = [];
    for (const id of srcIds) {
      const src = sources.get(id);
      if (!src) continue;
      recs.push(src.rec);
      for (const p of src.pages) if (d.pages.some((x) => x.sourceId === id && x.sourcePageIndex === p.pageIndex)) sp.push(p);
    }
    return {
      document: { ...s.summary, title: d.title, pageCount: d.pages.length },
      pages: d.pages.map((p, i) => ({ ...p, position: i })),
      annotations: Object.values(d.annotations),
      sources: recs,
      sourcePages: sp,
      formGroups: d.snapshot.formGroups,
      formValues: Object.values(d.formValues),
      widgets: d.widgets,
      view: null,
    };
  }

  function createDoc(folderId: string | null, title: string, pages: PageRec[], extra?: Partial<DocumentSnapshot>): string {
    const id = uuid();
    const same = [...docs.values()].filter((d) => !d.deletedAt && d.summary.folderId === folderId).map((d) => d.doc.title);
    let t = title;
    for (let n = 2; same.includes(t); n++) t = `${title} (${n})`;
    const summary: DocumentSummary = { id, folderId, title: t, revision: 0, createdAt: now(), updatedAt: now(), lastOpenedAt: null, pageCount: pages.length };
    const snap: DocumentSnapshot = { document: summary, pages, annotations: [], sources: [], sourcePages: [], formGroups: [], formValues: [], widgets: [], view: null, ...extra };
    docs.set(id, { summary, doc: fromSnapshot(snap), deletedAt: null, batch: null });
    return id;
  }

  const handlers: Record<string, (a: any, raw?: Uint8Array, h?: Record<string, string>) => unknown | Promise<unknown>> = {
    app_info: () => ({ version: 'browser-dev', library: { libraryId: 'memory', root: 'Arbeitsspeicher (Browser-Vorschau)', schemaVersion: 1, migrated: [], recoveredStagingFiles: 0 }, error: null }),
    library_choose_location: () => null,
    library_retry: () => handlers.app_info({}),
    folder_list: () => folders.filter((f) => !f.deletedAt).map(({ deletedAt: _d, batch: _b, ...f }) => f),
    folder_create: ({ parentId, name }) => {
      if (!String(name).trim()) throw err('INVALID', 'Ordnername darf nicht leer sein.');
      if (!liveFolder(parentId)) throw err('NOT_FOUND', 'Elternordner nicht gefunden.');
      const f = { id: uuid(), parentId, name: String(name).trim(), sortOrder: folders.length, createdAt: now(), updatedAt: now(), deletedAt: null, batch: null };
      folders.push(f);
      return f;
    },
    folder_rename: ({ id, name }) => {
      const f = folders.find((x) => x.id === id);
      if (f) f.name = name;
    },
    folder_move: ({ id, parentId }) => {
      let cur: string | null = parentId;
      while (cur) {
        if (cur === id) throw err('INVALID', 'Ein Ordner kann nicht in sich selbst verschoben werden.');
        cur = folders.find((x) => x.id === cur)?.parentId ?? null;
      }
      const f = folders.find((x) => x.id === id);
      if (f) f.parentId = parentId;
    },
    folder_trash: ({ id }) => {
      const batch = uuid();
      const ids = [id];
      for (let i = 0; i < ids.length; i++) folders.filter((f) => f.parentId === ids[i] && !f.deletedAt).forEach((f) => ids.push(f.id));
      for (const f of folders) if (ids.includes(f.id) && !f.deletedAt) Object.assign(f, { deletedAt: now(), batch });
      for (const d of docs.values()) if (d.summary.folderId && ids.includes(d.summary.folderId) && !d.deletedAt) Object.assign(d, { deletedAt: now(), batch });
      return batch;
    },
    document_list: ({ args }) => {
      let list = [...docs.values()].filter((d) => !d.deletedAt);
      if (args.kind === 'folder') list = list.filter((d) => d.summary.folderId === args.folderId);
      if (args.kind === 'root') list = list.filter((d) => d.summary.folderId === null);
      if (args.kind === 'recent') list = list.filter((d) => d.summary.lastOpenedAt).sort((a, b) => (b.summary.lastOpenedAt! > a.summary.lastOpenedAt! ? 1 : -1));
      const q = (args.query ?? '').toLowerCase();
      return list.filter((d) => d.doc.title.toLowerCase().includes(q)).map((d) => ({ ...d.summary, title: d.doc.title, pageCount: d.doc.pages.length }));
    },
    document_create_note: ({ folderId, title, paper }) => {
      const land = paper.orientation === 'landscape';
      return createDoc(folderId, title, [{ id: uuid(), position: 0, kind: 'note', sourceId: null, sourcePageIndex: null, widthPt: land ? 841.8898 : 595.2756, heightPt: land ? 595.2756 : 841.8898, rotation: 0, background: paper.background }]);
    },
    document_rename: ({ id, title }) => {
      const d = docs.get(id)!;
      d.doc = { ...d.doc, title };
      d.summary.revision++;
    },
    document_move: ({ id, folderId }) => {
      docs.get(id)!.summary.folderId = folderId;
    },
    document_trash: ({ id }) => {
      const batch = uuid();
      Object.assign(docs.get(id)!, { deletedAt: now(), batch });
      return batch;
    },
    document_load: ({ id }) => {
      const d = docs.get(id);
      if (!d || d.deletedAt) throw err('NOT_FOUND', 'Dokument nicht gefunden.');
      d.summary.lastOpenedAt = now();
      return snapshot(d);
    },
    document_apply: ({ mutation }: { mutation: Mutation }) => {
      if (applied.has(mutation.requestId)) return applied.get(mutation.requestId);
      const d = docs.get(mutation.documentId);
      if (!d) throw err('NOT_FOUND', 'Dokument nicht gefunden.');
      if (d.summary.revision !== mutation.expectedRevision) throw err('REVISION_CONFLICT', 'Revisionskonflikt.');
      for (const op of mutation.payload) if (op.op === 'deletePage' && d.doc.pages.length <= 1) throw err('INVALID', 'Die letzte Seite kann nicht gelöscht werden.');
      d.doc = applyOps(d.doc, mutation.payload);
      if (d.doc.pages.length < 1) throw err('INVALID', 'Ein Dokument braucht eine Seite.');
      d.summary.revision++;
      d.summary.updatedAt = now();
      const res = { revision: d.summary.revision, committedAt: now() };
      applied.set(mutation.requestId, res);
      return res;
    },
    document_compose: ({ title, folderId, parts }) => {
      const pages: PageRec[] = [];
      const annotations: Annotation[] = [];
      const widgets: WidgetRec[] = [];
      const groups: FormGroupRec[] = [];
      const values: FormValueRec[] = [];
      parts.forEach((part: { documentId: string; pageIds: string[] | null }) => {
        const d = docs.get(part.documentId)!.doc;
        const gmap = new Map<string, string>();
        for (const p of d.pages.filter((x) => !part.pageIds || part.pageIds.includes(x.id))) {
          const pid = uuid();
          pages.push({ ...p, id: pid, position: pages.length });
          for (const a of Object.values(d.annotations).filter((a) => a.pageId === p.id)) annotations.push({ ...a, id: uuid(), pageId: pid } as Annotation);
          for (const w of d.widgets.filter((w) => w.pageId === p.id)) {
            if (!gmap.has(w.groupId)) {
              const g = uuid();
              gmap.set(w.groupId, g);
              groups.push({ id: g, sourceId: d.snapshot.formGroups.find((x) => x.id === w.groupId)!.sourceId });
              Object.values(d.formValues).filter((v) => v.groupId === w.groupId).forEach((v) => values.push({ ...v, groupId: g }));
            }
            widgets.push({ ...w, id: uuid(), pageId: pid, groupId: gmap.get(w.groupId)! });
          }
        }
      });
      return createDoc(folderId, title, pages, { annotations, widgets, formGroups: groups, formValues: values });
    },
    document_set_view: () => undefined,
    trash_list: () => {
      const items: TrashItem[] = [];
      const batches = new Set<string>();
      for (const f of folders) if (f.batch && !batches.has(f.batch) && !folders.some((p) => p.id === f.parentId && p.batch === f.batch)) {
        batches.add(f.batch);
        items.push({ batchId: f.batch, deletedAt: f.deletedAt!, kind: 'folder', id: f.id, name: f.name, folderCount: folders.filter((x) => x.batch === f.batch).length, documentCount: [...docs.values()].filter((d) => d.batch === f.batch).length });
      }
      for (const d of docs.values()) if (d.batch && !batches.has(d.batch)) items.push({ batchId: d.batch, deletedAt: d.deletedAt!, kind: 'document', id: d.summary.id, name: d.doc.title, folderCount: 0, documentCount: 1 });
      return items;
    },
    trash_summary: () => ({ batchCount: (handlers.trash_list({}) as TrashItem[]).length, folderCount: folders.filter((f) => f.deletedAt).length, documentCount: [...docs.values()].filter((d) => d.deletedAt).length, freedBytesEstimate: 0 }),
    trash_restore: ({ batchId }) => {
      for (const f of folders) if (f.batch === batchId) Object.assign(f, { deletedAt: null, batch: null });
      for (const d of docs.values()) if (d.batch === batchId) {
        Object.assign(d, { deletedAt: null, batch: null });
        if (!liveFolder(d.summary.folderId)) d.summary.folderId = null;
      }
    },
    trash_purge: ({ batchId }) => {
      for (const [k, d] of docs) if (d.batch === batchId) docs.delete(k);
      for (let i = folders.length - 1; i >= 0; i--) if (folders[i].batch === batchId) folders.splice(i, 1);
    },
    trash_empty: () => {
      let n = 0;
      for (const [k, d] of docs) if (d.deletedAt) { docs.delete(k); n++; }
      for (let i = folders.length - 1; i >= 0; i--) if (folders[i].deletedAt) folders.splice(i, 1);
      return n;
    },
    import_pick: async (): Promise<StageReport> => {
      const files = await pickFiles('application/pdf,.pdf', true);
      const report: StageReport = { staged: [], failed: [] };
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
        if (!head.includes('%PDF-')) {
          report.failed.push({ name: f.name, error: err('PDF_UNSUPPORTED', 'Der Dateityp wird nicht unterstützt.') });
          continue;
        }
        const id = uuid();
        const hash = await sha256(bytes);
        staged.set(id, { name: f.name, bytes, hash });
        report.staged.push({ stagingId: id, name: f.name, size: bytes.length, hash });
      }
      return report;
    },
    import_staged_read: ({ stagingId }) => staged.get(stagingId)!.bytes.slice().buffer,
    import_commit: ({ stagingId, analysis }: { stagingId: string; analysis: ImportAnalysis }) => {
      const st = staged.get(stagingId)!;
      blobs.set(st.hash, st.bytes);
      const sid = uuid();
      sources.set(sid, {
        rec: { id: sid, blobHash: st.hash, pageCount: analysis.pageCount, originalName: st.name, compatibility: { warnings: analysis.warnings, hasForms: analysis.fields.length > 0 }, fields: analysis.fields.map((f) => ({ fieldKey: f.key, fieldType: f.fieldType, options: f.options, multiline: f.multiline, maxLength: f.maxLength })) },
        pages: analysis.pages.map((p) => ({ sourceId: sid, pageIndex: p.index, cropX: p.cropX, cropY: p.cropY, widthPt: p.widthPt, heightPt: p.heightPt, intrinsicRotation: p.intrinsicRotation, userUnit: p.userUnit })),
      });
      const pages: PageRec[] = analysis.pages.map((p) => ({ id: uuid(), position: p.index, kind: 'pdf', sourceId: sid, sourcePageIndex: p.index, widthPt: p.widthPt, heightPt: p.heightPt, rotation: 0, background: null }));
      const extra: Partial<DocumentSnapshot> = {};
      if (analysis.fields.length) {
        const g = uuid();
        extra.formGroups = [{ id: g, sourceId: sid }];
        extra.formValues = analysis.fields.map((f) => ({ groupId: g, fieldKey: f.key, fieldType: f.fieldType, value: f.value }));
        extra.widgets = analysis.fields.flatMap((f) => f.widgets.map((w) => ({ id: uuid(), pageId: pages[w.pageIndex].id, groupId: g, fieldKey: f.key, sourceWidgetKey: w.widgetKey, geometry: { x: w.x, y: w.y, width: w.width, height: w.height, onValue: w.onValue } })));
      }
      staged.delete(stagingId);
      return createDoc(analysis.folderId, analysis.title, pages, extra);
    },
    import_discard: ({ stagingId }) => void staged.delete(stagingId),
    blob_read: ({ hash }) => {
      const b = blobs.get(hash);
      if (!b) throw err('FILE_MISSING', 'Objekt fehlt.');
      return b.slice().buffer;
    },
    image_pick: async () => {
      const [f] = await pickFiles('image/png,image/jpeg', false);
      if (!f) return null;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const hash = await sha256(bytes);
      blobs.set(hash, bytes);
      const bmp = await createImageBitmap(new Blob([bytes]));
      return { hash, kind: bytes[0] === 0x89 ? 'png' : 'jpeg', widthPx: bmp.width, heightPx: bmp.height };
    },
    export_pick_target: ({ suggestedName }) => `download:${suggestedName}`,
    export_prepare: ({ documentId }) => ({ exportId: uuid(), snapshot: snapshot(docs.get(documentId)!) }),
    export_finish: (_a, raw, h) => {
      const name = (h?.['x-target-token'] ?? 'download:Export').slice(9) + '.pdf';
      const url = URL.createObjectURL(new Blob([raw!.slice().buffer], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return { path: `Download: ${name}`, bytes: raw!.length };
    },
    export_cancel: () => undefined,
    backup_status: () => ({ target: null, targetReachable: false, running: false, lastSuccess: null, lastRun: null, backups: [], sameDriveWarning: false, libraryRoot: 'Arbeitsspeicher' }),
    backup_choose_target: () => {
      throw err('INVALID', 'Sicherungen sind nur in der Desktop-App verfügbar.');
    },
    backup_create: ({ kind }) => {
      if (kind === 'auto') return null;
      throw err('INVALID', 'Sicherungen sind nur in der Desktop-App verfügbar.');
    },
    backup_verify_pick: () => null,
    backup_restore_pick: () => null,
  };

  // Beispielinhalt, damit die Browser-Vorschau nicht leer startet.
  const sem = handlers.folder_create({ parentId: null, name: 'Semester 1' }) as FolderRec;
  const math = handlers.folder_create({ parentId: sem.id, name: 'Mathematik' }) as FolderRec;
  handlers.folder_create({ parentId: sem.id, name: 'Programmierung' });
  handlers.document_create_note({ folderId: math.id, title: 'Vorlesung 1 – Mengenlehre', paper: { orientation: 'portrait', background: { type: 'ruled', spacingPt: 22, color: '#B9C3CE', lineWidthPt: 0.5 } } });

  return {
    async invoke<T>(cmd: string, args?: unknown, headers?: Record<string, string>): Promise<T> {
      const h = handlers[cmd];
      if (!h) throw err('INTERNAL', `Unbekannter Befehl ${cmd}`);
      await new Promise((r) => setTimeout(r, 15));
      const raw = args instanceof Uint8Array ? args : undefined;
      return (await h(raw ? {} : (args ?? {}), raw, headers)) as T;
    },
    async listen<T>(event: string, cb: (p: T) => void) {
      const l = listeners.get(event) ?? [];
      l.push(cb as (p: unknown) => void);
      listeners.set(event, l);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== cb));
    },
  };
}
