import { useEffect, useState } from 'react';
import { FileText, Folder, RotateCcw, Trash2 } from 'lucide-react';
import type { TrashItem } from '../../domain/types';
import { api, errorMessage } from '../../ipc/api';
import { confirmDialog, formatBytes, formatDate, toast } from '../../app/ui';
import { refreshLibrary } from './libraryStore';

export function TrashView() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try {
      setItems(await api.trashList());
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const restore = async (it: TrashItem) => {
    try {
      await api.trashRestore(it.batchId);
      toast(`„${it.name}“ wiederhergestellt.`, 'success');
      await Promise.all([load(), refreshLibrary()]);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const purge = async (it: TrashItem) => {
    const ok = await confirmDialog('Endgültig löschen', <>„{it.name}“ {it.kind === 'folder' ? `mit ${it.documentCount} Dokument(en) und ${it.folderCount} Ordner(n)` : ''} wird endgültig gelöscht. Das lässt sich nicht rückgängig machen (außer über ein Backup).</>, 'Endgültig löschen', true);
    if (!ok) return;
    try {
      await api.trashPurge(it.batchId);
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const empty = async () => {
    try {
      const s = await api.trashSummary();
      const ok = await confirmDialog(
        'Papierkorb leeren',
        <>
          {s.documentCount} Dokument(e) und {s.folderCount} Ordner werden endgültig gelöscht. Dadurch werden voraussichtlich bis zu {formatBytes(s.freedBytesEstimate)} frei (nach einer Sicherheitsfrist von 7 Tagen). Fortfahren?
        </>,
        'Endgültig löschen',
        true,
      );
      if (!ok) return;
      await api.trashEmpty();
      toast('Papierkorb geleert.', 'success');
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <>
      <header className="lib-head">
        <div className="crumbs">
          <h1>Papierkorb</h1>
        </div>
        <div className="lib-actions">
          <button className="danger" disabled={!items.length} onClick={() => void empty()}>
            <Trash2 size={16} /> Papierkorb leeren
          </button>
        </div>
      </header>
      <p className="muted pad-x">Gelöschte Ordner und Dokumente bleiben hier, bis du sie endgültig entfernst. Es wird nichts automatisch gelöscht.</p>
      <div className="doc-table" role="grid" aria-busy={loading}>
        {items.map((it) => (
          <div key={it.batchId} className="doc-row trash-row" role="row">
            <span>{it.kind === 'folder' ? <Folder size={18} className="folder-ic" /> : <FileText size={18} className="doc-ic" />}</span>
            <span className="ellipsis">
              <strong>{it.name}</strong>
              {it.kind === 'folder' && <span className="muted"> · {it.documentCount} Dokument(e), {it.folderCount} Ordner</span>}
            </span>
            <span className="muted">gelöscht {formatDate(it.deletedAt)}</span>
            <button onClick={() => void restore(it)}>
              <RotateCcw size={15} /> Wiederherstellen
            </button>
            <button className="danger-text" onClick={() => void purge(it)}>
              Endgültig löschen
            </button>
          </div>
        ))}
        {!loading && items.length === 0 && (
          <div className="empty">
            <Trash2 size={40} strokeWidth={1.2} />
            <p>Der Papierkorb ist leer.</p>
          </div>
        )}
      </div>
    </>
  );
}
