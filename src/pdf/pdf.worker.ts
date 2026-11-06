// PDF-Worker: Importanalyse und Exportkomposition außerhalb des UI-Threads.
// Hinweis: Ein Worker hält die Oberfläche reaktionsfähig, ist aber keine Sicherheits-Sandbox (§4.2).

import { analyzeWithPdfLib } from './analyzeForms';
import { composeExport } from './composeExport';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent) => {
  const { id, type } = e.data;
  try {
    if (type === 'analyze') {
      const result = await analyzeWithPdfLib(e.data.bytes, e.data.maxPages);
      ctx.postMessage({ id, ok: true, result });
    } else if (type === 'export') {
      let last = 0;
      const out = await composeExport(e.data.input, (done, total) => {
        const now = Date.now();
        if (now - last > 100 || done === total) {
          last = now;
          ctx.postMessage({ id, progress: { done, total } });
        }
      });
      ctx.postMessage({ id, ok: true, result: out }, [out.buffer]);
    } else {
      throw new Error('Unbekannter Auftrag');
    }
  } catch (err) {
    const e2 = err as { code?: string; message?: string };
    ctx.postMessage({ id, ok: false, error: { code: e2?.code ?? 'INTERNAL', message: e2?.message ?? String(err), retryable: false } });
  }
};
