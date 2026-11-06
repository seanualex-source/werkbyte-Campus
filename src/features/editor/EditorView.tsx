import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Download,
  Eraser,
  FileOutput,
  Hand,
  Highlighter,
  ImagePlus,
  Loader2,
  Maximize2,
  MousePointer2,
  PenLine,
  Redo2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { NoteBackground, PageBundle } from '../../domain/types';
import { cmdAddPage, cmdDeleteAnnotations, cmdRename } from '../../domain/ops';
import { displaySize, totalRotation } from '../../rendering/geometry';
import { api, errorMessage } from '../../ipc/api';
import { Modal, openDialog, toast } from '../../app/ui';
import { BACKGROUNDS, PaperChooser } from '../library/actions';
import { editor, newId, useEditor, type Tool } from './editorStore';
import { PageView } from './PageView';
import { Thumbnails } from './Thumbnails';
import { HIGHLIGHT_COLORS, PEN_COLORS, PropertiesPanel, Swatches } from './PropertiesPanel';
import { resetSources, useFont } from './render';
import { startExport } from './exportFlow';
import { A4 } from '../../domain/types';

const TOOLS: { id: Tool; label: string; icon: React.ReactNode; key: string }[] = [
  { id: 'select', label: 'Auswahl', icon: <MousePointer2 size={17} />, key: 'V' },
  { id: 'hand', label: 'Hand', icon: <Hand size={17} />, key: 'H' },
  { id: 'text', label: 'Text', icon: <Type size={17} />, key: 'T' },
  { id: 'image', label: 'Bild', icon: <ImagePlus size={17} />, key: 'B' },
  { id: 'pen', label: 'Stift', icon: <PenLine size={17} />, key: 'P' },
  { id: 'highlight', label: 'Textmarker', icon: <Highlighter size={17} />, key: 'M' },
  { id: 'eraser', label: 'Radierer', icon: <Eraser size={17} />, key: 'E' },
];

const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 2.5, 3, 4];
const GAP = 16;

function SaveIndicator() {
  const status = useEditor((s) => s.saveStatus);
  const err = useEditor((s) => s.saveError);
  if (status === 'saved') return <span className="save ok" role="status"><CheckCircle2 size={14} /> Gespeichert</span>;
  if (status === 'saving' || status === 'pending') return <span className="save busy" role="status"><Loader2 size={14} className="spin" /> Speichert …</span>;
  return (
    <span className="save err" role="alert" title={err?.message}>
      <CircleAlert size={14} /> Speichern fehlgeschlagen{err?.code === 'DISK_FULL' ? ' (Datenträger voll)' : ''}, neuer Versuch läuft
    </span>
  );
}

