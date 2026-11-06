import { AlignCenter, AlignLeft, AlignRight, Copy, RotateCcw, RotateCw, Trash2, AlertTriangle } from 'lucide-react';
import type { Annotation, NoteBackground } from '../../domain/types';
import { cmdDeleteAnnotations, cmdSetBackground, cmdUpsertAnnotation } from '../../domain/ops';
import { totalRotation } from '../../rendering/geometry';
import { BACKGROUNDS, BACKGROUND_LABEL } from '../library/actions';
import { editor, useEditor } from './editorStore';
import { pageActions } from './Thumbnails';

export const PEN_COLORS = ['#17212B', '#1F4E8C', '#C62828', '#2E7D32', '#6A1B9A'];
export const HIGHLIGHT_COLORS = ['#FFE600', '#7CF27C', '#7FD6FF', '#FF9EC8'];
export const COLOR_NAMES: Record<string, string> = {
  '#17212B': 'Schwarz', '#1F4E8C': 'Blau', '#C62828': 'Rot', '#2E7D32': 'Grün', '#6A1B9A': 'Violett',
  '#FFE600': 'Gelb', '#7CF27C': 'Hellgrün', '#7FD6FF': 'Hellblau', '#FF9EC8': 'Rosa',
};

export function Swatches({ colors, value, onChange, label }: { colors: string[]; value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {colors.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={value.toUpperCase() === c}
          aria-label={COLOR_NAMES[c] ?? c}
          title={COLOR_NAMES[c] ?? c}
          className={`swatch ${value.toUpperCase() === c ? 'on' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function update(a: Annotation, patch: Record<string, unknown>, label: string) {
  const d = useEditor.getState().doc!;
  editor.dispatch(cmdUpsertAnnotation(d, { ...a, payload: { ...a.payload, ...patch } } as Annotation, label));
}

function AnnotationProps({ a }: { a: Annotation }) {
  const del = () => {
    editor.dispatch(cmdDeleteAnnotations(useEditor.getState().doc!, [a.id]));
    useEditor.setState({ selectedAnnotationId: null });
  };
  return (
    <section className="props-section">
      <h3>{a.kind === 'text' ? 'Text' : a.kind === 'image' ? 'Bild' : a.kind === 'ink' ? 'Stiftstrich' : 'Textmarker'}</h3>
      {a.kind === 'text' && (
        <>
          <label className="field">
            <span>Schriftgröße</span>
            <select value={a.payload.fontSize} onChange={(e) => update(a, { fontSize: Number(e.target.value) }, 'Schriftgröße')}>
              {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map((s) => (
                <option key={s} value={s}>{s} pt</option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Farbe</span>
            <Swatches colors={PEN_COLORS} value={a.payload.color} label="Textfarbe" onChange={(c) => update(a, { color: c }, 'Textfarbe')} />
          </div>
          <div className="field">
            <span>Ausrichtung</span>
            <div className="seg" role="radiogroup" aria-label="Ausrichtung">
              {(['left', 'center', 'right'] as const).map((al) => (
                <button key={al} role="radio" aria-checked={a.payload.align === al} className={a.payload.align === al ? 'on' : ''} aria-label={al === 'left' ? 'Links' : al === 'center' ? 'Zentriert' : 'Rechts'} onClick={() => update(a, { align: al }, 'Ausrichtung')}>
                  {al === 'left' ? <AlignLeft size={15} /> : al === 'center' ? <AlignCenter size={15} /> : <AlignRight size={15} />}
                </button>
              ))}
            </div>
          </div>
          <button onClick={() => useEditor.setState({ editingTextId: a.id })}>Text bearbeiten</button>
        </>
      )}
      {a.kind === 'image' && (
        <label className="field">
          <span>Deckkraft {Math.round(a.payload.opacity * 100)} %</span>
          <input type="range" min={10} max={100} value={Math.round(a.payload.opacity * 100)} onChange={(e) => update(a, { opacity: Number(e.target.value) / 100 }, 'Deckkraft')} />
        </label>
      )}
      {(a.kind === 'ink' || a.kind === 'highlight') && (
        <>
          <div className="field">
            <span>Farbe</span>
            <Swatches colors={a.kind === 'ink' ? PEN_COLORS : HIGHLIGHT_COLORS} value={a.payload.color} label="Strichfarbe" onChange={(c) => update(a, { color: c }, 'Farbe')} />
          </div>
          <label className="field">
            <span>Breite {a.payload.baseWidth.toFixed(1).replace('.', ',')} pt</span>
            <input type="range" min={a.kind === 'ink' ? 0.6 : 6} max={a.kind === 'ink' ? 10 : 30} step={0.2} value={a.payload.baseWidth} onChange={(e) => update(a, { baseWidth: Number(e.target.value) }, 'Strichbreite')} />
          </label>
        </>
      )}
      <button className="danger-text" onClick={del}>
        <Trash2 size={15} /> Löschen (Entf)
      </button>
    </section>
  );
}

export function PropertiesPanel() {
  const doc = useEditor((s) => s.doc)!;
  const selectedId = useEditor((s) => s.selectedAnnotationId);
  const current = useEditor((s) => s.currentPageIndex);
  const a = selectedId ? doc.annotations[selectedId] : null;
  const page = doc.pages[current];
  if (!page) return null;
  const sp = page.sourceId ? doc.snapshot.sourcePages.find((s) => s.sourceId === page.sourceId && s.pageIndex === page.sourcePageIndex) : null;
  const src = page.sourceId ? doc.snapshot.sources.find((s) => s.id === page.sourceId) : null;
  const pa = pageActions(page.id);
  const setBg = (t: NoteBackground['type']) => editor.dispatch(cmdSetBackground(doc, page.id, BACKGROUNDS[t]));
  return (
    <aside className="props" aria-label="Eigenschaften">
      {a && <AnnotationProps a={a} />}
      <section className="props-section">
        <h3>Seite {current + 1} von {doc.pages.length}</h3>
        <p className="muted small">
          {page.kind === 'note' ? 'Notizseite' : `PDF-Seite ${page.sourcePageIndex! + 1}${src?.originalName ? ` aus ${src.originalName}` : ''}`}
          {' · '}
          {totalRotation(page, sp)}°
        </p>
        <div className="row-gap">
          <button onClick={() => pa.rotate(-90)} aria-label="Gegen den Uhrzeigersinn drehen" title="Links drehen"><RotateCcw size={15} /></button>
          <button onClick={() => pa.rotate(90)} aria-label="Im Uhrzeigersinn drehen" title="Rechts drehen"><RotateCw size={15} /></button>
          <button onClick={pa.duplicate}><Copy size={15} /> Duplizieren</button>
        </div>
        {page.kind === 'note' && page.background && (
          <div className="field">
            <span>Papier</span>
            <div className="seg" role="radiogroup" aria-label="Papier">
              {(['blank', 'ruled', 'grid'] as const).map((t) => (
                <button key={t} role="radio" aria-checked={page.background!.type === t} className={page.background!.type === t ? 'on' : ''} onClick={() => setBg(t)}>
                  {BACKGROUND_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
      {src?.compatibility?.warnings && src.compatibility.warnings.length > 0 && (
        <section className="props-section">
          <h3><AlertTriangle size={15} /> Hinweise zur Quelle</h3>
          <ul className="small muted warn-list">
            {src.compatibility.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </section>
      )}
    </aside>
  );
}
