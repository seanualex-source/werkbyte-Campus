# Datenformat der Bibliothek (Format 1, Schema 1)

## Verzeichnis
```
<library-root>/
  library.json        Identität: libraryId, formatVersion, app, createdAt
  campus.sqlite       Verbindlicher Datenbestand (WAL, synchronous=FULL, foreign_keys=ON)
  campus.sqlite-wal   SQLite-Laufzeitdatei
  campus.sqlite-shm   SQLite-Laufzeitdatei
  objects/ab/<sha256>.pdf|png|jpg   Unveränderliche Originale und Bilder
  staging/            Noch nicht veröffentlichte Dateien; wird beim Öffnen geleert
  cache/thumbnails/   Rekonstruierbar, nicht im Backup
  logs/               Diagnose (derzeit leer; keine Inhalte)
  library.lock        Exklusiver Schreib-Lock (vom Betriebssystem beim Prozessende freigegeben)
```
App-Konfiguration: `%LOCALAPPDATA%\werkbyte\Campus\config.json` mit dem Pfad der aktiven Bibliothek.

## Tabellen
Siehe `src-tauri/migrations/001_initial.sql`. Ergänzungen gegenüber §5.2 der Spezifikation:

| Tabelle/Spalte | Zweck |
|---|---|
| `settings` | Bibliotheksbezogene Einstellungen, z. B. `backupTarget` |
| `pdf_source_pages` | Quellseiten-Descriptor: CropBox-Ursprung, Größe inkl. UserUnit, ursprüngliche Rotation |
| `pdf_source_fields` | Felddefinitionen je Quelle (Typ, Optionen, mehrzeilig, Maximallänge) |
| `folders.orphaned`, `documents.orphaned` | Merkt, dass der Elternordner endgültig gelöscht wurde; Wiederherstellung nutzt dann „Wiederhergestellt“ |
| `documents.last_opened_at` | „Zuletzt geöffnet“ |
| `blobs.unreferenced_since` | Beginn der 7-tägigen Sicherheitsfrist vor dem Löschen |
| `backup_runs.kind`, `file_name`, `message` | Art und Ergebnis von Sicherungen |

## Annotation-Payloads (Version 1)
Koordinaten im nativen Seitenraum (siehe ADR 0002). Unbekannte Felder werden abgelehnt.

```jsonc
// text
{ "x": 42, "y": 70, "width": 240, "height": 72, "text": "…", "fontAssetId": "bundled-font-regular-v1",
  "fontSize": 12, "lineHeight": 1.3, "color": "#17212B", "align": "left", "orient": 0 }
// image
{ "blobHash": "<sha256>", "x": 0, "y": 0, "width": 100, "height": 80, "opacity": 1, "orient": 0 }
// ink | highlight
{ "points": [{ "x": 1, "y": 2, "pressure": 0.5 }], "baseWidth": 2.2, "color": "#1F4E8C", "opacity": 1, "smoothingVersion": 1 }
```
Notizhintergrund: `{ "type": "blank|ruled|grid", "spacingPt": 22, "color": "#B9C3CE", "lineWidthPt": 0.5 }`.

`smoothingVersion 1` legt die Parameter von perfect-freehand fest (`src/rendering/stroke.ts`). Eine Änderung der Parameter erfordert eine neue Version, damit bestehende Striche unverändert dargestellt werden.

## Formularwerte
`text` → Zeichenkette, `checkbox` → boolesch, `radio`/`dropdown` → Option oder `null`. Widgets: `{ "x", "y", "width", "height", "onValue" }` im nativen Seitenraum.

## Mutationen (IPC)
`document_apply({ mutation: { requestId, documentId, expectedRevision, payload: Op[] } })`. Ops: `addPage`, `deletePage`, `movePage`, `rotatePage`, `setBackground`, `upsertAnnotation`, `deleteAnnotation`, `createFormGroup`, `setFormValue`, `rename`. Alle Ops einer Mutation werden in einer Transaktion angewendet und erhöhen die Revision um genau 1.

## Fehlercodes
`REVISION_CONFLICT`, `DISK_FULL`, `ACCESS_DENIED`, `FILE_MISSING`, `PDF_UNSUPPORTED`, `PDF_CORRUPT`, `LIMIT_EXCEEDED`, `BACKUP_INVALID`, `SCHEMA_TOO_NEW`, `CANCELLED`, ergänzt um `INVALID`, `NOT_FOUND`, `LIBRARY_LOCKED`, `INTERNAL` und frontendseitig `GLYPH_MISSING`. Fehlerobjekt: `{ code, message, retryable }`.
