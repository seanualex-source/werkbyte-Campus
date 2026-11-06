// Exportadapter (Spezifikation §8.2): komponiert aus einem unveränderlichen Dokument-Snapshot ein
// neues PDF. Läuft im Worker und ist ohne DOM lauffähig (auch in Node-Tests).

import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFName,
  PDFPage,
  PDFRef,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  beginText,
  closePath,
  concatTransformationMatrix,
  degrees,
  drawObject,
  endText,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  showText,
  stroke,
  type PDFOperator,
} from 'pdf-lib';
import type { Annotation, DocumentSnapshot, FormValueRec, PageRec, SourcePageRec } from '../domain/types';
import { createMetrics, missingGlyphs, type FontMetrics } from '../rendering/fonts';
import { pdfUserSpaceMatrix, totalRotation, type Mat } from '../rendering/geometry';
import { annotationPrims, backgroundPrims, sortedAnnotations, type Blend, type Prim } from '../rendering/primitives';

export interface ExportInput {
  snapshot: DocumentSnapshot;
  /** Seiten in Exportreihenfolge (stabile IDs). */
  pageIds: string[];
  sources: Record<string, Uint8Array>;
  images: Record<string, { bytes: Uint8Array; kind: 'png' | 'jpeg' }>;
  fontBytes: Uint8Array;
}

export class ExportError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

type Progress = (done: number, total: number) => void;

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Prüft vor dem Export, ob alle Zeichen mit der eingebetteten Schrift darstellbar sind. */
export function checkGlyphs(annotations: Annotation[], m: FontMetrics): string[] {
  const missing = new Set<string>();
  for (const a of annotations) if (a.kind === 'text') for (const c of missingGlyphs(a.payload.text, m)) missing.add(c);
  return [...missing];
}

class PageWriter {
  private gsCache = new Map<string, PDFName>();
  private fontKey: PDFName | null = null;
  private imageKeys = new Map<string, PDFName>();
  constructor(
    private page: PDFPage,
    private doc: PDFDocument,
    private font: PDFFont,
    private images: (hash: string) => Promise<PDFImage>,
    private gsRefs: Map<string, PDFRef>,
  ) {}

  private gs(alpha: number, blend: Blend): PDFName {
    const key = `${alpha.toFixed(3)}|${blend}`;
    let name = this.gsCache.get(key);
    if (!name) {
      let ref = this.gsRefs.get(key);
      if (!ref) {
        ref = this.doc.context.register(
          this.doc.context.obj({ Type: 'ExtGState', ca: alpha, CA: alpha, BM: blend === 'multiply' ? 'Multiply' : 'Normal' }),
        );
        this.gsRefs.set(key, ref);
      }
      name = this.page.node.newExtGState('CampusGS', ref);
      this.gsCache.set(key, name);
    }
    return name;
  }

  private fontName(): PDFName {
    if (!this.fontKey) this.fontKey = this.page.node.newFontDictionary('CampusF', this.font.ref);
    return this.fontKey;
  }

