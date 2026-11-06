// Bibliotheksaktionen mit Dialogen. Fehler werden sichtbar gemeldet, nie verschluckt.

import { useState } from 'react';
import type { DocumentSummary, FolderRec, NoteBackground, StagedInfo } from '../../domain/types';
import { api, errorMessage } from '../../ipc/api';
import { confirmDialog, Modal, openDialog, promptText, toast } from '../../app/ui';
import { FolderPicker } from './FolderPicker';
import { currentFolderId, refreshLibrary, useLibrary } from './libraryStore';
import { importStaged } from './importFlow';
import { ArrowDown, ArrowUp, FileText } from 'lucide-react';

export const BACKGROUNDS: Record<NoteBackground['type'], NoteBackground> = {
  blank: { type: 'blank', spacingPt: 22, color: '#B9C3CE', lineWidthPt: 0.5 },
  ruled: { type: 'ruled', spacingPt: 22, color: '#B9C3CE', lineWidthPt: 0.5 },
  grid: { type: 'grid', spacingPt: 14.17, color: '#C7D0DB', lineWidthPt: 0.4 },
};

export const BACKGROUND_LABEL: Record<NoteBackground['type'], string> = { blank: 'Weiß', ruled: 'Liniert', grid: 'Kariert' };

let importBusy = false;

export async function runImport(staged: StagedInfo[], failed: { name: string; error: { message: string } }[], folderId: string | null) {
  for (const f of failed) toast(`${f.name}: ${f.error.message}`, 'error');
  if (!staged.length) return [];
  importBusy = true;
  const progressToast = staged.length > 1 ? `Importiere ${staged.length} Dateien …` : `Importiere ${staged[0].name} …`;
  toast(progressToast, 'info', 2500);
  try {
    const out = await importStaged(staged, folderId);
    for (const f of out.failed) toast(`${f.name} wurde nicht importiert: ${f.message}`, 'error');
    for (const i of out.imported) for (const w of i.warnings) toast(`${i.name}: ${w}`, 'warning', 7000);
    if (out.imported.length) toast(out.imported.length === 1 ? `„${out.imported[0].name}“ importiert.` : `${out.imported.length} Dateien importiert.`, 'success');
    await refreshLibrary();
    return out.imported.map((i) => i.documentId);
  } finally {
    importBusy = false;
  }
}

export async function importPdfs() {
  if (importBusy) return toast('Es läuft bereits ein Import.', 'warning');
  try {
    const report = await api.importPick();
    await runImport(report.staged, report.failed, currentFolderId());
  } catch (e) {
    toast(`Import fehlgeschlagen: ${errorMessage(e)}`, 'error');
  }
}

