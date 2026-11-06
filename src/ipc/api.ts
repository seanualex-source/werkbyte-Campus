// Typisierte Campus-Befehle. In der Desktop-App über Tauri-IPC, im Browser (Entwicklung,
// UI-Tests) über ein In-Memory-Double mit identischer Schnittstelle.

import type {
  ApplyResult,
  BackupResult,
  BackupStatus,
  ComposePart,
  DocumentSnapshot,
  DocumentSummary,
  FolderRec,
  ImportAnalysis,
  ImportedImage,
  LibraryInfo,
  Mutation,
  NoteBackground,
  StageReport,
  TrashItem,
  TrashSummary,
  VerifiedBackup,
  ViewRec,
} from '../domain/types';

export interface CampusErrorDto {
  code: string;
  message: string;
  retryable: boolean;
}

export interface Transport {
  invoke<T>(cmd: string, args?: unknown, headers?: Record<string, string>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
}

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let transportPromise: Promise<Transport> | null = null;

function transport(): Promise<Transport> {
  if (!transportPromise) {
    transportPromise = isTauri()
      ? (async () => {
          const core = await import('@tauri-apps/api/core');
          const ev = await import('@tauri-apps/api/event');
          return {
            invoke: <T>(cmd: string, args?: unknown, headers?: Record<string, string>) =>
              core.invoke<T>(cmd, args as never, headers ? { headers } : undefined),
            listen: async <T>(event: string, cb: (p: T) => void) => ev.listen<T>(event, (e) => cb(e.payload)),
          };
        })()
      : import('./memoryBackend').then((m) => m.createMemoryTransport());
  }
  return transportPromise;
}

export function setTransportForTests(t: Transport) {
  transportPromise = Promise.resolve(t);
}

async function call<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  const t = await transport();
  return t.invoke<T>(cmd, args, headers);
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function errorCode(e: unknown): string | null {
  if (e && typeof e === 'object' && 'code' in e) return String((e as { code: unknown }).code);
  return null;
}

const bytes = (b: ArrayBuffer | Uint8Array | number[]) =>
  b instanceof Uint8Array ? b : Array.isArray(b) ? new Uint8Array(b) : new Uint8Array(b);

export const api = {
  appInfo: () => call<{ version: string; library: LibraryInfo | null; error: CampusErrorDto | null }>('app_info'),
  libraryChooseLocation: () => call<LibraryInfo | null>('library_choose_location'),
  libraryRetry: () => call<LibraryInfo>('library_retry'),

  folderList: () => call<FolderRec[]>('folder_list'),
  folderCreate: (parentId: string | null, name: string) => call<FolderRec>('folder_create', { parentId, name }),
  folderRename: (id: string, name: string) => call<void>('folder_rename', { id, name }),
  folderMove: (id: string, parentId: string | null) => call<void>('folder_move', { id, parentId }),
  folderTrash: (id: string) => call<string>('folder_trash', { id }),

  documentList: (kind: 'all' | 'root' | 'folder' | 'recent', folderId?: string | null, query?: string) =>
    call<DocumentSummary[]>('document_list', { args: { kind, folderId: folderId ?? null, query: query ?? null } }),
  documentCreateNote: (folderId: string | null, title: string, orientation: 'portrait' | 'landscape', background: NoteBackground) =>
    call<string>('document_create_note', { folderId, title, paper: { orientation, background } }),
  documentRename: (id: string, title: string) => call<void>('document_rename', { id, title }),
  documentMove: (id: string, folderId: string | null) => call<void>('document_move', { id, folderId }),
  documentTrash: (id: string) => call<string>('document_trash', { id }),
  documentLoad: (id: string) => call<DocumentSnapshot>('document_load', { id }),
  documentApply: (mutation: Mutation) => call<ApplyResult>('document_apply', { mutation }),
  documentCompose: (title: string, folderId: string | null, parts: ComposePart[]) => call<string>('document_compose', { title, folderId, parts }),
  documentSetView: (id: string, view: ViewRec) => call<void>('document_set_view', { id, view }),

  trashList: () => call<TrashItem[]>('trash_list'),
  trashSummary: () => call<TrashSummary>('trash_summary'),
  trashRestore: (batchId: string) => call<void>('trash_restore', { batchId }),
  trashPurge: (batchId: string) => call<void>('trash_purge', { batchId, confirmed: true }),
  trashEmpty: () => call<number>('trash_empty', { confirmed: true }),

  importPick: () => call<StageReport>('import_pick'),
  importStagedRead: async (stagingId: string) => bytes(await call<ArrayBuffer>('import_staged_read', { stagingId })),
  importCommit: (stagingId: string, analysis: ImportAnalysis) => call<string>('import_commit', { stagingId, analysis }),
  importDiscard: (stagingId: string) => call<void>('import_discard', { stagingId }),
  onImportStaged: async (cb: (r: StageReport) => void) => (await transport()).listen<StageReport>('campus://import-staged', cb),

  blobRead: async (hash: string) => bytes(await call<ArrayBuffer>('blob_read', { hash })),
  imagePick: () => call<ImportedImage | null>('image_pick'),

  exportPickTarget: (suggestedName: string) => call<string | null>('export_pick_target', { suggestedName }),
  exportPrepare: (documentId: string) => call<{ exportId: string; snapshot: DocumentSnapshot }>('export_prepare', { documentId }),
  exportFinish: (exportId: string, targetToken: string, data: Uint8Array) =>
    call<{ path: string; bytes: number }>('export_finish', data, { 'x-export-id': exportId, 'x-target-token': targetToken }),
  exportCancel: (exportId: string) => call<void>('export_cancel', { exportId }),

  backupStatus: () => call<BackupStatus>('backup_status'),
  backupChooseTarget: () => call<string | null>('backup_choose_target'),
  backupCreate: (kind: 'manual' | 'auto') => call<BackupResult | null>('backup_create', { kind }),
  backupVerifyPick: () => call<VerifiedBackup | null>('backup_verify_pick'),
  backupRestorePick: () => call<LibraryInfo | null>('backup_restore_pick'),
};
