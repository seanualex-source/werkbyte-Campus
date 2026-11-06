// Client für den PDF-Worker. Exporte erhalten einen eigenen Worker, damit „Abbrechen“ ihn sofort beenden kann.

import type { FormAnalysis } from './analyzeForms';
import type { ExportInput } from './composeExport';

function spawn() {
  return new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
}

let shared: Worker | null = null;
let seq = 0;

function request<T>(worker: Worker, msg: Record<string, unknown>, transfer: Transferable[], onProgress?: (d: number, t: number) => void): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      if (e.data.progress) {
        onProgress?.(e.data.progress.done, e.data.progress.total);
        return;
      }
      worker.removeEventListener('message', handler);
      if (e.data.ok) resolve(e.data.result as T);
      else reject(e.data.error);
    };
    worker.addEventListener('message', handler);
    worker.addEventListener('error', (ev) => reject({ code: 'INTERNAL', message: ev.message || 'PDF-Worker abgestürzt.', retryable: false }), { once: true });
    worker.postMessage({ id, ...msg }, transfer);
  });
}

export function analyzeForms(bytes: Uint8Array, maxPages: number): Promise<FormAnalysis> {
  shared ??= spawn();
  const copy = bytes.slice();
  return request<FormAnalysis>(shared, { type: 'analyze', bytes: copy, maxPages }, [copy.buffer]);
}

export interface ExportJob {
  promise: Promise<Uint8Array>;
  cancel(): void;
}

export function runExport(input: ExportInput, onProgress: (d: number, t: number) => void): ExportJob {
  const w = spawn();
  let cancelled = false;
  let rejectFn: (e: unknown) => void = () => {};
  const promise = new Promise<Uint8Array>((resolve, reject) => {
    rejectFn = reject;
    request<Uint8Array>(w, { type: 'export', input }, [], onProgress)
      .then(resolve, reject)
      .finally(() => w.terminate());
  });
  return {
    promise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      w.terminate();
      rejectFn({ code: 'CANCELLED', message: 'Export abgebrochen.', retryable: false });
    },
  };
}