  async draw(prims: Prim[], toPdf: Mat) {
    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...toPdf)];
    for (const p of prims) {
      switch (p.t) {
        case 'line': {
          ops.push(pushGraphicsState(), setStrokingRgbColor(...hexToRgb(p.color)), setLineWidth(p.width), moveTo(p.x1, p.y1), lineTo(p.x2, p.y2), stroke(), popGraphicsState());
          break;
        }
        case 'poly': {
          if (p.pts.length < 6) break;
          ops.push(pushGraphicsState(), setGraphicsState(this.gs(p.alpha, p.blend)), setFillingRgbColor(...hexToRgb(p.color)));
          ops.push(moveTo(p.pts[0], p.pts[1]));
          for (let i = 2; i < p.pts.length; i += 2) ops.push(lineTo(p.pts[i], p.pts[i + 1]));
          ops.push(closePath(), fill(), popGraphicsState());
          break;
        }
        case 'text': {
          const fontName = this.fontName();
          ops.push(pushGraphicsState(), concatTransformationMatrix(...p.frame), setFillingRgbColor(...hexToRgb(p.color)));
          ops.push(beginText(), setFontAndSize(fontName, p.size));
          for (const line of p.lines) {
            if (!line.text) continue;
            // Im y-nach-unten-Rahmen die Glyphen wieder aufrichten.
            ops.push(setTextMatrix(1, 0, 0, -1, line.x, line.baseline), showText(this.font.encodeText(line.text)));
          }
          ops.push(endText(), popGraphicsState());
          break;
        }
        case 'image': {
          let key = this.imageKeys.get(p.hash);
          if (!key) {
            const img = await this.images(p.hash);
            key = this.page.node.newXObject('CampusIm', img.ref);
            this.imageKeys.set(p.hash, key);
          }
          ops.push(pushGraphicsState(), setGraphicsState(this.gs(p.alpha, 'normal')), concatTransformationMatrix(...p.frame));
          // Einheitsquadrat des Bildes (y nach oben) in den lokalen Rahmen (y nach unten) legen.
          ops.push(concatTransformationMatrix(p.width, 0, 0, -p.height, 0, p.height), drawObject(key), popGraphicsState());
          break;
        }
      }
    }
    ops.push(popGraphicsState());
    this.page.pushOperators(...ops);
  }
}

async function loadSource(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false });
}

/** Setzt Formularwerte einer Gruppe in eine eigene Kopie der Quelle ein und flacht alle Felder ab. */
async function flattenedInstance(bytes: Uint8Array, values: FormValueRec[] | null, fontBytes: Uint8Array): Promise<PDFDocument> {
  const doc = await loadSource(bytes);
  const form = doc.getForm();
  if (form.getFields().length === 0) return doc;
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  if (values) {
    for (const v of values) {
      let field;
      try {
        field = form.getField(v.fieldKey);
      } catch {
        continue; // Feld existiert in der Quelle nicht mehr: kein Wert übertragen.
      }
      if (field instanceof PDFTextField) field.setText(typeof v.value === 'string' ? v.value : '');
      else if (field instanceof PDFCheckBox) (v.value === true ? field.check() : field.uncheck());
      else if (field instanceof PDFRadioGroup) (typeof v.value === 'string' ? field.select(v.value) : field.clear());
      else if (field instanceof PDFDropdown) (typeof v.value === 'string' ? field.select(v.value) : field.clear());
    }
  }
  form.updateFieldAppearances(font);
  form.flatten({ updateFieldAppearances: false });
  return doc;
}

