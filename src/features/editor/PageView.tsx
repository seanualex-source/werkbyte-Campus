// Eine Seite im Editor: PDF-Raster + eigene Objekte in einem Canvas, Live-Strich-Ebene,
// PDF-Textebene (nur im Auswahlwerkzeug), Formularfelder und Text-Editor im DOM.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, ImageAnnotation, InkPoint, PageRec, TextAnnotation, WidgetRec } from '../../domain/types';
import { FONT_ID } from '../../domain/types';
import { annotationsOfPage, cmdDeleteAnnotations, cmdSetFormValue, cmdUpsertAnnotation, fvKey, nextZ } from '../../domain/ops';
import { applyMat, displaySize, invert, nativeRectFromDisplay, totalRotation, transformRect, viewMatrix, type Mat } from '../../rendering/geometry';
import { DEFAULT_PRESSURE, distanceToPolyline, simplify, strokeOutline } from '../../rendering/stroke';
import { layoutText } from '../../rendering/textLayout';
import { FONT_FAMILY } from '../../rendering/fonts';
import { pdfjs } from '../../pdf/pdfjs';
import { api, errorMessage } from '../../ipc/api';
import { toast } from '../../app/ui';
import { drawComposite, getPdfPage, renderPdfBitmap, useFont, useImages } from './render';
import { editor, newId, useEditor } from './editorStore';
import { bounds, hitTest, localSize, rectForLocalSize, round, translateAnnotation } from './annotationGeometry';

interface Props {
  page: PageRec;
  index: number;
  zoom: number;
  visible: boolean;
  scrollEl: React.RefObject<HTMLDivElement | null>;
}

type Gesture =
  | { kind: 'draw'; pointerId: number; points: InkPoint[]; tool: 'pen' | 'highlight' }
  | { kind: 'move'; pointerId: number; start: [number, number]; orig: Annotation; moved: boolean }
  | { kind: 'resize'; pointerId: number; orig: Annotation; startDisp: { x: number; y: number; width: number; height: number }; startClient: [number, number] }
  | { kind: 'erase'; pointerId: number; ids: Set<string> }
  | { kind: 'pan'; pointerId: number; startClient: [number, number]; startScroll: [number, number] };

const TEXT_SAVE_DEBOUNCE = 500;
const TEXT_SAVE_MAX = 2000;

