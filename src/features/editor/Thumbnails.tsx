// Virtuelle Thumbnail-Liste mit Seitenaktionen. Umsortieren per Zeiger-Drag oder per Menü/Tastatur.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, FilePlus2, RotateCw, Trash2 } from 'lucide-react';
import type { PageRec } from '../../domain/types';
import { annotationsOfPage, cmdDeletePage, cmdDuplicatePage, cmdMovePage, cmdRotatePage } from '../../domain/ops';
import { displaySize, normRotation, totalRotation } from '../../rendering/geometry';
import { beginPointerDrag, registerDrop } from '../../app/dnd';
import { toast } from '../../app/ui';
import { drawComposite, renderPdfBitmap, useFont, useImages } from './render';
import { editor, newId, useEditor } from './editorStore';

const THUMB_W = 132;

const Thumb = memo(function Thumb({ page, index, selected, current }: { page: PageRec; index: number; selected: boolean; current: boolean }) {
  const doc = useEditor((s) => s.doc)!;
  const metrics = useFont((s) => s.metrics);
  const imgVersion = useImages((s) => s.version);
  const ref = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const sp = page.sourceId ? doc.snapshot.sourcePages.find((s) => s.sourceId === page.sourceId && s.pageIndex === page.sourcePageIndex) ?? null : null;
  const source = page.sourceId ? doc.snapshot.sources.find((s) => s.id === page.sourceId) : null;
  const rot = totalRotation(page, sp);
  const [dw, dh] = displaySize(page.widthPt, page.heightPt, rot);
  const h = (THUMB_W * dh) / dw;
  const anns = useMemo(() => annotationsOfPage(doc, page.id), [doc, page.id]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => setVisible(e[0].isIntersecting), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !ref.current) return;
    let stale = false;
    const dpr = window.devicePixelRatio || 1;
    const t = setTimeout(async () => {
      let bmp: HTMLCanvasElement | null = null;
      if (page.kind === 'pdf' && source) {
        try {
          bmp = await renderPdfBitmap(source.blobHash, page.sourcePageIndex!, rot, THUMB_W * dpr, () => stale);
        } catch {
          bmp = null;
        }
      }
      if (stale || !ref.current) return;
      drawComposite(ref.current, { page, sp, annotations: anns, metrics, pdfBitmap: bmp, pxPerPt: (THUMB_W * dpr) / dw });
    }, 150);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [visible, page, sp, source, rot, anns, metrics, imgVersion, dw]);

  const onClick = (e: React.MouseEvent) => {
    const st = useEditor.getState();
    let sel = st.selectedPageIds;
    if (e.ctrlKey || e.metaKey) sel = sel.includes(page.id) ? sel.filter((x) => x !== page.id) : [...sel, page.id];
    else if (e.shiftKey && st.doc) {
      const a = st.currentPageIndex, b = index;
      sel = st.doc.pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id);
    } else sel = [];
    useEditor.setState({ selectedPageIds: sel, currentPageIndex: index });
    document.querySelector(`[data-page-index="${index}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <div
      ref={holder}
      className={`thumb ${selected ? 'selected' : ''} ${current ? 'current' : ''}`}
      data-drop={`page:${page.id}`}
      role="option"
      aria-selected={selected || current}
      aria-label={`Seite ${index + 1}${page.kind === 'note' ? ' (Notizseite)' : ''}`}
      tabIndex={0}
      onClick={onClick}
      onPointerDown={(e) => beginPointerDrag(e, { type: 'page', id: page.id }, `Seite ${index + 1}`)}
      onKeyDown={(e) => {
        const d = useEditor.getState().doc!;
        if (e.altKey && e.key === 'ArrowUp' && index > 0) editor.dispatch(cmdMovePage(d, page.id, index - 1));
        if (e.altKey && e.key === 'ArrowDown' && index < d.pages.length - 1) editor.dispatch(cmdMovePage(d, page.id, index + 1));
      }}
    >
      <div className="thumb-canvas" style={{ width: THUMB_W, height: h }}>
        <canvas ref={ref} style={{ width: THUMB_W, height: h }} />
      </div>
      <div className="thumb-foot">
        <span>{index + 1}</span>
        {page.kind === 'note' && <span className="tag">Notiz</span>}
        {page.rotation !== 0 && <span className="tag">{page.rotation}°</span>}
      </div>
    </div>
  );
});

export function pageActions(pageId: string) {
  const d = useEditor.getState().doc!;
  const idx = d.pages.findIndex((p) => p.id === pageId);
  const page = d.pages[idx];
  return {
    up: () => idx > 0 && editor.dispatch(cmdMovePage(d, pageId, idx - 1)),
    down: () => idx < d.pages.length - 1 && editor.dispatch(cmdMovePage(d, pageId, idx + 1)),
    rotate: (delta: number) => editor.dispatch(cmdRotatePage(d, pageId, normRotation(page.rotation + delta))),
    duplicate: () => editor.dispatch(cmdDuplicatePage(d, pageId, newId)),
    remove: () => {
      if (d.pages.length <= 1) return toast('Die letzte Seite eines Dokuments kann nicht gelöscht werden.', 'warning');
      editor.dispatch(cmdDeletePage(d, pageId));
      useEditor.setState((s) => ({ selectedPageIds: s.selectedPageIds.filter((x) => x !== pageId), currentPageIndex: Math.min(s.currentPageIndex, d.pages.length - 2) }));
    },
  };
}

export function Thumbnails({ onInsertNote }: { onInsertNote: () => void }) {
  const doc = useEditor((s) => s.doc)!;
  const selected = useEditor((s) => s.selectedPageIds);
  const current = useEditor((s) => s.currentPageIndex);
  const cur = doc.pages[current];

  useEffect(
    () =>
      registerDrop('page', (payload, target) => {
        if (payload.type !== 'page') return;
        const d = useEditor.getState().doc!;
        const targetId = target.dataset.drop!.split(':')[1];
        if (targetId === payload.id) return;
        const from = d.pages.findIndex((p) => p.id === payload.id);
        let to = d.pages.findIndex((p) => p.id === targetId);
        if (target.dataset.dropHalf === 'after') to += 1;
        if (from < to) to -= 1;
        if (to !== from) editor.dispatch(cmdMovePage(d, payload.id, to));
      }),
    [],
  );

  const a = cur ? pageActions(cur.id) : null;
  return (
    <aside className="thumbs" aria-label="Seiten">
      <div className="thumbs-tools" role="toolbar" aria-label="Seitenaktionen">
        <button className="icon-btn" title="Nach oben (Alt+↑)" aria-label="Seite nach oben" disabled={!a || current === 0} onClick={() => a?.up()}><ArrowUp size={16} /></button>
        <button className="icon-btn" title="Nach unten (Alt+↓)" aria-label="Seite nach unten" disabled={!a || current >= doc.pages.length - 1} onClick={() => a?.down()}><ArrowDown size={16} /></button>
        <button className="icon-btn" title="90° drehen" aria-label="Seite um 90 Grad drehen" disabled={!a} onClick={() => a?.rotate(90)}><RotateCw size={16} /></button>
        <button className="icon-btn" title="Duplizieren" aria-label="Seite duplizieren" disabled={!a} onClick={() => a?.duplicate()}><Copy size={16} /></button>
        <button className="icon-btn" title="Notizseite danach einfügen" aria-label="Notizseite einfügen" onClick={onInsertNote}><FilePlus2 size={16} /></button>
        <button className="icon-btn" title="Seite löschen" aria-label="Seite löschen" disabled={!a || doc.pages.length <= 1} onClick={() => a?.remove()}><Trash2 size={16} /></button>
      </div>
      <div className="thumbs-list" role="listbox" aria-label="Seitenübersicht" aria-multiselectable>
        {doc.pages.map((p, i) => (
          <Thumb key={p.id} page={p} index={i} selected={selected.includes(p.id)} current={i === current} />
        ))}
      </div>
      {selected.length > 0 && <div className="thumbs-sel">{selected.length} Seite(n) ausgewählt · Strg+Klick zum Ändern</div>}
    </aside>
  );
}