export async function composeExport(input: ExportInput, onProgress?: Progress, isCancelled?: () => boolean): Promise<Uint8Array> {
  const { snapshot, pageIds } = input;
  const metrics = createMetrics(input.fontBytes);
  const pageById = new Map(snapshot.pages.map((p) => [p.id, p]));
  const pages: PageRec[] = pageIds.map((id) => {
    const p = pageById.get(id);
    if (!p) throw new ExportError('INVALID', 'Eine ausgewählte Seite existiert im Snapshot nicht.');
    return p;
  });
  if (pages.length === 0) throw new ExportError('INVALID', 'Keine Seiten zum Exportieren ausgewählt.');
  const annsByPage = new Map<string, Annotation[]>();
  for (const a of snapshot.annotations) {
    const l = annsByPage.get(a.pageId) ?? [];
    l.push(a);
    annsByPage.set(a.pageId, l);
  }
  const exported = pages.flatMap((p) => annsByPage.get(p.id) ?? []);
  const missing = checkGlyphs(exported, metrics);
  if (missing.length) {
    throw new ExportError('GLYPH_MISSING', `Diese Zeichen kann die eingebettete Schrift nicht darstellen: ${missing.join(' ')}`);
  }
  const sp = new Map<string, SourcePageRec>(snapshot.sourcePages.map((s) => [`${s.sourceId}:${s.pageIndex}`, s]));
  const widgetGroupsByPage = new Map<string, string>();
  for (const w of snapshot.widgets) widgetGroupsByPage.set(w.pageId, w.groupId);
  const groupById = new Map(snapshot.formGroups.map((g) => [g.id, g]));
  const valuesByGroup = new Map<string, FormValueRec[]>();
  for (const v of snapshot.formValues) {
    const l = valuesByGroup.get(v.groupId) ?? [];
    l.push(v);
    valuesByGroup.set(v.groupId, l);
  }

  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  out.setProducer('werkbyte Campus');
  out.setCreator('werkbyte Campus');
  out.setTitle(snapshot.document.title);
  const font = await out.embedFont(input.fontBytes, { subset: true });
  const embedded = new Map<string, Promise<PDFImage>>();
  const imageFor = (hash: string) => {
    let pr = embedded.get(hash);
    if (!pr) {
      const img = input.images[hash];
      if (!img) throw new ExportError('FILE_MISSING', 'Ein Bild fehlt im Export-Snapshot.');
      pr = img.kind === 'png' ? out.embedPng(img.bytes) : out.embedJpg(img.bytes);
      embedded.set(hash, pr);
    }
    return pr;
  };
  const gsRefs = new Map<string, PDFRef>();
  // Quellinstanzen: Basis (abgeflacht mit Originalwerten) und je Formulargruppe eine eigene Kopie.
  const instances = new Map<string, Promise<PDFDocument>>();
  const instanceFor = (sourceId: string, groupId: string | null) => {
    const key = groupId ? `g:${groupId}` : `s:${sourceId}`;
    let pr = instances.get(key);
    if (!pr) {
      const bytes = input.sources[sourceId];
      if (!bytes) throw new ExportError('FILE_MISSING', 'Eine Quelldatei fehlt im Export-Snapshot.');
      pr = flattenedInstance(bytes, groupId ? valuesByGroup.get(groupId) ?? [] : null, input.fontBytes);
      instances.set(key, pr);
    }
    return pr;
  };

  for (let i = 0; i < pages.length; i++) {
    if (isCancelled?.()) throw new ExportError('CANCELLED', 'Export abgebrochen.');
    const page = pages[i];
    let target: PDFPage;
    let toPdf: Mat;
    if (page.kind === 'pdf') {
      const src = sp.get(`${page.sourceId}:${page.sourcePageIndex}`);
      if (!src || !page.sourceId) throw new ExportError('PDF_CORRUPT', 'Quellseite im Snapshot nicht gefunden.');
      const groupId = widgetGroupsByPage.get(page.id) ?? null;
      if (groupId && groupById.get(groupId)?.sourceId !== page.sourceId) throw new ExportError('INVALID', 'Formulargruppe passt nicht zur Quelle.');
      const inst = await instanceFor(page.sourceId, groupId);
      const [copied] = await out.copyPages(inst, [page.sourcePageIndex!]);
      target = out.addPage(copied);
      toPdf = pdfUserSpaceMatrix(src.cropX, src.cropY, src.heightPt, src.userUnit);
      target.setRotation(degrees(totalRotation(page, src)));
    } else {
      target = out.addPage([page.widthPt, page.heightPt]);
      toPdf = pdfUserSpaceMatrix(0, 0, page.heightPt, 1);
      target.setRotation(degrees(page.rotation));
    }
    const prims: Prim[] = [...backgroundPrims(page)];
    for (const a of sortedAnnotations(annsByPage.get(page.id) ?? [])) prims.push(...annotationPrims(a, metrics));
    if (prims.length) await new PageWriter(target, out, font, imageFor, gsRefs).draw(prims, toPdf);
    onProgress?.(i + 1, pages.length);
  }
  return out.save({ useObjectStreams: true });
}
