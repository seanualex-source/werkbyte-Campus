// Importablauf (§6.2): Staging-Kopie lesen → klassifizieren → Import abschließen oder verwerfen.

import type { ImportAnalysis, StagedInfo } from '../../domain/types';
import { api, errorMessage } from '../../ipc/api';
import { analyzeGeometry } from '../../pdf/pdfjs';
import { analyzeForms } from '../../pdf/workerClient';

export const MAX_PAGES_PER_SOURCE = 1000;

export interface ImportOutcome {
  imported: { name: string; documentId: string; warnings: string[] }[];
  failed: { name: string; message: string }[];
}

export async function importStaged(
  staged: StagedInfo[],
  folderId: string | null,
  onProgress?: (index: number, total: number, name: string) => void,
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { imported: [], failed: [] };
  for (let i = 0; i < staged.length; i++) {
    const s = staged[i];
    onProgress?.(i, staged.length, s.name);
    try {
      const bytes = await api.importStagedRead(s.stagingId);
      const pages = await analyzeGeometry(bytes, MAX_PAGES_PER_SOURCE);
      const forms = await analyzeForms(bytes, MAX_PAGES_PER_SOURCE);
      if (forms.pageCount !== pages.length) throw new Error('Die Seitenanalyse ist widersprüchlich; die Datei wird nicht importiert.');
      const title = s.name.replace(/\.pdf$/i, '').trim() || 'Dokument';
      const analysis: ImportAnalysis = {
        title,
        folderId,
        pageCount: pages.length,
        pages,
        fields: forms.fields,
        warnings: forms.warnings,
        pdfVersion: forms.pdfVersion,
      };
      const documentId = await api.importCommit(s.stagingId, analysis);
      outcome.imported.push({ name: s.name, documentId, warnings: forms.warnings });
    } catch (e) {
      await api.importDiscard(s.stagingId).catch(() => undefined);
      outcome.failed.push({ name: s.name, message: errorMessage(e) });
    }
  }
  onProgress?.(staged.length, staged.length, '');
  return outcome;
}
