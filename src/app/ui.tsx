// Gemeinsame UI-Bausteine: Hinweise (Toasts), modale Dialoge, Eingabe- und Bestätigungsdialoge.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { X } from 'lucide-react';

// ───────── Hinweise ─────────

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error' | 'warning';
  message: string;
}

const useToastStore = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));
let toastSeq = 0;

export function toast(message: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 9000 : 4500) {
  const id = ++toastSeq;
  useToastStore.setState((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
  setTimeout(() => useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span>{t.message}</span>
          <button className="icon-btn small" aria-label="Hinweis schließen" onClick={() => useToastStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ───────── Modale Dialoge ─────────

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button.primary, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title} ref={ref} style={{ width: props.width ?? 460 }}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="icon-btn" aria-label="Dialog schließen" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

type DialogSpec =
  | { kind: 'prompt'; title: string; label: string; initial: string; confirm: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; message: ReactNode; confirm: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: 'custom'; render: (close: () => void) => ReactNode };

const useDialogStore = create<{ stack: DialogSpec[] }>(() => ({ stack: [] }));

function pushDialog(d: DialogSpec) {
  useDialogStore.setState((s) => ({ stack: [...s.stack, d] }));
}
function popDialog(d: DialogSpec) {
  useDialogStore.setState((s) => ({ stack: s.stack.filter((x) => x !== d) }));
}

export function promptText(title: string, label: string, initial = '', confirm = 'OK'): Promise<string | null> {
  return new Promise((resolve) => pushDialog({ kind: 'prompt', title, label, initial, confirm, resolve }));
}

export function confirmDialog(title: string, message: ReactNode, confirm = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => pushDialog({ kind: 'confirm', title, message, confirm, danger, resolve }));
}

export function openDialog(render: (close: () => void) => ReactNode) {
  pushDialog({ kind: 'custom', render });
}

function PromptDialog({ d }: { d: Extract<DialogSpec, { kind: 'prompt' }> }) {
  const [v, setV] = useState(d.initial);
  const done = (val: string | null) => {
    popDialog(d);
    d.resolve(val);
  };
  return (
    <Modal
      title={d.title}
      onClose={() => done(null)}
      footer={
        <>
          <button onClick={() => done(null)}>Abbrechen</button>
          <button className="primary" disabled={!v.trim()} onClick={() => done(v.trim())}>
            {d.confirm}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{d.label}</span>
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => e.key === 'Enter' && v.trim() && done(v.trim())}
          maxLength={300}
        />
      </label>
    </Modal>
  );
}

function ConfirmDialog({ d }: { d: Extract<DialogSpec, { kind: 'confirm' }> }) {
  const done = (val: boolean) => {
    popDialog(d);
    d.resolve(val);
  };
  return (
    <Modal
      title={d.title}
      onClose={() => done(false)}
      footer={
        <>
          <button onClick={() => done(false)}>Abbrechen</button>
          <button className={d.danger ? 'danger' : 'primary'} onClick={() => done(true)}>
            {d.confirm}
          </button>
        </>
      }
    >
      <div className="confirm-text">{d.message}</div>
    </Modal>
  );
}

export function DialogHost() {
  const stack = useDialogStore((s) => s.stack);
  return (
    <>
      {stack.map((d, i) =>
        d.kind === 'prompt' ? (
          <PromptDialog key={i} d={d} />
        ) : d.kind === 'confirm' ? (
          <ConfirmDialog key={i} d={d} />
        ) : (
          <div key={i}>{d.render(() => popDialog(d))}</div>
        ),
      )}
    </>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
}

export function formatDate(iso: string | null | undefined) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
