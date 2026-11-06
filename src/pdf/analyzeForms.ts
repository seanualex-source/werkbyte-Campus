// Importklassifikation mit pdf-lib (Spezifikation §2.2): Verschlüsselung, XFA, Signaturfelder,
// unterstützte AcroForm-Felder samt Widgets sowie ein Exportfähigkeitstest. Läuft im Worker.

import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  PDFButton,
  EncryptedPDFError,
} from 'pdf-lib';
import type { ImportAnalysis } from '../domain/types';

export class ImportRejected extends Error {
  constructor(public code: 'PDF_UNSUPPORTED' | 'PDF_CORRUPT' | 'LIMIT_EXCEEDED', message: string) {
    super(message);
  }
}

export interface FormAnalysis {
  fields: ImportAnalysis['fields'];
  warnings: string[];
  pdfVersion: string | null;
  pageCount: number;
}

function hasKey(dict: PDFDict | undefined, key: string) {
  return !!dict && dict.has(PDFName.of(key));
}

export async function analyzeWithPdfLib(bytes: Uint8Array, maxPages: number): Promise<FormAnalysis> {
  try {
    return await analyze(bytes, maxPages);
  } catch (e) {
    if (e instanceof ImportRejected) throw e;
    throw new ImportRejected('PDF_CORRUPT', 'Die Datei ist beschädigt oder enthält eine nicht unterstützte Struktur.');
  }
}

async function analyze(bytes: Uint8Array, maxPages: number): Promise<FormAnalysis> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypt/i.test(String((e as Error)?.message))) {
      throw new ImportRejected('PDF_UNSUPPORTED', 'Die Datei ist verschlüsselt oder passwortgeschützt. Verschlüsselte PDFs werden in dieser Version nicht unterstützt; das Original bleibt unverändert.');
    }
    throw new ImportRejected('PDF_CORRUPT', 'Die Datei ist beschädigt oder kein gültiges PDF.');
  }
  const pageCount = doc.getPageCount();
  if (pageCount < 1) throw new ImportRejected('PDF_CORRUPT', 'Das PDF enthält keine Seiten.');
  if (pageCount > maxPages) throw new ImportRejected('LIMIT_EXCEEDED', `Das PDF hat ${pageCount} Seiten; unterstützt werden zunächst höchstens ${maxPages}.`);
  const warnings: string[] = [];
  const catalog = doc.catalog;
  const names = catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  if (hasKey(names, 'JavaScript') || hasKey(catalog, 'AA') || catalog.get(PDFName.of('OpenAction'))?.toString().includes('/JavaScript')) {
    warnings.push('Das PDF enthält Skripte. Sie werden nicht ausgeführt.');
  }
  if (hasKey(names, 'EmbeddedFiles')) warnings.push('Eingebettete Dateianhänge werden nicht übernommen und nicht exportiert.');

  const form = doc.getForm();
  if (form.hasXFA()) {
    throw new ImportRejected('PDF_UNSUPPORTED', 'Das Formular verwendet XFA. XFA-Formulare werden in dieser Version nicht unterstützt.');
  }
  const pages = doc.getPages();
  const fields: ImportAnalysis['fields'] = [];
  let unsupported = 0;
  for (const field of form.getFields()) {
    if (field instanceof PDFSignature) {
      throw new ImportRejected('PDF_UNSUPPORTED', 'Das PDF enthält Signaturfelder. Signaturen werden in dieser Version nicht unterstützt.');
    }
    let fieldType: ImportAnalysis['fields'][number]['fieldType'];
    let value: string | boolean | null = null;
    let options: string[] = [];
    let multiline = false;
    let maxLength: number | null = null;
    if (field instanceof PDFTextField) {
      fieldType = 'text';
      value = field.getText() ?? '';
      multiline = field.isMultiline();
      maxLength = field.getMaxLength() ?? null;
    } else if (field instanceof PDFCheckBox) {
      fieldType = 'checkbox';
      value = field.isChecked();
    } else if (field instanceof PDFRadioGroup) {
      fieldType = 'radio';
      options = field.getOptions();
      value = field.getSelected() ?? null;
    } else if (field instanceof PDFDropdown) {
      fieldType = 'dropdown';
      options = field.getOptions();
      value = field.getSelected()[0] ?? null;
      if (value !== null && !options.includes(value)) value = null;
    } else if (field instanceof PDFButton) {
      continue; // Schaltflächen ohne Wert: werden nicht ausgeführt.
    } else if (field instanceof PDFOptionList) {
      unsupported++;
      continue;
    } else {
      unsupported++;
      continue;
    }
    const widgets: ImportAnalysis['fields'][number]['widgets'] = [];
    const ws = field.acroField.getWidgets();
    ws.forEach((w, i) => {
      let pageIndex = -1;
      const pRef = w.P();
      if (pRef) pageIndex = pages.findIndex((p) => p.ref === pRef);
      if (pageIndex < 0) {
        try {
          const pg = (form as unknown as { findWidgetPage(w: unknown): { ref: unknown } }).findWidgetPage(w);
          pageIndex = pages.findIndex((p) => p.ref === pg.ref);
        } catch {
          pageIndex = -1;
        }
      }
      if (pageIndex < 0) return;
      const page = pages[pageIndex];
      const crop = page.getCropBox();
      const r = w.getRectangle();
      const onValue = w.getOnValue()?.decodeText() ?? null;
      widgets.push({
        pageIndex,
        widgetKey: `${field.getName()}#${i}`,
        x: r.x - crop.x,
        y: crop.y + crop.height - (r.y + r.height),
        width: Math.abs(r.width),
        height: Math.abs(r.height),
        onValue: fieldType === 'radio' && onValue && !options.includes(onValue) ? options[i] ?? onValue : onValue,
      });
    });
    if (widgets.length === 0) continue;
    fields.push({ key: field.getName(), fieldType, options, multiline, maxLength, value, widgets });
  }
  if (unsupported) warnings.push(`${unsupported} Formularfeld(er) eines nicht unterstützten Typs bleiben unverändert sichtbar, sind aber nicht bearbeitbar.`);
  if (fields.length) warnings.push('Beim Export werden Formularfelder abgeflacht und sind danach nicht mehr interaktiv.');

  // Exportfähigkeitstest: alle Seiten in ein neues Dokument kopieren und speichern.
  try {
    const probe = await PDFDocument.create();
    const copied = await probe.copyPages(doc, doc.getPageIndices());
    copied.forEach((p) => probe.addPage(p));
    await probe.save({ useObjectStreams: true });
  } catch {
    throw new ImportRejected('PDF_CORRUPT', 'Das PDF kann nicht zuverlässig exportiert werden und wird deshalb nicht importiert.');
  }
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(1024, bytes.length)));
  const version = /%PDF-(\d\.\d)/.exec(header)?.[1] ?? null;
  return { fields, warnings, pdfVersion: version, pageCount };
}
