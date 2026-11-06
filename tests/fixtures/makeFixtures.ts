// Erzeugt eigene, rechtlich unbedenkliche Testdateien für das Referenzkorpus (§8.3).

import { PDFDocument, StandardFonts, degrees, rgb, PDFName, PDFNumber } from 'pdf-lib';

/** Formular mit Text (zwei Widgets auf zwei Seiten), Checkbox, Radio-Gruppe und Dropdown. */
export async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  const p2 = doc.addPage([595, 842]);
  p1.drawText('Anmeldeformular Seite 1', { x: 50, y: 790, size: 18, font });
  p2.drawText('Seite 2 (Name wiederholt)', { x: 50, y: 790, size: 18, font });
  const form = doc.getForm();
  const name = form.createTextField('person.name');
  name.addToPage(p1, { x: 50, y: 700, width: 250, height: 24 });
  name.addToPage(p2, { x: 50, y: 650, width: 250, height: 24 });
  const ok = form.createCheckBox('agree');
  ok.addToPage(p1, { x: 50, y: 640, width: 16, height: 16 });
  const radio = form.createRadioGroup('studiengang');
  radio.addOptionToPage('Informatik', p1, { x: 50, y: 590, width: 16, height: 16 });
  radio.addOptionToPage('Mathematik', p1, { x: 150, y: 590, width: 16, height: 16 });
  const dd = form.createDropdown('semester');
  dd.addOptions(['1', '2', '3']);
  dd.addToPage(p1, { x: 50, y: 530, width: 100, height: 24 });
  return doc.save();
}

/** Vier Seiten mit /Rotate 0/90/180/270, MediaBox [0 0 600 800], CropBox [50 60 550 760]. */
export async function makeRotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const r of [0, 90, 180, 270]) {
    const p = doc.addPage([600, 800]);
    p.setCropBox(50, 60, 500, 700);
    p.drawRectangle({ x: 50, y: 60, width: 500, height: 700, borderColor: rgb(0, 0, 0), borderWidth: 2 });
    p.drawText(`Rotation ${r}`, { x: 120, y: 400, size: 30, font });
    p.setRotation(degrees(r));
  }
  return doc.save();
}

/** Seite mit UserUnit 2 (sichtbare Größe doppelt). */
export async function makeUserUnitPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 400]);
  p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  p.drawRectangle({ x: 0, y: 0, width: 300, height: 400, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  return doc.save();
}
