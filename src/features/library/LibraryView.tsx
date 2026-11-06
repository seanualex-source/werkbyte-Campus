import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Layers,
  Library,
  MoreHorizontal,
  Pencil,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import type { DocumentSummary, FolderRec } from '../../domain/types';
import { formatDate, toast } from '../../app/ui';
import { beginPointerDrag, registerDrop } from '../../app/dnd';
import { api, errorMessage } from '../../ipc/api';
import { folderPath, refreshLibrary, setView, useLibrary } from './libraryStore';
import {
  duplicateDocument,
  importPdfs,
  mergeDocuments,
  moveDocuments,
  moveDocumentsTo,
  moveFolder,
  newFolder,
  newNoteDocument,
  renameDocument,
  renameFolder,
  trashDocuments,
  trashFolder,
} from './actions';
import { TrashView } from './TrashView';
import { openBackupPanel } from '../backup/BackupPanel';

function Menu(props: { items: { label: string; icon?: React.ReactNode; onClick: () => void; danger?: boolean }[]; label: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [open]);
  return (
    <div className="menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button className="icon-btn small" aria-label={props.label} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {props.items.map((it) => (
            <button key={it.label} role="menuitem" className={it.danger ? 'danger-text' : ''} onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}>
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FolderNode({ f, depth, folders }: { f: FolderRec; depth: number; folders: FolderRec[] }) {
  const { view, expanded } = useLibrary();
  const kids = folders.filter((c) => c.parentId === f.id);
  const open = expanded[f.id];
  const active = view.kind === 'folder' && view.folderId === f.id;
  return (
    <div role="treeitem" aria-expanded={kids.length ? !!open : undefined} aria-selected={active}>
      <div className={`tree-row ${active ? 'active' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} data-drop={`folder:${f.id}`}>
        <button
          className="twisty"
          aria-label={open ? `${f.name} zuklappen` : `${f.name} aufklappen`}
          disabled={!kids.length}
          onClick={() => useLibrary.setState((s) => ({ expanded: { ...s.expanded, [f.id]: !open } }))}
        >
          {kids.length ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
        </button>
        <button
          className="tree-label"
          onClick={() => setView({ kind: 'folder', folderId: f.id })}
          onPointerDown={(e) => beginPointerDrag(e, { type: 'folder', id: f.id }, f.name)}
        >
          <Folder size={15} />
          <span className="ellipsis">{f.name}</span>
        </button>
        <Menu
          label={`Aktionen für ${f.name}`}
          items={[
            { label: 'Neuer Unterordner', icon: <FolderPlus size={15} />, onClick: () => void newFolder(f.id) },
            { label: 'Umbenennen', icon: <Pencil size={15} />, onClick: () => void renameFolder(f) },
            { label: 'Verschieben …', icon: <FolderInput size={15} />, onClick: () => moveFolder(f) },
            { label: 'In Papierkorb', icon: <Trash2 size={15} />, onClick: () => void trashFolder(f), danger: true },
          ]}
        />
      </div>
      {open && kids.map((k) => <FolderNode key={k.id} f={k} depth={depth + 1} folders={folders} />)}
    </div>
  );
}

function Sidebar({ libraryRoot }: { libraryRoot: string }) {
  const { folders, view } = useLibrary();
  useEffect(
    () =>
      registerDrop('folder', async (payload, target) => {
        const id = target.dataset.drop!.split(':')[1];
        const dest = id === 'root' ? null : id;
        if (payload.type === 'documents') await moveDocumentsTo(payload.ids, dest);
        if (payload.type === 'folder' && payload.id !== dest) {
          try {
            await api.folderMove(payload.id, dest);
            await refreshLibrary();
          } catch (e) {
            toast(errorMessage(e), 'error');
          }
        }
      }),
    [],
  );
  return (
    <aside className="sidebar" aria-label="Navigation">
      <div className="brand">
        <img src="./app-icon.svg" alt="" width={26} height={26} />
        <div>
          <strong>werkbyte</strong> Campus
        </div>
      </div>
      <nav className="nav">
        <button className={view.kind === 'all' ? 'active' : ''} onClick={() => setView({ kind: 'all' })} data-drop="folder:root">
          <Library size={16} /> Alle Dokumente
        </button>
        <button className={view.kind === 'recent' ? 'active' : ''} onClick={() => setView({ kind: 'recent' })}>
          <Clock size={16} /> Zuletzt geöffnet
        </button>
      </nav>
      <div className="section-head">
        <span>Ordner</span>
        <button className="icon-btn small" aria-label="Neuer Ordner" title="Neuer Ordner" onClick={() => void newFolder(null)}>
          <FolderPlus size={15} />
        </button>
      </div>
      <div className="tree" role="tree" aria-label="Ordner">
        {folders.filter((f) => f.parentId === null).map((f) => <FolderNode key={f.id} f={f} depth={0} folders={folders} />)}
        {folders.length === 0 && <p className="muted small pad">Noch keine Ordner. Lege z. B. „Semester 1“ an.</p>}
      </div>
      <nav className="nav bottom">
        <button className={view.kind === 'trash' ? 'active' : ''} onClick={() => setView({ kind: 'trash' })}>
          <Trash2 size={16} /> Papierkorb
        </button>
        <button onClick={openBackupPanel}>
          <ShieldCheck size={16} /> Sicherung
        </button>
      </nav>
      <div className="lib-root" title={libraryRoot}>
        Bibliothek: {libraryRoot}
      </div>
    </aside>
  );
}

function sortDocs(docs: DocumentSummary[], sort: 'name' | 'updated' | 'pages') {
  const d = [...docs];
  if (sort === 'name') d.sort((a, b) => a.title.localeCompare(b.title, 'de', { numeric: true }));
  if (sort === 'updated') d.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  if (sort === 'pages') d.sort((a, b) => b.pageCount - a.pageCount);
  return d;
}

export function LibraryView(props: { onOpen: (id: string) => void; onExport: (d: DocumentSummary) => void; libraryRoot: string; banner?: React.ReactNode }) {
  const { folders, documents, view, query, sort, selectedDocIds, loading } = useLibrary();
  const [q, setQ] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q !== useLibrary.getState().query) {
        useLibrary.setState({ query: q });
        void refreshLibrary();
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const sorted = useMemo(() => sortDocs(documents, sort), [documents, sort]);
  const folderId = view.kind === 'folder' ? view.folderId : null;
  const subfolders = folders.filter((f) => view.kind === 'folder' && f.parentId === folderId);
  const path = folderPath(folders, folderId);
  const title = view.kind === 'all' ? 'Alle Dokumente' : view.kind === 'recent' ? 'Zuletzt geöffnet' : view.kind === 'trash' ? 'Papierkorb' : path[path.length - 1]?.name ?? 'Ordner';
  const folderName = (id: string | null) => (id ? folders.find((f) => f.id === id)?.name ?? '' : 'Bibliothek');
  const toggle = (id: string, e: React.MouseEvent | React.ChangeEvent) => {
    const multi = 'shiftKey' in e ? (e as React.MouseEvent).ctrlKey || (e as React.MouseEvent).metaKey : true;
    useLibrary.setState((s) => ({
      selectedDocIds: s.selectedDocIds.includes(id) ? s.selectedDocIds.filter((x) => x !== id) : multi ? [...s.selectedDocIds, id] : [id],
    }));
  };

  return (
    <div className="library">
      <Sidebar libraryRoot={props.libraryRoot} />
      <main className="lib-main" aria-label={title}>
        {view.kind === 'trash' ? (
          <TrashView />
        ) : (
          <>
            <header className="lib-head">
              <div className="crumbs">
                {view.kind === 'folder' ? (
                  <>
                    <button className="crumb" onClick={() => setView({ kind: 'all' })}>Bibliothek</button>
                    {path.map((f) => (
                      <span key={f.id}>
                        <ChevronRight size={14} />
                        <button className="crumb" onClick={() => setView({ kind: 'folder', folderId: f.id })}>{f.name}</button>
                      </span>
                    ))}
                  </>
                ) : null}
                <h1>{title}</h1>
              </div>
              <div className="lib-actions">
                <div className="search">
                  <Search size={15} />
                  <input placeholder="Nach Namen suchen" aria-label="Dokumente nach Namen suchen" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <select aria-label="Sortierung" value={sort} onChange={(e) => useLibrary.setState({ sort: e.target.value as never })}>
                  <option value="updated">Zuletzt geändert</option>
                  <option value="name">Name</option>
                  <option value="pages">Seitenzahl</option>
                </select>
                {view.kind === 'folder' && (
                  <button onClick={() => void newFolder(folderId)}>
                    <FolderPlus size={16} /> Unterordner
                  </button>
                )}
                <button onClick={() => newNoteDocument(props.onOpen)}>
                  <FilePlus2 size={16} /> Notizdokument
                </button>
                <button className="primary" onClick={() => void importPdfs()} title="PDF importieren (Strg+O)">
                  <Upload size={16} /> PDF importieren
                </button>
              </div>
            </header>
            {props.banner}
            {selectedDocIds.length > 0 && (
              <div className="selection-bar" role="toolbar" aria-label="Auswahl">
                <span>{selectedDocIds.length} ausgewählt</span>
                <button onClick={() => mergeDocuments(selectedDocIds, props.onOpen)} disabled={selectedDocIds.length < 2}>
                  <Layers size={15} /> Zusammenführen
                </button>
                <button onClick={() => moveDocuments(selectedDocIds)}>
                  <FolderInput size={15} /> Verschieben
                </button>
                <button onClick={() => void trashDocuments(selectedDocIds)}>
                  <Trash2 size={15} /> In Papierkorb
                </button>
                <button className="link" onClick={() => useLibrary.setState({ selectedDocIds: [] })}>Auswahl aufheben</button>
              </div>
            )}
            <div className="doc-table" role="grid" aria-label="Dokumente" aria-busy={loading}>
              <div className="doc-row head" role="row">
                <span />
                <span role="columnheader">Name</span>
                <span role="columnheader">{view.kind === 'all' || view.kind === 'recent' ? 'Ordner' : ''}</span>
                <span role="columnheader" className="num">Seiten</span>
                <span role="columnheader">{view.kind === 'recent' ? 'Geöffnet' : 'Geändert'}</span>
                <span />
              </div>
              {subfolders.map((f) => (
                <div key={f.id} className="doc-row folder-row" role="row" data-drop={`folder:${f.id}`} onDoubleClick={() => setView({ kind: 'folder', folderId: f.id })}>
                  <span />
                  <button className="doc-name" onClick={() => setView({ kind: 'folder', folderId: f.id })} onPointerDown={(e) => beginPointerDrag(e, { type: 'folder', id: f.id }, f.name)}>
                    <Folder size={18} className="folder-ic" /> {f.name}
                  </button>
                  <span />
                  <span className="num muted">{folders.filter((c) => c.parentId === f.id).length ? 'Ordner' : ''}</span>
                  <span className="muted">{formatDate(f.updatedAt)}</span>
                  <Menu label={`Aktionen für ${f.name}`} items={[
                    { label: 'Umbenennen', icon: <Pencil size={15} />, onClick: () => void renameFolder(f) },
                    { label: 'Verschieben …', icon: <FolderInput size={15} />, onClick: () => moveFolder(f) },
                    { label: 'In Papierkorb', icon: <Trash2 size={15} />, onClick: () => void trashFolder(f), danger: true },
                  ]} />
                </div>
              ))}
              {sorted.map((d) => {
                const sel = selectedDocIds.includes(d.id);
                return (
                  <div
                    key={d.id}
                    className={`doc-row ${sel ? 'selected' : ''}`}
                    role="row"
                    aria-selected={sel}
                    onDoubleClick={() => props.onOpen(d.id)}
                    onKeyDown={(e) => e.key === 'Enter' && props.onOpen(d.id)}
                  >
                    <input type="checkbox" aria-label={`${d.title} auswählen`} checked={sel} onChange={(e) => toggle(d.id, e)} />
                    <button
                      className="doc-name"
                      onClick={() => props.onOpen(d.id)}
                      onPointerDown={(e) => {
                        const ids = sel ? selectedDocIds : [d.id];
                        beginPointerDrag(e, { type: 'documents', ids }, ids.length > 1 ? `${ids.length} Dokumente` : d.title);
                      }}
                    >
                      <FileText size={18} className="doc-ic" />
                      <span className="ellipsis">{d.title}</span>
                    </button>
                    <span className="muted ellipsis">{view.kind === 'all' || view.kind === 'recent' ? folderName(d.folderId) : ''}</span>
                    <span className="num">{d.pageCount}</span>
                    <span className="muted">{formatDate(view.kind === 'recent' ? d.lastOpenedAt : d.updatedAt)}</span>
                    <Menu
                      label={`Aktionen für ${d.title}`}
                      items={[
                        { label: 'Öffnen', icon: <FileText size={15} />, onClick: () => props.onOpen(d.id) },
                        { label: 'Umbenennen', icon: <Pencil size={15} />, onClick: () => void renameDocument(d) },
                        { label: 'Verschieben …', icon: <FolderInput size={15} />, onClick: () => moveDocuments([d.id]) },
                        { label: 'Duplizieren', icon: <Copy size={15} />, onClick: () => void duplicateDocument(d) },
                        { label: 'Als PDF exportieren', icon: <Download size={15} />, onClick: () => props.onExport(d) },
                        { label: 'In Papierkorb', icon: <Trash2 size={15} />, onClick: () => void trashDocuments([d.id]), danger: true },
                      ]}
                    />
                  </div>
                );
              })}
              {!loading && sorted.length === 0 && subfolders.length === 0 && (
                <div className="empty">
                  <FileText size={40} strokeWidth={1.2} />
                  <p>{query ? 'Keine Dokumente mit diesem Namen.' : view.kind === 'recent' ? 'Noch nichts geöffnet.' : 'Hier liegen noch keine Dokumente.'}</p>
                  {!query && view.kind !== 'recent' && (
                    <div className="row-gap">
                      <button className="primary" onClick={() => void importPdfs()}><Upload size={16} /> PDF importieren</button>
                      <button onClick={() => newNoteDocument(props.onOpen)}><FilePlus2 size={16} /> Notizdokument anlegen</button>
                    </div>
                  )}
                  <p className="muted small">Tipp: PDF-Dateien lassen sich auch einfach in das Fenster ziehen.</p>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
