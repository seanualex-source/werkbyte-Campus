// Autosave-Warteschlange (§6.3): bündelt Fachbefehle, sendet genau eine Anfrage gleichzeitig,
// meldet „Gespeichert“ erst nach bestätigtem Commit und wiederholt mit derselben Request-ID.

import type { ApplyResult, Mutation, Op } from './types';

export type SaveStatus = 'saved' | 'saving' | 'pending' | 'error' | 'blocked';

export interface SaveError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SaveQueueEvents {
  onStatus(status: SaveStatus, error?: SaveError): void;
  /** Nicht wiederholbarer Fehler (z. B. Konflikt): lokaler Stand muss neu geladen werden. */
  onRejected(error: SaveError, droppedOps: Op[]): void;
  onCommitted?(result: ApplyResult): void;
}

export const MAX_PENDING_WHILE_FAILING = 400;

export class SaveQueue {
  private pending: Op[] = [];
  private inflight: Mutation | null = null;
  private running = false;
  private waiters: ((ok: boolean) => void)[] = [];
  private stopped = false;
  status: SaveStatus = 'saved';
  lastError: SaveError | undefined;

  constructor(
    private documentId: string,
    public confirmedRevision: number,
    private send: (m: Mutation) => Promise<ApplyResult>,
    private events: SaveQueueEvents,
    private newId: () => string,
    private delay: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get hasUnsaved(): boolean {
    return this.pending.length > 0 || this.inflight !== null;
  }

  /** Bei andauernden Fehlern wird weitere Bearbeitung begrenzt (§3.3). */
  get editingBlocked(): boolean {
    return (this.status === 'error' || this.status === 'blocked') && this.pending.length >= MAX_PENDING_WHILE_FAILING;
  }

  enqueue(ops: Op[]) {
    if (this.stopped || ops.length === 0) return;
    this.pending.push(...ops);
    if (this.status !== 'error' && this.status !== 'blocked') this.setStatus('pending');
    void this.pump();
  }

  /**
   * Wartet, bis alle bisher eingereihten Änderungen bestätigt sind (true) oder ein Fehler
   * vorliegt (false). Aufrufer dürfen bei false keinen Erfolg melden.
   */
  flush(): Promise<boolean> {
    if (!this.hasUnsaved) return Promise.resolve(true);
    void this.pump();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  stop() {
    this.stopped = true;
    this.resolveWaiters(!this.hasUnsaved);
  }

  private resolveWaiters(ok: boolean) {
    this.waiters.splice(0).forEach((w) => w(ok));
  }

  private setStatus(s: SaveStatus, e?: SaveError) {
    this.status = s;
    this.lastError = e;
    this.events.onStatus(s, e);
    if (s === 'saved' && !this.hasUnsaved) this.resolveWaiters(true);
    if (s === 'error' || s === 'blocked') this.resolveWaiters(false);
  }

  private async pump() {
    if (this.running || this.stopped) return;
    this.running = true;
    let attempt = 0;
    try {
      while (!this.stopped && (this.inflight || this.pending.length)) {
        if (!this.inflight) {
          this.inflight = {
            requestId: this.newId(),
            documentId: this.documentId,
            expectedRevision: this.confirmedRevision,
            payload: this.pending.splice(0, 2000),
          };
        }
        this.setStatus('saving');
        try {
          const res = await this.send(this.inflight);
          this.confirmedRevision = res.revision;
          this.inflight = null;
          attempt = 0;
          this.events.onCommitted?.(res);
          if (!this.pending.length) this.setStatus('saved');
        } catch (raw) {
          const err = normalizeError(raw);
          if (err.retryable) {
            attempt++;
            this.setStatus(this.pending.length >= MAX_PENDING_WHILE_FAILING ? 'blocked' : 'error', err);
            // Gleiche Request-ID erneut senden: das Backend wendet doppelt nicht an.
            await this.delay(Math.min(15000, 500 * 2 ** Math.min(attempt, 5)));
          } else {
            const dropped = [...(this.inflight?.payload ?? []), ...this.pending];
            this.inflight = null;
            this.pending = [];
            this.setStatus('error', err);
            this.events.onRejected(err, dropped);
          }
        }
      }
    } finally {
      this.running = false;
      if (!this.hasUnsaved) this.resolveWaiters(true);
    }
  }
}

export function normalizeError(raw: unknown): SaveError {
  if (raw && typeof raw === 'object' && 'code' in raw && 'message' in raw) {
    const r = raw as { code: string; message: string; retryable?: boolean };
    return { code: r.code, message: r.message, retryable: !!r.retryable };
  }
  if (typeof raw === 'string') return { code: 'INTERNAL', message: raw, retryable: true };
  return { code: 'INTERNAL', message: String((raw as Error)?.message ?? raw), retryable: true };
}
