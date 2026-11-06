# ADR 0003: Formulargruppen als unabhängiger Wertekontext

**Status:** angenommen · **Datum:** 2026-11-06

## Entscheidung
Feldwerte gehören zu einer Formulargruppe (`form_groups`), nicht zur Seite. Widgets (`form_widgets`) koppeln eine sichtbare Feldinstanz auf einer Seite an einen Feldschlüssel einer Gruppe. Feldeigenschaften (Typ, Optionen, Mehrzeiligkeit, Maximallänge) liegen je Quelle in `pdf_source_fields`.

- Import: eine Gruppe je importiertem Dokument; mehrseitige Felder teilen den Wert.
- Seite duplizieren: neue Gruppe mit kopierten Werten (Befehl `createFormGroup`, idempotent für Redo).
- Dokument kopieren, extrahieren, zusammenführen: je Quelldokumentinstanz (Teilindex) einmal kopiert; gemeinsam kopierte Seiten bleiben gekoppelt.
- Export: je Gruppe eine eigene temporäre Kopie der Quelle, Werte setzen, Erscheinungsbilder mit der eingebetteten Schrift erzeugen, alle Felder abflachen, dann Seiten kopieren. Seiten ohne Widgets stammen aus einer abgeflachten Basiskopie, damit keine verwaisten interaktiven Widgets im Ergebnis landen.

## Nachweis
Rust-Test `compose_copies_are_independent_including_forms`, TypeScript-Test zur Seitenduplikation, Golden-Test mit zwei Kopien derselben Formularseite und unterschiedlichen Werten.
