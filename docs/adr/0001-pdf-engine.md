# ADR 0001: PDF.js für die Anzeige, pdf-lib für den Export, Engine hinter Adaptern

**Status:** angenommen für den MVP, mit Prüfauftrag · **Datum:** 2026-11-06

## Kontext
Die Spezifikation sieht PDF.js (Anzeige) und pdf-lib (Export) vor und verlangt einen Nachweis in Phase 0. Bekannte Risiken: zwei Engines (Anzeige und Export) können unterschiedlich darstellen, pdf-lib kann keine verschlüsselten Dateien verarbeiten und lädt Dokumente vollständig in den Speicher. Unsicher: Der Pflegezustand von pdf-lib wurde nicht aktuell geprüft; das letzte Release 1.17.1 stammt nach meinem Wissen aus 2021.

## Entscheidung
- Anzeige: `pdfjs-dist` 6.5.438 mit lokal gebündeltem Worker, CMaps, Standardschriften, WASM-Decodern und ICC-Profilen. Formularfelder werden im Editor nicht von PDF.js gezeichnet (`annotationMode` ENABLE_FORMS), sondern als eigene Eingabeelemente.
- Export: `pdf-lib` 1.17.1 mit `@pdf-lib/fontkit` im Web Worker. Eigene Objekte werden als Inhaltsoperatoren geschrieben (kein `drawText` mit y-Flip-Heuristik), Formulare werden je Formulargruppe in einer eigenen temporären Quellkopie befüllt und abgeflacht.
- Beide Engines liegen hinter schmalen Adaptern (`src/pdf/pdfjs.ts`, `src/pdf/composeExport.ts`, `src/pdf/analyzeForms.ts`). Ein Wechsel betrifft keine Datenhaltung.

## Nachweis
Automatisierte Golden-Tests rendern jeden Export unabhängig mit PDF.js und prüfen Pixelpositionen bei allen Rotationen, CropBox-Versatz und UserUnit sowie Formularwerte doppelter Seiten.

## Offene Prüfung
PDFium (`pdfium-render` im Rust-Kern, BSD-artige Lizenz) als Alternative für Export und Formular-Flattening gegen dasselbe Korpus testen, insbesondere für PDFs mit reinem Owner-Passwort und für große Dateien. Wechsel nur mit eigener ADR und Lizenzprüfung.
