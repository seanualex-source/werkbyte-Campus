// Editorzustand: geöffnetes Dokument, Werkzeuge, Auswahl, Verlauf und Speicherstatus.

import { create } from 'zustand';
import type { Annotation, DocumentSnapshot, Op } from '../../domain/types';
import { applyOps, fromSnapshot, History, type Command, type EditorDoc } from '../../domain/ops';
import { SaveQueue, type SaveError, type SaveStatus } from '../../domain/saveQueue';
import { api } from '../../ipc/api';

export type Tool = 'select' | 'hand' | 'text' | 'image' | 'pen' | 'highlight' | 'eraser';

export interface ToolOptions {
  penColor: string;
  penWidth: number;
  highlightColor: string;
  highlightWidth: number;
  textColor: string;
  textSize: number;
}

export interface EditorState {
  documentId: string | null;
  doc: EditorDoc | null;
  loading: boolean;
  loadError: string | null;
  tool: Tool;
  options: ToolOptions;
  selectedAnnotationId: string | null;
  editingTextId: string | null;
  selectedPageIds: string[];
  currentPageIndex: number;
  zoom: number;
  fitWidth: boolean;
  saveStatus: SaveStatus;
  saveError: SaveError | null;
  canUndo: boolean;
  canRedo: boolean;
  notice: string | null;
}

const initial: EditorState = {
  documentId: null,
  doc: null,
  loading: false,
  loadError: null,
  tool: 'select',
  options: { penColor: '#1F4E8C', penWidth: 2.2, highlightColor: '#FFE600', highlightWidth: 14, textColor: '#17212B', textSize: 12 },
  selectedAnnotationId: null,
  editingTextId: null,
  selectedPageIds: [],
  currentPageIndex: 0,
  zoom: 1,
  fitWidth: true,
  saveStatus: 'saved',
  saveError: null,
  canUndo: false,
  canRedo: false,
  notice: null,
};

export const useEditor = create<EditorState>(() => ({ ...initial }));

const history = new History(200);
let queue: SaveQueue | null = null;

export const newId = () => crypto.randomUUID();

function syncHistory() {
  useEditor.setState({ canUndo: history.undoStack.length > 0, canRedo: history.redoStack.length > 0 });
}

function applyLocal(ops: Op[]) {
  const s = useEditor.getState();
  if (!s.doc) return;
  useEditor.setState({ doc: applyOps(s.doc, ops) });
}

async function reloadAfterRejection(error: SaveError) {
  const id = useEditor.getState().documentId;
  if (!id) return;
  history.clear();
  syncHistory();
  try {
    const snap = await api.documentLoad(id);
    attach(snap);
    useEditor.setState({ notice: `Änderung wurde nicht übernommen: ${error.message} Der zuletzt gespeicherte Stand wurde neu geladen.` });
  } catch (e) {
    useEditor.setState({ loadError: String((e as Error)?.message ?? e) });
  }
}

function attach(snap: DocumentSnapshot) {
  queue?.stop();
  queue = new SaveQueue(
    snap.document.id,
    snap.document.revision,
    (m) => api.documentApply(m),
    {
      onStatus: (status, error) => useEditor.setState({ saveStatus: status, saveError: error ?? null }),
      onRejected: (error) => void reloadAfterRejection(error),
    },
    newId,
  );
  useEditor.setState({ doc: fromSnapshot(snap), saveStatus: 'saved', saveError: null, selectedAnnotationId: null, editingTextId: null });
}

export const editor = {
  async open(documentId: string) {
    history.clear();
    useEditor.setState({ ...initial, documentId, loading: true, options: useEditor.getState().options });
    try {
      const snap = await api.documentLoad(documentId);
      attach(snap);
      const view = snap.view;
      if (view) {
        const idx = Math.max(0, snap.pages.findIndex((p) => p.id === view.pageId));
        useEditor.setState({ zoom: view.zoom, fitWidth: false, currentPageIndex: idx });
      }
    } catch (e) {
      useEditor.setState({ loadError: String((e as Error)?.message ?? e) });
    } finally {
      useEditor.setState({ loading: false });
      syncHistory();
    }
  },

  /** Wendet einen Befehl lokal an, legt ihn in den Verlauf und reiht ihn zum Speichern ein. */
  dispatch(cmd: Command, coalesceKey?: string) {
    if (!cmd.ops.length) return;
    if (queue?.editingBlocked) {
      useEditor.setState({ notice: 'Speichern schlägt wiederholt fehl. Weitere Änderungen sind gesperrt, bis das Speichern wieder funktioniert.' });
      return;
    }
    applyLocal(cmd.ops);
    history.push({ ...cmd, coalesceKey });
    queue?.enqueue(cmd.ops);
    syncHistory();
  },

  sealHistory() {
    history.seal();
  },

  undo() {
    const e = history.popUndo();
    if (!e) return;
    applyLocal(e.inverse);
    queue?.enqueue(e.inverse);
    useEditor.setState({ selectedAnnotationId: null, editingTextId: null });
    syncHistory();
  },

  redo() {
    const e = history.popRedo();
    if (!e) return;
    applyLocal(e.ops);
    queue?.enqueue(e.ops);
    syncHistory();
  },

  flush(): Promise<boolean> {
    return queue ? queue.flush() : Promise.resolve(true);
  },

  hasUnsaved(): boolean {
    return queue?.hasUnsaved ?? false;
  },

  async close() {
    const ok = await editor.flush();
    const s = useEditor.getState();
    if (ok && s.documentId && s.doc) {
      const page = s.doc.pages[s.currentPageIndex];
      await api.documentSetView(s.documentId, { pageId: page?.id ?? null, zoom: s.zoom, scrollOffset: 0 }).catch(() => undefined);
    }
    queue?.stop();
    queue = null;
    history.clear();
    useEditor.setState({ ...initial, options: s.options });
    return ok;
  },

  annotation(id: string | null): Annotation | null {
    if (!id) return null;
    return useEditor.getState().doc?.annotations[id] ?? null;
  },
};