function InsertNoteDialog({ close }: { close: () => void }) {
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [bg, setBg] = useState<NoteBackground['type']>('grid');
  const insert = () => {
    const s = useEditor.getState();
    const d = s.doc!;
    const land = orientation === 'landscape';
    const bundle: PageBundle = { id: newId(), kind: 'note', sourceId: null, sourcePageIndex: null, widthPt: land ? A4.h : A4.w, heightPt: land ? A4.w : A4.h, rotation: 0, background: BACKGROUNDS[bg], annotations: [], widgets: [] };
    const pos = Math.min(d.pages.length, s.currentPageIndex + 1);
    editor.dispatch(cmdAddPage(bundle, pos, 'Notizseite einfügen'));
    useEditor.setState({ currentPageIndex: pos });
    close();
    setTimeout(() => document.querySelector(`[data-page-index="${pos}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  };
  return (
    <Modal title="Notizseite einfügen" onClose={close} footer={<><button onClick={close}>Abbrechen</button><button className="primary" onClick={insert}>Nach aktueller Seite einfügen</button></>}>
      <PaperChooser orientation={orientation} setOrientation={setOrientation} bg={bg} setBg={setBg} />
    </Modal>
  );
}

function ExportDialog({ close, title, documentId, selection }: { close: () => void; title: string; documentId: string; selection: string[] }) {
  const doc = useEditor((s) => s.doc)!;
  const [mode, setMode] = useState<'all' | 'selection'>(selection.length ? 'selection' : 'all');
  const [stage, setStage] = useState<string | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const handle = useRef<{ cancel(): void } | null>(null);
  const hasForms = doc.widgets.length > 0;
  const start = () => {
    const h = startExport({ documentId, title, pageIds: mode === 'selection' ? selection : undefined, flush: editor.flush }, (s, d, t) => {
      setStage(s);
      setProgress(d !== undefined && t ? [d, t] : null);
    });
    handle.current = h;
    h.promise.then(
      (res) => {
        close();
        if (res) toast(`Exportiert (${res.pages} Seite(n), Revision ${res.revision}): ${res.path}`, 'success', 9000);
      },
      (e) => {
        setStage(null);
        if ((e as { code?: string })?.code === 'CANCELLED') toast('Export abgebrochen. Vorhandene Dateien blieben unverändert.', 'info');
        else toast(`Export fehlgeschlagen: ${errorMessage(e)}`, 'error');
      },
    );
  };
  return (
    <Modal
      title="Als PDF exportieren"
      onClose={() => (stage ? handle.current?.cancel() : close())}
      footer={
        stage ? (
          <button onClick={() => handle.current?.cancel()}>Abbrechen</button>
        ) : (
          <>
            <button onClick={close}>Abbrechen</button>
            <button className="primary" onClick={start}><Download size={15} /> Ziel wählen und exportieren</button>
          </>
        )
      }
    >
      {stage ? (
        <div className="progress-box" role="status">
          <Loader2 size={18} className="spin" /> {stage}
          {progress && (
            <>
              <progress max={progress[1]} value={progress[0]} />
              <span className="muted small">{progress[0]} / {progress[1]} Seiten</span>
            </>
          )}
        </div>
      ) : (
        <>
          <fieldset className="choice-col">
            <legend>Umfang</legend>
            <label><input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} /> Gesamtes Dokument ({doc.pages.length} Seiten)</label>
            <label className={selection.length ? '' : 'disabled'}>
              <input type="radio" disabled={!selection.length} checked={mode === 'selection'} onChange={() => setMode('selection')} /> Ausgewählte Seiten ({selection.length}) {selection.length ? '' : ' · in der Seitenleiste mit Strg+Klick wählen'}
            </label>
          </fieldset>
          <p className="muted small">Eigene Texte, Bilder und Striche werden in das PDF eingebettet. Das Ergebnis ist eine neue Datei für die Weitergabe; zum Weiterbearbeiten bleibt das Dokument in Campus.</p>
          {hasForms && <p className="banner warn small">Formularfelder werden mit ihren Werten sichtbar übernommen und sind im exportierten PDF nicht mehr ausfüllbar.</p>}
        </>
      )}
    </Modal>
  );
}

export function EditorView({ documentId, onBack }: { documentId: string; onBack: () => void }) {
  const s = useEditor();
  const fontError = useFont((f) => f.error);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState<[number, number]>([0, 2]);
  const [width, setWidth] = useState(800);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  useEffect(() => {
    resetSources();
    void editor.open(documentId);
    return () => {
      resetSources();
    };
  }, [documentId]);

  useEffect(() => {
    if (s.notice) {
      toast(s.notice, 'warning', 9000);
      useEditor.setState({ notice: null });
    }
  }, [s.notice]);

  // Containerbreite für „Seitenbreite“
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [s.doc !== null]);

  const doc = s.doc;
  const maxDispW = doc
    ? Math.max(...doc.pages.map((p) => {
        const sp = p.sourceId ? doc.snapshot.sourcePages.find((x) => x.sourceId === p.sourceId && x.pageIndex === p.sourcePageIndex) : null;
        return displaySize(p.widthPt, p.heightPt, totalRotation(p, sp))[0];
      }), 1)
    : 595;
  const zoom = s.fitWidth ? Math.max(0.25, Math.min(4, (width - 48) / maxDispW)) : s.zoom;

  const layout = doc
    ? (() => {
        let y = GAP;
        return doc.pages.map((p) => {
          const sp = p.sourceId ? doc.snapshot.sourcePages.find((x) => x.sourceId === p.sourceId && x.pageIndex === p.sourcePageIndex) : null;
          const [, dh] = displaySize(p.widthPt, p.heightPt, totalRotation(p, sp));
          const top = y;
          y += dh * zoom + GAP;
          return { top, height: dh * zoom };
        });
      })()
    : [];

  const updateVisible = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !layout.length) return;
    const top = el.scrollTop - 800, bottom = el.scrollTop + el.clientHeight + 800;
    let first = layout.findIndex((l) => l.top + l.height >= top);
    if (first < 0) first = 0;
    let last = first;
    while (last + 1 < layout.length && layout[last + 1].top <= bottom) last++;
    setVisibleRange((r) => (r[0] === first && r[1] === last ? r : [first, last]));
    const mid = el.scrollTop + el.clientHeight / 3;
    const cur = layout.findIndex((l) => l.top + l.height + GAP > mid);
    if (cur >= 0 && cur !== useEditor.getState().currentPageIndex) useEditor.setState({ currentPageIndex: cur });
  }, [layout]);

  useEffect(() => {
    updateVisible();
  }, [zoom, doc?.pages.length, width]);

  // Zoom um die aktuelle Seite herum stabil halten
  const setZoom = (z: number) => {
    const el = scrollRef.current;
    const ratio = el ? el.scrollTop / Math.max(1, el.scrollHeight) : 0;
    useEditor.setState({ zoom: Math.max(0.25, Math.min(4, z)), fitWidth: false });
    requestAnimationFrame(() => {
      if (el) el.scrollTop = ratio * el.scrollHeight;
    });
  };
  const zoomStep = (dir: 1 | -1) => {
    const cur = zoom;
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.01) ?? 4 : [...ZOOMS].reverse().find((z) => z < cur - 0.01) ?? 0.5;
    setZoom(next);
  };

  const goTo = (i: number) => {
    if (!doc) return;
    const idx = Math.max(0, Math.min(doc.pages.length - 1, i));
    useEditor.setState({ currentPageIndex: idx });
    const el = scrollRef.current;
    if (el && layout[idx]) el.scrollTo({ top: layout[idx].top - GAP, behavior: 'smooth' });
  };

  const openExport = useCallback(() => {
    const st = useEditor.getState();
    if (!st.doc) return;
    openDialog((close) => <ExportDialog close={close} title={st.doc!.title} documentId={documentId} selection={st.selectedPageIds} />);
  }, [documentId]);

  const extractSelection = async () => {
    const st = useEditor.getState();
    if (!st.doc || !st.selectedPageIds.length) return;
    if (!(await editor.flush())) return toast('Bitte zuerst das Speichern abwarten.', 'warning');
    try {
      await api.documentCompose(`${st.doc.title} (Auszug)`, st.doc.snapshot.document.folderId, [{ documentId, pageIds: st.selectedPageIds }]);
      toast(`${st.selectedPageIds.length} Seite(n) als neues Dokument angelegt. Die Quelle bleibt unverändert.`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  // Tastatur
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.closest('input, textarea, select, [contenteditable="true"]');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void editor.flush().then((ok) => !ok && toast('Speichern fehlgeschlagen. Neuer Versuch läuft.', 'error'));
        return;
      }
      if (typing) return;
      if (document.querySelector('.modal-backdrop')) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); return; }
      if ((mod && e.key.toLowerCase() === 'z' && e.shiftKey) || (mod && e.key.toLowerCase() === 'y')) { e.preventDefault(); editor.redo(); return; }
      if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomStep(1); return; }
      if (mod && e.key === '-') { e.preventDefault(); zoomStep(-1); return; }
      if (mod && e.key === '0') { e.preventDefault(); useEditor.setState({ fitWidth: true }); return; }
      if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); openExport(); return; }
      if (e.key === 'PageDown') { e.preventDefault(); goTo(useEditor.getState().currentPageIndex + 1); return; }
      if (e.key === 'PageUp') { e.preventDefault(); goTo(useEditor.getState().currentPageIndex - 1); return; }
      if (e.key === 'Escape') { useEditor.setState({ selectedAnnotationId: null, editingTextId: null, selectedPageIds: [] }); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = useEditor.getState().selectedAnnotationId;
        if (id) {
          e.preventDefault();
          editor.dispatch(cmdDeleteAnnotations(useEditor.getState().doc!, [id]));
          useEditor.setState({ selectedAnnotationId: null });
        }
        return;
      }
      if (!mod && !e.altKey) {
        const tool = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
        if (tool) useEditor.setState({ tool: tool.id, selectedAnnotationId: tool.id === 'select' ? useEditor.getState().selectedAnnotationId : null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Strg + Mausrad zoomt
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomStep(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const back = async () => {
    const ok = await editor.close();
    if (!ok) toast('Einige Änderungen konnten nicht gespeichert werden.', 'error');
    onBack();
  };

  if (s.loadError) {
    return (
      <div className="editor-error">
        <CircleAlert size={32} />
        <p>Das Dokument konnte nicht geöffnet werden: {s.loadError}</p>
        <button onClick={onBack}>Zur Bibliothek</button>
      </div>
    );
  }
  if (!doc) return <div className="editor-loading"><Loader2 className="spin" /> Dokument wird geöffnet …</div>;

  const totalHeight = layout.length ? layout[layout.length - 1].top + layout[layout.length - 1].height + GAP : 0;
  const showPen = s.tool === 'pen';
  const showHl = s.tool === 'highlight';
  return (
    <div className="editor">
      <header className="ed-top">
        <button className="icon-btn" onClick={() => void back()} aria-label="Zurück zur Bibliothek" title="Zurück zur Bibliothek"><ArrowLeft size={18} /></button>
        <input
          className="title-input"
          aria-label="Dokumenttitel"
          value={titleDraft ?? doc.title}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => {
            const t = (titleDraft ?? '').trim();
            if (titleDraft !== null && t && t !== doc.title) editor.dispatch(cmdRename(doc, t));
            setTitleDraft(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <div className="tools" role="toolbar" aria-label="Werkzeuge">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool ${s.tool === t.id ? 'on' : ''}`}
              aria-pressed={s.tool === t.id}
              title={`${t.label} (${t.key})`}
              onClick={() => useEditor.setState({ tool: t.id, editingTextId: null })}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        {showPen && (
          <div className="tool-opts" aria-label="Stiftoptionen">
            <Swatches colors={PEN_COLORS} value={s.options.penColor} label="Stiftfarbe" onChange={(c) => useEditor.setState({ options: { ...s.options, penColor: c } })} />
            <div className="seg" role="radiogroup" aria-label="Stiftbreite">
              {[1.2, 2.2, 4].map((w) => (
                <button key={w} role="radio" aria-checked={s.options.penWidth === w} className={s.options.penWidth === w ? 'on' : ''} title={`${w} pt`} onClick={() => useEditor.setState({ options: { ...s.options, penWidth: w } })}>
                  <span className="dot" style={{ width: w * 2 + 2, height: w * 2 + 2 }} />
                </button>
              ))}
            </div>
          </div>
        )}
        {showHl && (
          <div className="tool-opts" aria-label="Textmarkeroptionen">
            <Swatches colors={HIGHLIGHT_COLORS} value={s.options.highlightColor} label="Textmarkerfarbe" onChange={(c) => useEditor.setState({ options: { ...s.options, highlightColor: c } })} />
          </div>
        )}
        <div className="grow" />
        <button className="icon-btn" onClick={() => editor.undo()} disabled={!s.canUndo} aria-label="Rückgängig" title="Rückgängig (Strg+Z)"><Undo2 size={18} /></button>
        <button className="icon-btn" onClick={() => editor.redo()} disabled={!s.canRedo} aria-label="Wiederholen" title="Wiederholen (Strg+Umschalt+Z)"><Redo2 size={18} /></button>
        {s.selectedPageIds.length > 0 && (
          <button onClick={() => void extractSelection()} title="Ausgewählte Seiten als neues Dokument"><FileOutput size={16} /> Auszug</button>
        )}
        <button className="primary" onClick={openExport} title="Als PDF exportieren (Strg+E)"><Download size={16} /> Exportieren</button>
      </header>
      {fontError && <div className="banner err">Die gebündelte Schrift konnte nicht geladen werden: {fontError}</div>}
      <div className="ed-body">
        <Thumbnails onInsertNote={() => openDialog((close) => <InsertNoteDialog close={close} />)} />
        <div className="pages-scroll" ref={scrollRef} onScroll={updateVisible} tabIndex={-1}>
          <div className="pages" style={{ height: totalHeight }}>
            {doc.pages.map((p, i) => {
              const l = layout[i];
              const near = i >= visibleRange[0] - 1 && i <= visibleRange[1] + 1;
              return (
                <div key={p.id} className="page-slot" style={{ top: l.top, height: l.height }}>
                  {near ? <PageView page={p} index={i} zoom={zoom} visible={i >= visibleRange[0] && i <= visibleRange[1]} scrollEl={scrollRef} /> : null}
                </div>
              );
            })}
          </div>
        </div>
        <PropertiesPanel />
      </div>
      <footer className="ed-status">
        <span>
          Seite{' '}
          <input
            className="page-input"
            aria-label="Seite"
            type="number"
            min={1}
            max={doc.pages.length}
            value={s.currentPageIndex + 1}
            onChange={(e) => goTo(Number(e.target.value) - 1)}
          />{' '}
          von {doc.pages.length}
        </span>
        <span className="zoom">
          <button className="icon-btn small" onClick={() => zoomStep(-1)} aria-label="Verkleinern" title="Verkleinern (Strg+Minus)"><ZoomOut size={15} /></button>
          <span className="zoom-val">{Math.round(zoom * 100)} %</span>
          <button className="icon-btn small" onClick={() => zoomStep(1)} aria-label="Vergrößern" title="Vergrößern (Strg+Plus)"><ZoomIn size={15} /></button>
          <button className={`icon-btn small ${s.fitWidth ? 'on' : ''}`} onClick={() => useEditor.setState({ fitWidth: true })} aria-label="Seitenbreite" title="Seitenbreite (Strg+0)"><Maximize2 size={15} /></button>
        </span>
        <span className="grow" />
        <SaveIndicator />
      </footer>
    </div>
  );
}