function PageViewImpl({ page, index, zoom, visible, scrollEl }: Props) {
  const doc = useEditor((s) => s.doc)!;
  const tool = useEditor((s) => s.tool);
  const options = useEditor((s) => s.options);
  const selectedId = useEditor((s) => s.selectedAnnotationId);
  const editingId = useEditor((s) => s.editingTextId);
  const metrics = useFont((s) => s.metrics);
  const imgVersion = useImages((s) => s.version);

  const sp = useMemo(
    () => (page.sourceId ? doc.snapshot.sourcePages.find((s) => s.sourceId === page.sourceId && s.pageIndex === page.sourcePageIndex) ?? null : null),
    [doc.snapshot.sourcePages, page.sourceId, page.sourcePageIndex],
  );
  const source = useMemo(() => (page.sourceId ? doc.snapshot.sources.find((s) => s.id === page.sourceId) ?? null : null), [doc.snapshot.sources, page.sourceId]);
  const rot = totalRotation(page, sp);
  const W = page.widthPt, H = page.heightPt;
  const [dw, dh] = displaySize(W, H, rot);
  const cssW = dw * zoom, cssH = dh * zoom;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const vm: Mat = useMemo(() => viewMatrix(rot, W, H, zoom), [rot, W, H, zoom]);
  const ivm = useMemo(() => invert(vm), [vm]);

  const anns = useMemo(() => annotationsOfPage(doc, page.id), [doc, page.id]);
  const widgets = useMemo(() => doc.widgets.filter((w) => w.pageId === page.id), [doc.widgets, page.id]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [bitmap, setBitmap] = useState<HTMLCanvasElement | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [erasing, setErasing] = useState<Set<string>>(new Set());
  const [renderError, setRenderError] = useState<string | null>(null);

  // PDF-Raster nur für sichtbare Seiten; veraltete Aufträge überschreiben keinen neueren Stand.
  useEffect(() => {
    if (!visible || page.kind !== 'pdf' || !source) return;
    let stale = false;
    const t = setTimeout(() => {
      renderPdfBitmap(source.blobHash, page.sourcePageIndex!, rot, cssW * dpr, () => stale)
        .then((b) => {
          if (!stale && b) {
            setBitmap(b);
            setRenderError(null);
          }
        })
        .catch((e) => !stale && setRenderError(errorMessage(e)));
    }, bitmap ? 90 : 0);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, source?.blobHash, page.sourcePageIndex, rot, Math.round(cssW * dpr / 32)]);

  // Komposition
  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    const list = draft ? anns.map((a) => (a.id === draft.id ? draft : a)) : anns;
    const hidden = new Set(erasing);
    if (editingId) hidden.add(editingId);
    const raf = requestAnimationFrame(() => {
      if (!canvasRef.current) return;
      drawComposite(canvasRef.current, { page, sp, annotations: list, metrics, pdfBitmap: page.kind === 'pdf' ? bitmap : null, pxPerPt: zoom * dpr, hiddenIds: hidden });
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, anns, draft, erasing, editingId, bitmap, zoom, dpr, page, sp, metrics, imgVersion]);

  // PDF-Textebene für Textauswahl (nur Auswahlwerkzeug, damit sie Stifteingaben nicht abfängt).
  useEffect(() => {
    const el = textLayerRef.current;
    if (!el || !visible || page.kind !== 'pdf' || !source || tool !== 'select') return;
    let cancelled = false;
    let layer: { cancel(): void } | null = null;
    getPdfPage(source.blobHash, page.sourcePageIndex!).then((p) => {
      if (cancelled) return;
      const base = p.getViewport({ scale: 1, rotation: rot });
      const viewport = p.getViewport({ scale: cssW / base.width, rotation: rot });
      el.style.setProperty('--scale-factor', String(viewport.scale));
      el.style.setProperty('--total-scale-factor', String(viewport.scale));
      el.style.setProperty('--user-unit', '1');
      el.style.setProperty('--scale-round-x', '1px');
      el.style.setProperty('--scale-round-y', '1px');
      const tl = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: el, viewport });
      layer = tl;
      tl.render().catch(() => undefined);
    });
    return () => {
      cancelled = true;
      layer?.cancel();
      el.replaceChildren();
    };
  }, [visible, page.kind, source?.blobHash, page.sourcePageIndex, rot, cssW, tool]);

  const toNative = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const r = wrapRef.current!.getBoundingClientRect();
      return applyMat(ivm, clientX - r.left, clientY - r.top);
    },
    [ivm],
  );

  const drawLive = (g: Extract<Gesture, { kind: 'draw' }>, final = false) => {
    const c = liveRef.current;
    if (!c) return;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d', { desynchronized: true } as CanvasRenderingContext2DSettings)!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (final) return;
    ctx.setTransform(vm[0] * dpr, vm[1] * dpr, vm[2] * dpr, vm[3] * dpr, vm[4] * dpr, vm[5] * dpr);
    const width = g.tool === 'pen' ? options.penWidth : options.highlightWidth;
    const pts = strokeOutline(g.tool === 'pen' ? 'ink' : 'highlight', { points: g.points, baseWidth: width }, false);
    if (pts.length < 6) return;
    ctx.globalAlpha = g.tool === 'highlight' ? 0.45 : 1;
    ctx.fillStyle = g.tool === 'pen' ? options.penColor : options.highlightColor;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
    ctx.fill();
  };

  const pressureOf = (e: PointerEvent | React.PointerEvent) => (e.pointerType === 'pen' && e.pressure > 0 ? Math.min(1, Math.max(0.05, e.pressure)) : DEFAULT_PRESSURE);

  const startPan = (e: React.PointerEvent) => {
    const s = scrollEl.current;
    if (!s) return;
    gesture.current = { kind: 'pan', pointerId: e.pointerId, startClient: [e.clientX, e.clientY], startScroll: [s.scrollLeft, s.scrollTop] };
    wrapRef.current?.setPointerCapture(e.pointerId);
  };

  const createText = (x: number, y: number) => {
    // Rechteck im Darstellungsraum aufziehen, damit der Text auf dem Bildschirm aufrecht steht.
    const [px, py] = applyMat(vm, x, y);
    const lh = options.textSize * 1.3 + 4;
    const r = nativeRectFromDisplay(rot, W, H, px / zoom, py / zoom - lh / 2, 220, lh);
    const a: TextAnnotation = {
      id: newId(),
      pageId: page.id,
      kind: 'text',
      zIndex: nextZ(doc, page.id),
      payloadVersion: 1,
      payload: { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), text: '', fontAssetId: FONT_ID, fontSize: options.textSize, lineHeight: 1.3, color: options.textColor, align: 'left', orient: rot },
    };
    // Erst beim ersten Zeichen speichern; leere Boxen werden verworfen.
    useEditor.setState({ selectedAnnotationId: a.id, editingTextId: a.id, doc: { ...doc, annotations: { ...doc.annotations, [a.id]: a } } });
    pendingNewText.current = a.id;
  };
  const pendingNewText = useRef<string | null>(null);

  const placeImage = async (x: number, y: number) => {
    try {
      const img = await api.imagePick();
      if (!img) return;
      const maxW = Math.min(240, W * 0.6);
      const ratio = img.heightPx / Math.max(1, img.widthPx);
      const dispW = Math.min(maxW, img.widthPx * 0.75);
      const dispH = dispW * ratio;
      const [px, py] = applyMat(vm, x, y);
      const r = nativeRectFromDisplay(rot, W, H, px / zoom - dispW / 2, py / zoom - dispH / 2, dispW, dispH);
      const a: ImageAnnotation = {
        id: newId(),
        pageId: page.id,
        kind: 'image',
        zIndex: nextZ(useEditor.getState().doc!, page.id),
        payloadVersion: 1,
        payload: { blobHash: img.hash, x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), opacity: 1, orient: rot },
      };
      editor.dispatch(cmdUpsertAnnotation(useEditor.getState().doc!, a, 'Bild einfügen'));
      useEditor.setState({ selectedAnnotationId: a.id, tool: 'select' });
    } catch (e) {
      toast(`Bild konnte nicht eingefügt werden: ${errorMessage(e)}`, 'error');
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (gesture.current) return;
    if ((e.target as HTMLElement).closest('.widget, .text-editor, .sel-handle')) return;
    useEditor.setState({ currentPageIndex: index });
    const [x, y] = toNative(e.clientX, e.clientY);
    const tol = 6 / zoom;
    const drawTool = tool === 'pen' || tool === 'highlight' || tool === 'eraser';
    if (e.pointerType === 'touch' && (drawTool || tool === 'text' || tool === 'image')) {
      // Im Stiftmodus bleibt Touch der Navigation vorbehalten.
      startPan(e);
      return;
    }
    if (tool === 'hand' || e.button === 1) {
      e.preventDefault();
      startPan(e);
      return;
    }
    if (editingId) {
      useEditor.setState({ editingTextId: null });
      if (tool !== 'select') return;
    }
    switch (tool) {
      case 'pen':
      case 'highlight': {
        if (e.button !== 0) return;
        e.preventDefault();
        const g: Gesture = { kind: 'draw', pointerId: e.pointerId, points: [{ x: round(x), y: round(y), pressure: pressureOf(e) }], tool };
        gesture.current = g;
        wrapRef.current?.setPointerCapture(e.pointerId);
        drawLive(g);
        return;
      }
      case 'eraser': {
        e.preventDefault();
        gesture.current = { kind: 'erase', pointerId: e.pointerId, ids: new Set() };
        wrapRef.current?.setPointerCapture(e.pointerId);
        eraseAt(x, y);
        return;
      }
      case 'text': {
        const hit = hitTest(anns, x, y, tol);
        if (hit?.kind === 'text') {
          useEditor.setState({ selectedAnnotationId: hit.id, editingTextId: hit.id });
        } else {
          createText(x, y);
        }
        e.preventDefault();
        return;
      }
      case 'image':
        e.preventDefault();
        void placeImage(x, y);
        return;
      case 'select': {
        const hit = hitTest(anns, x, y, tol);
        if (!hit) {
          useEditor.setState({ selectedAnnotationId: null });
          return; // native Textauswahl darf beginnen
        }
        e.preventDefault();
        if (e.detail >= 2 && hit.kind === 'text') {
          useEditor.setState({ selectedAnnotationId: hit.id, editingTextId: hit.id });
          return;
        }
        useEditor.setState({ selectedAnnotationId: hit.id });
        gesture.current = { kind: 'move', pointerId: e.pointerId, start: [x, y], orig: hit, moved: false };
        wrapRef.current?.setPointerCapture(e.pointerId);
      }
    }
  };

  const eraseAt = (x: number, y: number) => {
    const g = gesture.current;
    if (!g || g.kind !== 'erase') return;
    const tol = 5 / zoom;
    let changed = false;
    for (const a of anns) {
      if ((a.kind === 'ink' || a.kind === 'highlight') && !g.ids.has(a.id) && distanceToPolyline(a.payload.points, x, y) <= a.payload.baseWidth / 2 + tol) {
        g.ids.add(a.id);
        changed = true;
      }
    }
    if (changed) setErasing(new Set(g.ids));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (g.kind === 'pan') {
      const s = scrollEl.current;
      if (s) {
        s.scrollLeft = g.startScroll[0] - (e.clientX - g.startClient[0]);
        s.scrollTop = g.startScroll[1] - (e.clientY - g.startClient[1]);
      }
      return;
    }
    if (g.kind === 'draw') {
      const evs = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
      for (const ev of evs) {
        const [x, y] = toNative(ev.clientX, ev.clientY);
        const last = g.points[g.points.length - 1];
        if (Math.hypot(last.x - x, last.y - y) < 0.25 / zoom) continue;
        if (g.points.length >= 19000) break;
        g.points.push({ x: round(x), y: round(y), pressure: pressureOf(ev) });
      }
      drawLive(g);
      return;
    }
    const [x, y] = toNative(e.clientX, e.clientY);
    if (g.kind === 'erase') {
      eraseAt(x, y);
      return;
    }
    if (g.kind === 'move') {
      const dx = x - g.start[0], dy = y - g.start[1];
      if (!g.moved && Math.hypot(dx, dy) < 2 / zoom) return;
      g.moved = true;
      setDraft(translateAnnotation(g.orig, dx, dy));
      return;
    }
    if (g.kind === 'resize') {
      const a = g.orig;
      if (a.kind !== 'text' && a.kind !== 'image') return;
      let w = Math.max(12, g.startDisp.width + (e.clientX - g.startClient[0]));
      let h = Math.max(12, g.startDisp.height + (e.clientY - g.startClient[1]));
      if (a.kind === 'image') {
        const ratio = g.startDisp.height / g.startDisp.width;
        const s = Math.max(w / g.startDisp.width, h / g.startDisp.height);
        w = g.startDisp.width * s;
        h = w * ratio;
      }
      const r = nativeRectFromDisplay(rot, W, H, g.startDisp.x / zoom, g.startDisp.y / zoom, w / zoom, h / zoom);
      setDraft({ ...a, payload: { ...a.payload, x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) } } as Annotation);
    }
  };

  const finish = (e: React.PointerEvent, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    try {
      wrapRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* bereits freigegeben */
    }
    const d = useEditor.getState().doc!;
    if (g.kind === 'draw') {
      drawLive(g, true);
      if (cancelled) return; // Pointer-Cancel: angefangener Strich wird verworfen
      const pts = simplify(g.points, 0.12);
      const a: Annotation = {
        id: newId(),
        pageId: page.id,
        kind: g.tool === 'pen' ? 'ink' : 'highlight',
        zIndex: nextZ(d, page.id),
        payloadVersion: 1,
        payload: {
          points: pts,
          baseWidth: g.tool === 'pen' ? options.penWidth : options.highlightWidth,
          color: g.tool === 'pen' ? options.penColor : options.highlightColor,
          opacity: g.tool === 'pen' ? 1 : 0.5,
          smoothingVersion: 1,
        },
      };
      editor.dispatch(cmdUpsertAnnotation(d, a, g.tool === 'pen' ? 'Stiftstrich' : 'Textmarker'));
    } else if (g.kind === 'erase') {
      setErasing(new Set());
      if (!cancelled && g.ids.size) editor.dispatch(cmdDeleteAnnotations(d, [...g.ids], 'Radieren'));
    } else if (g.kind === 'move' || g.kind === 'resize') {
      const cur = draft;
      setDraft(null);
      if (!cancelled && cur && (g.kind === 'resize' || g.moved)) editor.dispatch(cmdUpsertAnnotation(d, cur, g.kind === 'move' ? 'Objekt verschieben' : 'Größe ändern'));
    }
  };

  // Auswahlrahmen im Darstellungsraum
  const selected = selectedId ? (draft?.id === selectedId ? draft : anns.find((a) => a.id === selectedId)) : null;
  const selRect = selected ? transformRect(vm, bounds(selected).x, bounds(selected).y, bounds(selected).width, bounds(selected).height) : null;

  const startResize = (e: React.PointerEvent) => {
    if (!selected || !selRect) return;
    e.stopPropagation();
    e.preventDefault();
    gesture.current = { kind: 'resize', pointerId: e.pointerId, orig: selected, startDisp: selRect, startClient: [e.clientX, e.clientY] };
    wrapRef.current?.setPointerCapture(e.pointerId);
  };

  const editing = editingId ? doc.annotations[editingId] : null;
  const toolCursor = { select: 'default', hand: 'grab', text: 'text', image: 'copy', pen: 'crosshair', highlight: 'crosshair', eraser: 'cell' }[tool];
  const drawMode = tool === 'pen' || tool === 'highlight' || tool === 'eraser';

  return (
    <div
      ref={wrapRef}
      className={`page ${drawMode ? 'draw-mode' : ''}`}
      data-page-index={index}
      style={{ width: cssW, height: cssH, cursor: toolCursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onLostPointerCapture={(e) => gesture.current?.pointerId === e.pointerId && finish(e, gesture.current.kind === 'draw')}
      aria-label={`Seite ${index + 1}`}
    >
      {visible ? (
        <>
          <canvas ref={canvasRef} className="page-canvas" style={{ width: cssW, height: cssH }} />
          <div ref={textLayerRef} className="textLayer" style={{ width: cssW, height: cssH, pointerEvents: tool === 'select' ? 'auto' : 'none' }} />
          <canvas ref={liveRef} className="live-canvas" style={{ width: cssW, height: cssH }} />
          {widgets.length > 0 && <WidgetLayer widgets={widgets} vm={vm} W={W} H={H} interactive={!drawMode} />}
          {selRect && !editing && (
            <div className="sel-box" style={{ left: selRect.x - 3, top: selRect.y - 3, width: selRect.width + 6, height: selRect.height + 6 }}>
              {(selected?.kind === 'text' || selected?.kind === 'image') && tool === 'select' && (
                <div className="sel-handle" role="slider" aria-label="Größe ändern" onPointerDown={startResize} onPointerMove={onPointerMove} onPointerUp={(e) => finish(e, false)} />
              )}
            </div>
          )}
          {editing && editing.kind === 'text' && editing.pageId === page.id && (
            <TextEditor key={editing.id} a={editing} vm={vm} zoom={zoom} rot={rot} isNew={pendingNewText.current === editing.id} onCommitted={() => (pendingNewText.current = null)} />
          )}
          {renderError && <div className="page-error">Seite konnte nicht dargestellt werden: {renderError}</div>}
        </>
      ) : null}
    </div>
  );
}

export const PageView = memo(PageViewImpl);

// ───────── Text-Editor ─────────

function TextEditor({ a, vm, zoom, rot, isNew, onCommitted }: { a: TextAnnotation; vm: Mat; zoom: number; rot: number; isNew: boolean; onCommitted: () => void }) {
  const metrics = useFont((s) => s.metrics);
  const [value, setValue] = useState(a.payload.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const session = useRef(newId());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPending = useRef<number | null>(null);
  const persisted = useRef(!isNew);
  const latest = useRef(value);
  latest.current = value;

  const p = a.payload;
  const { lw, lh } = localSize(p);
  const disp = transformRect(vm, p.x, p.y, p.width, p.height);
  const deg = (((rot - p.orient) % 360) + 360) % 360;

  const build = (text: string): TextAnnotation => {
    const base = useEditor.getState().doc?.annotations[a.id] as TextAnnotation | undefined;
    const cur = base ?? a;
    let payload = { ...cur.payload, text };
    if (metrics) {
      const { lw: w, lh: h } = localSize(payload);
      const need = layoutText({ text: text || ' ', width: w, fontSize: payload.fontSize, lineHeight: payload.lineHeight, align: payload.align }, metrics).height + 2;
      if (need > h + 0.5) payload = { ...payload, ...rectForLocalSize(payload, w, need) };
    }
    return { ...cur, payload };
  };

  const save = (final: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    firstPending.current = null;
    const text = latest.current;
    const d = useEditor.getState().doc;
    if (!d) return;
    if (!text.trim()) {
      if (final) {
        if (persisted.current) editor.dispatch(cmdDeleteAnnotations(d, [a.id], 'Text löschen'));
        else {
          const annotations = { ...d.annotations };
          delete annotations[a.id];
          useEditor.setState({ doc: { ...d, annotations } });
        }
      }
      return;
    }
    const next = build(text);
    const stored = d.annotations[a.id] as TextAnnotation | undefined;
    if (persisted.current && stored && stored.payload.text === next.payload.text && stored.payload.height === next.payload.height) return;
    if (!persisted.current) {
      // Neues Objekt: Inverses = Löschen; lokaler Entwurf wird zuvor entfernt, damit der Verlauf stimmt.
      const annotations = { ...d.annotations };
      delete annotations[a.id];
      const clean = { ...d, annotations };
      useEditor.setState({ doc: clean });
      editor.dispatch(cmdUpsertAnnotation(clean, next, 'Text einfügen'), `text:${a.id}:${session.current}`);
      persisted.current = true;
      onCommitted();
    } else {
      editor.dispatch(cmdUpsertAnnotation(d, next, 'Text bearbeiten'), `text:${a.id}:${session.current}`);
    }
  };

  useEffect(() => {
    ref.current?.focus();
    const el = ref.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
    return () => {
      save(true);
      editor.sealHistory();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = (v: string) => {
    setValue(v);
    latest.current = v;
    if (timer.current) clearTimeout(timer.current);
    const now = Date.now();
    firstPending.current ??= now;
    const wait = Math.max(0, Math.min(TEXT_SAVE_DEBOUNCE, TEXT_SAVE_MAX - (now - firstPending.current)));
    timer.current = setTimeout(() => save(false), wait);
  };

  return (
    <div className="text-editor" style={{ left: disp.x, top: disp.y, width: disp.width, height: Math.max(disp.height, 10) }}>
      <textarea
        ref={ref}
        aria-label="Text bearbeiten"
        value={value}
        spellCheck
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') useEditor.setState({ editingTextId: null });
        }}
        onBlur={() => useEditor.setState((s) => (s.editingTextId === a.id ? { editingTextId: null } : {}))}
        style={{
          width: lw * zoom,
          minHeight: lh * zoom,
          height: Math.max(lh * zoom, 10),
          left: (disp.width - lw * zoom) / 2,
          top: (Math.max(disp.height, 10) - lh * zoom) / 2,
          transform: deg ? `rotate(${deg}deg)` : undefined,
          fontFamily: `"${FONT_FAMILY}"`,
          fontSize: p.fontSize * zoom,
          lineHeight: p.lineHeight,
          color: p.color,
          textAlign: p.align,
        }}
      />
    </div>
  );
}

// ───────── Formularfelder ─────────

function WidgetLayer({ widgets, vm, W, H, interactive }: { widgets: WidgetRec[]; vm: Mat; W: number; H: number; interactive: boolean }) {
  const doc = useEditor((s) => s.doc)!;
  return (
    <div className="widget-layer" style={{ width: W, height: H, transform: `matrix(${vm.join(',')})`, pointerEvents: 'none' }}>
      {widgets.map((w) => (
        <Widget key={w.id} w={w} interactive={interactive} value={doc.formValues[fvKey(w.groupId, w.fieldKey)]?.value ?? null} />
      ))}
    </div>
  );
}

function Widget({ w, value, interactive }: { w: WidgetRec; value: string | boolean | null; interactive: boolean }) {
  const doc = useEditor((s) => s.doc)!;
  const group = doc.snapshot.formGroups.find((g) => g.id === w.groupId);
  const field = doc.snapshot.sources.find((s) => s.id === group?.sourceId)?.fields.find((f) => f.fieldKey === w.fieldKey);
  const session = useRef(newId());
  const [local, setLocal] = useState(typeof value === 'string' ? value : '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (typeof value === 'string' && document.activeElement?.getAttribute('data-widget') !== w.id) setLocal(value);
  }, [value, w.id]);
  if (!field) return null;
  const g = w.geometry;
  const style: React.CSSProperties = { left: g.x, top: g.y, width: g.width, height: g.height, pointerEvents: interactive ? 'auto' : 'none', fontSize: Math.max(6, Math.min(12, g.height * 0.65)) };
  const set = (v: string | boolean | null, coalesce?: boolean) => {
    const d = useEditor.getState().doc!;
    editor.dispatch(cmdSetFormValue(d, w.groupId, w.fieldKey, v), coalesce ? `form:${w.groupId}:${w.fieldKey}:${session.current}` : undefined);
  };
  const label = w.fieldKey;
  switch (field.fieldType) {
    case 'text': {
      const onChange = (v: string) => {
        setLocal(v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => set(v, true), 400);
      };
      const commit = () => {
        if (timer.current) clearTimeout(timer.current);
        if (local !== value) set(local, true);
        editor.sealHistory();
        session.current = newId();
      };
      const common = { className: 'widget widget-text', style, 'aria-label': label, 'data-widget': w.id, value: local, maxLength: field.maxLength ?? undefined, onBlur: commit, onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation() };
      return field.multiline ? <textarea {...common} onChange={(e) => onChange(e.target.value)} /> : <input {...common} onChange={(e) => onChange(e.target.value)} />;
    }
    case 'checkbox':
      return (
        <button className={`widget widget-check ${value === true ? 'on' : ''}`} style={style} role="checkbox" aria-checked={value === true} aria-label={label} onClick={() => set(!(value === true))}>
          {value === true ? '✓' : ''}
        </button>
      );
    case 'radio': {
      const on = value !== null && value === g.onValue;
      return (
        <button className={`widget widget-radio ${on ? 'on' : ''}`} style={style} role="radio" aria-checked={on} aria-label={`${label}: ${g.onValue}`} onClick={() => set(on ? null : g.onValue)} />
      );
    }
    case 'dropdown':
      return (
        <select className="widget widget-select" style={style} aria-label={label} value={typeof value === 'string' ? value : ''} onChange={(e) => set(e.target.value || null)} onKeyDown={(e) => e.stopPropagation()}>
          <option value="">–</option>
          {field.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
  }
}
