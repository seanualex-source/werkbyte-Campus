import { create } from 'zustand';
import type { DocumentSummary, FolderRec } from '../../domain/types';
import { api, errorMessage } from '../../ipc/api';
import { toast } from '../../app/ui';

export type LibraryView = { kind: 'all' } | { kind: 'recent' } | { kind: 'folder'; folderId: string } | { kind: 'trash' };

interface LibraryState {
  folders: FolderRec[];
  documents: DocumentSummary[];
  view: LibraryView;
  query: string;
  sort: 'name' | 'updated' | 'pages';
  expanded: Record<string, boolean>;
  selectedDocIds: string[];
  loading: boolean;
}

export const useLibrary = create<LibraryState>(() => ({
  folders: [],
  documents: [],
  view: { kind: 'all' },
  query: '',
  sort: 'updated',
  expanded: {},
  selectedDocIds: [],
  loading: false,
}));

export async function refreshLibrary() {
  const s = useLibrary.getState();
  useLibrary.setState({ loading: true });
  try {
    const folders = await api.folderList();
    let documents: DocumentSummary[] = [];
    if (s.view.kind === 'all') documents = await api.documentList('all', null, s.query);
    else if (s.view.kind === 'recent') documents = await api.documentList('recent', null, s.query);
    else if (s.view.kind === 'folder') {
      if (!folders.some((f) => f.id === (s.view as { folderId: string }).folderId)) {
        useLibrary.setState({ view: { kind: 'all' } });
        return refreshLibrary();
      }
      documents = await api.documentList('folder', s.view.folderId, s.query);
    }
    const ids = new Set(documents.map((d) => d.id));
    useLibrary.setState({ folders, documents, selectedDocIds: useLibrary.getState().selectedDocIds.filter((i) => ids.has(i)) });
  } catch (e) {
    toast(`Bibliothek konnte nicht geladen werden: ${errorMessage(e)}`, 'error');
  } finally {
    useLibrary.setState({ loading: false });
  }
}

export function setView(view: LibraryView) {
  useLibrary.setState({ view, selectedDocIds: [] });
  void refreshLibrary();
}

export function currentFolderId(): string | null {
  const v = useLibrary.getState().view;
  return v.kind === 'folder' ? v.folderId : null;
}

export function folderPath(folders: FolderRec[], id: string | null): FolderRec[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: FolderRec[] = [];
  let cur = id ? byId.get(id) : undefined;
  let guard = 0;
  while (cur && guard++ < 40) {
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}
