import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import type { DocumentSummary, LibraryInfo } from '../domain/types';
import { api, errorMessage, isTauri, type CampusErrorDto } from '../ipc/api';
import { DialogHost, Modal, openDialog, ToastHost, toast, confirmDialog } from './ui';
import { LibraryView } from '../features/library/LibraryView';
import { currentFolderId, refreshLibrary } from '../features/library/libraryStore';
import { importPdfs, runImport } from '../features/library/actions';
import { EditorView } from '../features/editor/EditorView';
import { editor } from '../features/editor/editorStore';
import { startExport } from '../features/editor/exportFlow';
import { BACKUP_PROMPT_KEY, openBackupPanel, setLibrarySwitchedHandler } from '../features/backup/BackupPanel';

type Route = { view: 'library' } | { view: 'editor'; documentId: string };

function LibraryExport({ d, close }: { d: DocumentSummary; close: () => void }) {
  const [stage, setStage] = useState('Vorbereitung …');
  const handle = useRef<{ cancel(): void } | null>(null);
  useEffect(() => {
    const h = startExport({ documentId: d.id, title: d.title, flush: () => Promise.resolve(true) }, (s) => setStage(s));
    handle.current = h;
    h.promise.then(
      (r) => {
        close();
        if (r) toast(`Exportiert (${r.pages} Seite(n), Revision ${r.revision}): ${r.path}`, 'success', 9000);
      },
      (e) => {
        close();
        if ((e as { code?: string })?.code !== 'CANCELLED') toast(`Export fehlgeschlagen: ${errorMessage(e)}`, 'error');
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Modal title={`„${d.title}“ exportieren`} onClose={() => handle.current?.cancel()} footer={<button onClick={() => handle.current?.cancel()}>Abbrechen</button>}>
      <div className="progress-box"><Loader2 size={18} className="spin" /> {stage}</div>
    </Modal>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>({ view: 'library' });
  const [lib, setLib] = useState<LibraryInfo | null>(null);
  const [libError, setLibError] = useState<CampusErrorDto | null>(null);
  const [booting, setBooting] = useState(true);
  const [needsBackupTarget, setNeedsBackupTarget] = useState(false);
  const routeRef = useRef(route);
  routeRef.current = route;

  const boot = async () => {
    setBooting(true);
    try {
      const info = await api.appInfo();
      setLib(info.library);
      setLibError(info.error);
      if (info.library) {
        await refreshLibrary();
        if (isTauri()) {
          const st = await api.backupStatus().catch(() => null);
          let dismissed = false;
          try {
            dismissed = localStorage.getItem(BACKUP_PROMPT_KEY) === '1';
          } catch {
            dismissed = false;
          }
          setNeedsBackupTarget(!!st && !st.target && !dismissed);
        }
      }
    } catch (e) {
      setLibError({ code: 'INTERNAL', message: errorMessage(e), retryable: true });
    } finally {
      setBooting(false);
    }
  };

  useEffect(() => {
    void boot();
    setLibrarySwitchedHandler(() => {
      setRoute({ view: 'library' });
      void boot();
    });
  }, []);

  // Dateien, die auf das Fenster gezogen werden (Pfade vom Betriebssystem, gestaged im Backend).
  useEffect(() => {
    let off: (() => void) | undefined;
    void api.onImportStaged((r) => void runImport(r.staged, r.failed, routeRef.current.view === 'library' ? currentFolderId() : null)).then((f) => (off = f));
    return () => off?.();
  }, []);

  // Strg+O importiert
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        if (routeRef.current.view === 'library') void importPdfs();
        else toast('PDFs werden in der Bibliothek importiert. Bitte zuerst zur Bibliothek wechseln.', 'info');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Automatische Sicherung: einmal täglich nach Änderungen, solange die App läuft (§7.3).
  useEffect(() => {
    if (!lib || !isTauri()) return;
    const tick = () =>
      api.backupCreate('auto').then(
        (r) => r && toast('Automatische Sicherung erstellt und geprüft.', 'success'),
        (e) => {
          const msg = errorMessage(e);
          if (!/Sicherungsziel wählen/.test(msg) && !/läuft bereits/.test(msg)) toast(`Automatische Sicherung fehlgeschlagen: ${msg}`, 'warning', 8000);
        },
      );
    const first = setTimeout(tick, 90_000);
    const iv = setInterval(tick, 30 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [lib]);

  // Schließen: ausstehende Änderungen speichern; bei Fehler warnen (§3.3).
  useEffect(() => {
    if (isTauri()) {
      let unlisten: (() => void) | undefined;
      void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const w = getCurrentWindow();
        unlisten = await w.onCloseRequested(async (ev) => {
          if (!editor.hasUnsaved()) return;
          ev.preventDefault();
          const ok = await editor.flush();
          if (ok || (await confirmDialog('Ungespeicherte Änderungen', 'Einige Änderungen konnten nicht gespeichert werden und gehen beim Schließen verloren. Trotzdem schließen?', 'Trotzdem schließen', true))) {
            await w.destroy();
          }
        });
      });
      return () => unlisten?.();
    }
    const onUnload = (e: BeforeUnloadEvent) => {
      if (editor.hasUnsaved()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  if (booting) {
    return (
      <div className="splash">
        <Loader2 className="spin" /> werkbyte Campus wird gestartet …
        <ToastHost />
      </div>
    );
  }

  if (!lib) {
    return (
      <div className="splash error-screen">
        <AlertTriangle size={36} />
        <h1>Die Bibliothek kann nicht geöffnet werden</h1>
        <p>{libError?.message ?? 'Unbekannter Fehler.'}</p>
        {libError?.code === 'LIBRARY_LOCKED' && <p className="muted">Campus ist vermutlich bereits geöffnet. Bitte das andere Fenster verwenden.</p>}
        {libError?.code === 'SCHEMA_TOO_NEW' && <p className="muted">Bitte die neueste Version von werkbyte Campus installieren. Die Bibliothek wird nicht verändert.</p>}
        <div className="row-gap">
          <button className="primary" onClick={() => void api.libraryRetry().then(boot, (e) => toast(errorMessage(e), 'error'))}>Erneut versuchen</button>
          <button onClick={() => void api.libraryChooseLocation().then((i) => i && boot(), (e) => toast(errorMessage(e), 'error'))}>Anderen Bibliotheksort wählen …</button>
        </div>
        <ToastHost />
      </div>
    );
  }

  const banner = needsBackupTarget ? (
    <div className="banner info">
      <ShieldCheck size={16} />
      <span>Lege ein Ziel für automatische Sicherungen fest, idealerweise auf einem zweiten Laufwerk oder USB-Stick.</span>
      <button className="primary small" onClick={() => { setNeedsBackupTarget(false); openBackupPanel(); }}>Sicherung einrichten</button>
      <button className="link" onClick={() => { try { localStorage.setItem(BACKUP_PROMPT_KEY, '1'); } catch { /* optional */ } setNeedsBackupTarget(false); }}>Später</button>
    </div>
  ) : null;

  return (
    <>
      {route.view === 'library' ? (
        <LibraryView
          libraryRoot={lib.root}
          banner={banner}
          onOpen={(id) => setRoute({ view: 'editor', documentId: id })}
          onExport={(d) => openDialog((close) => <LibraryExport d={d} close={close} />)}
        />
      ) : (
        <EditorView
          documentId={route.documentId}
          onBack={() => {
            setRoute({ view: 'library' });
            void refreshLibrary();
          }}
        />
      )}
      <DialogHost />
      <ToastHost />
    </>
  );
}