function NewNoteDialog(props: { close: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('Neue Mitschrift');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [bg, setBg] = useState<NoteBackground['type']>('ruled');
  const create = async () => {
    try {
      const id = await api.documentCreateNote(currentFolderId(), title.trim() || 'Neue Mitschrift', orientation, BACKGROUNDS[bg]);
      props.close();
      await refreshLibrary();
      props.onCreated(id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Modal title="Neues Notizdokument" onClose={props.close} footer={<><button onClick={props.close}>Abbrechen</button><button className="primary" onClick={create}>Anlegen</button></>}>
      <label className="field">
        <span>Titel</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.target.select()} onKeyDown={(e) => e.key === 'Enter' && create()} maxLength={300} />
      </label>
      <PaperChooser orientation={orientation} setOrientation={setOrientation} bg={bg} setBg={setBg} />
    </Modal>
  );
}

export function PaperChooser(p: { orientation: 'portrait' | 'landscape'; setOrientation: (o: 'portrait' | 'landscape') => void; bg: NoteBackground['type']; setBg: (b: NoteBackground['type']) => void }) {
  return (
    <>
      <fieldset className="choice-row">
        <legend>Format (A4)</legend>
        {(['portrait', 'landscape'] as const).map((o) => (
          <label key={o} className={`choice ${p.orientation === o ? 'on' : ''}`}>
            <input type="radio" name="orientation" checked={p.orientation === o} onChange={() => p.setOrientation(o)} />
            <span className={`paper-icon ${o}`} aria-hidden />
            {o === 'portrait' ? 'Hochformat' : 'Querformat'}
          </label>
        ))}
      </fieldset>
      <fieldset className="choice-row">
        <legend>Papier</legend>
        {(['blank', 'ruled', 'grid'] as const).map((b) => (
          <label key={b} className={`choice ${p.bg === b ? 'on' : ''}`}>
            <input type="radio" name="bg" checked={p.bg === b} onChange={() => p.setBg(b)} />
            <span className={`paper-icon bg-${b}`} aria-hidden />
            {BACKGROUND_LABEL[b]}
          </label>
        ))}
      </fieldset>
    </>
  );
}

export function newNoteDocument(onCreated: (id: string) => void) {
  openDialog((close) => <NewNoteDialog close={close} onCreated={onCreated} />);
}

export async function newFolder(parentId: string | null) {
  const name = await promptText(parentId ? 'Neuer Unterordner' : 'Neuer Ordner', 'Name', '', 'Anlegen');
  if (!name) return;
  try {
    const f = await api.folderCreate(parentId, name);
    if (parentId) useLibrary.setState((s) => ({ expanded: { ...s.expanded, [parentId]: true } }));
    await refreshLibrary();
    return f;
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function renameFolder(f: FolderRec) {
  const name = await promptText('Ordner umbenennen', 'Name', f.name, 'Umbenennen');
  if (!name || name === f.name) return;
  try {
    await api.folderRename(f.id, name);
    await refreshLibrary();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export function moveFolder(f: FolderRec) {
  const folders = useLibrary.getState().folders;
  openDialog((close) => (
    <FolderPicker
      title={`„${f.name}“ verschieben nach …`}
      folders={folders}
      initial={f.parentId}
      exclude={f.id}
      confirm="Verschieben"
      onDone={async (target) => {
        close();
        if (target === undefined || target === f.parentId) return;
        try {
          await api.folderMove(f.id, target);
          await refreshLibrary();
        } catch (e) {
          toast(errorMessage(e), 'error');
        }
      }}
    />
  ));
}

export async function trashFolder(f: FolderRec) {
  const ok = await confirmDialog('Ordner in den Papierkorb', <>„{f.name}“ wird mit allen Unterordnern und Dokumenten in den Papierkorb verschoben. Sie können ihn dort wiederherstellen.</>, 'In Papierkorb');
  if (!ok) return;
  try {
    await api.folderTrash(f.id);
    toast(`„${f.name}“ liegt im Papierkorb.`, 'success');
    await refreshLibrary();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function renameDocument(d: DocumentSummary) {
  const title = await promptText('Dokument umbenennen', 'Titel', d.title, 'Umbenennen');
  if (!title || title === d.title) return;
  try {
    await api.documentRename(d.id, title);
    await refreshLibrary();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export function moveDocuments(ids: string[]) {
  const { folders, documents } = useLibrary.getState();
  const first = documents.find((d) => d.id === ids[0]);
  openDialog((close) => (
    <FolderPicker
      title={ids.length === 1 ? `„${first?.title}“ verschieben nach …` : `${ids.length} Dokumente verschieben nach …`}
      folders={folders}
      initial={first?.folderId ?? null}
      confirm="Verschieben"
      onDone={async (target) => {
        close();
        if (target === undefined) return;
        await moveDocumentsTo(ids, target);
      }}
    />
  ));
}

export async function moveDocumentsTo(ids: string[], target: string | null) {
  try {
    for (const id of ids) await api.documentMove(id, target);
    await refreshLibrary();
    toast(ids.length === 1 ? 'Dokument verschoben.' : `${ids.length} Dokumente verschoben.`, 'success');
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function duplicateDocument(d: DocumentSummary) {
  try {
    await api.documentCompose(`${d.title} (Kopie)`, d.folderId, [{ documentId: d.id, pageIds: null }]);
    toast(`„${d.title}“ dupliziert.`, 'success');
    await refreshLibrary();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function trashDocuments(ids: string[]) {
  const docs = useLibrary.getState().documents.filter((d) => ids.includes(d.id));
  const ok = await confirmDialog(
    'In den Papierkorb',
    docs.length === 1 ? <>„{docs[0].title}“ wird in den Papierkorb verschoben.</> : <>{docs.length} Dokumente werden in den Papierkorb verschoben.</>,
    'In Papierkorb',
  );
  if (!ok) return;
  try {
    for (const d of docs) await api.documentTrash(d.id);
    toast(docs.length === 1 ? 'Dokument liegt im Papierkorb.' : `${docs.length} Dokumente liegen im Papierkorb.`, 'success');
    await refreshLibrary();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

function MergeDialog(props: { docs: DocumentSummary[]; close: () => void; onDone: (id: string) => void }) {
  const [order, setOrder] = useState(props.docs);
  const [title, setTitle] = useState(`${props.docs[0]?.title ?? 'Dokument'} (zusammengeführt)`);
  const move = (i: number, d: number) => {
    const n = [...order];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    setOrder(n);
  };
  const total = order.reduce((s, d) => s + d.pageCount, 0);
  const run = async () => {
    try {
      const id = await api.documentCompose(title.trim() || 'Zusammengeführt', currentFolderId() ?? order[0].folderId, order.map((d) => ({ documentId: d.id, pageIds: null })));
      props.close();
      toast('Neues Dokument erstellt. Die Quellen bleiben unverändert.', 'success');
      await refreshLibrary();
      props.onDone(id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Modal title="Dokumente zusammenführen" width={520} onClose={props.close} footer={<><button onClick={props.close}>Abbrechen</button><button className="primary" onClick={run}>Neues Dokument erstellen</button></>}>
      <p className="muted">Reihenfolge festlegen. Es entsteht ein neues Dokument mit {total} Seiten; die Quellen bleiben erhalten.</p>
      <ol className="merge-list">
        {order.map((d, i) => (
          <li key={d.id}>
            <FileText size={16} />
            <span className="grow">{d.title}</span>
            <span className="muted">{d.pageCount} S.</span>
            <button className="icon-btn small" aria-label="Nach oben" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
            <button className="icon-btn small" aria-label="Nach unten" disabled={i === order.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
          </li>
        ))}
      </ol>
      <label className="field">
        <span>Titel des neuen Dokuments</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
      </label>
    </Modal>
  );
}

export function mergeDocuments(ids: string[], onDone: (id: string) => void) {
  const all = useLibrary.getState().documents;
  const docs = ids.map((id) => all.find((d) => d.id === id)!).filter(Boolean);
  if (docs.length < 2) return toast('Bitte mindestens zwei Dokumente auswählen.', 'warning');
  openDialog((close) => <MergeDialog docs={docs} close={close} onDone={onDone} />);
}
