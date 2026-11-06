// Verbindlicher Exportablauf (§8.2).

import type { DocumentSnapshot } from '../../domain/types';
import { api } from '../../ipc/api';
import { loadBundledFont } from '../../rendering/fonts';
import { displaySize, totalRotation } from '../../rendering/geometry';
import { verifyExport } from '../../pdf/pdfjs';
import { runExport, type ExportJob } from '../../pdf/workerClient';

export interface ExportRequest {
  documentId: string;
  title: string;
  pageIds?: string[];
  /** Speichert ausstehende Änderungen; false = Speichern fehlgeschlagen. */
  flush: () => Promise<boolean>;
}

export interface ExportResult {
  path: string;
  revision: number;
  pages: number;
}

export interface ExportHandle {
  promise: Promise<ExportResult | null>;
  cancel(): void;
}

function sniffImage(b: Uint8Array): 'png' | 'jpeg' {
  return b[0] === 0x89 && b[1] === 0x50 ? 'png' : 'jpeg';
}

export function startExport(req: ExportRequest, onStage: (stage: string, done?: number, total?: number) => void): ExportHandle {
  let job: ExportJob | null = null;
  let cancelled = false;
  let exportId: string | null = null;
  const promise = (async (): Promise<ExportResult | null> => {
    onStage('Änderungen werden gespeichert …');
    if (!(await req.flush())) throw { code: 'INTERNAL', message: 'Ausstehende Änderungen konnten nicht gespeichert werden. Der Export wurde nicht gestartet.' };
    const token = await api.exportPickTarget(req.title);
    if (!token || cancelled) return null;
    onStage('Stand wird festgehalten …');
    const prep = await api.exportPrepare(req.documentId);
    exportId = prep.exportId;
    try {
      const snap: DocumentSnapshot = prep.snapshot;
      const pageIds = (req.pageIds?.length ? snap.pages.filter((p) => req.pageIds!.includes(p.id)) : [...snap.pages].sort((a, b) => a.position - b.position)).map((p) => p.id);
      const selected = new Set(pageIds);
      const pages = snap.pages.filter((p) => selected.has(p.id));
      onStage('Quellen werden geladen …');
      const sourceIds = new Set(pages.map((p) => p.sourceId).filter(Boolean) as string[]);
      const sources: Record<string, Uint8Array> = {};
      for (const s of snap.sources) if (sourceIds.has(s.id)) sources[s.id] = await api.blobRead(s.blobHash);
      const images: Record<string, { bytes: Uint8Array; kind: 'png' | 'jpeg' }> = {};
      for (const a of snap.annotations) {
        if (a.kind === 'image' && selected.has(a.pageId) && !images[a.payload.blobHash]) {
          const bytes = await api.blobRead(a.payload.blobHash);
          images[a.payload.blobHash] = { bytes, kind: sniffImage(bytes) };
        }
      }
      const font = await loadBundledFont();
      if (cancelled) throw { code: 'CANCELLED', message: 'Export abgebrochen.' };
      onStage('PDF wird erzeugt …', 0, pageIds.length);
      job = runExport({ snapshot: snap, pageIds, sources, images, fontBytes: font.bytes }, (d, t) => onStage('PDF wird erzeugt …', d, t));
      const out = await job.promise;
      onStage('Ergebnis wird geprüft …');
      const byId = new Map(snap.pages.map((p) => [p.id, p]));
      const spMap = new Map(snap.sourcePages.map((s) => [`${s.sourceId}:${s.pageIndex}`, s]));
      await verifyExport(
        out,
        pageIds.map((id) => {
          const p = byId.get(id)!;
          const sp = p.sourceId ? spMap.get(`${p.sourceId}:${p.sourcePageIndex}`) : undefined;
          const [w, h] = displaySize(p.widthPt, p.heightPt, 0);
          return { w, h, rotation: totalRotation(p, sp) };
        }),
      );
      if (cancelled) throw { code: 'CANCELLED', message: 'Export abgebrochen.' };
      onStage('Datei wird geschrieben …');
      const res = await api.exportFinish(prep.exportId, token, out);
      exportId = null;
      return { path: res.path, revision: snap.document.revision, pages: pageIds.length };
    } catch (e) {
      if (exportId) await api.exportCancel(exportId).catch(() => undefined);
      throw e;
    }
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
      job?.cancel();
    },
  };
}
