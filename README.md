# werkbyte Campus

Lokale Windows-App für Studierende: Studienunterlagen in Ordnern organisieren, PDF-Skripte lesen, mit Text, Bildern, Stift und Textmarker ergänzen, Notizseiten einfügen, Formulare ausfüllen und alles als PDF exportieren. Ohne Konto, Cloud oder Internetverbindung.

**Stand:** 0.1.0, Umsetzung des MVP (P0) nach Spezifikation 1.0 vom 6. November 2026.
**Status:** Funktionsfähiger MVP mit automatisierten Tests. Die Abnahme auf Windows-Zielhardware (WebView2, echter Stift, Installer auf sauberer VM) steht noch aus, siehe [Abnahmeprotokoll](docs/abnahmeprotokoll.md).

## Funktionen (P0)

| ID | Funktion | Stand |
|---|---|---|
| F01 | Ordner anlegen, verschieben, umbenennen (32 Ebenen, Zyklenschutz) | umgesetzt |
| F02 | PDF-Import per Dialog und Drag-and-drop, mehrere Dateien, interne Kopie | umgesetzt |
| F03 | Bibliotheksansicht mit Name, Datum, Seitenzahl, Sortierung, Namenssuche | umgesetzt |
| F04 | PDF-Anzeige mit Thumbnails, Zoom, Seitenbreite, Textauswahl | umgesetzt |
| F05 | Notizdokumente und Notizseiten (A4 hoch/quer, weiß/liniert/kariert) | umgesetzt |
| F06 | Textobjekte (mehrzeilig, verschiebbar, Größe, Farbe, Ausrichtung) | umgesetzt |
| F07 | Bilder (PNG/JPEG, EXIF-Ausrichtung normalisiert, proportional skalieren) | umgesetzt |
| F08 | Freihand mit Druckstärke, Maus als Ersatz, Touch bleibt Navigation | umgesetzt, Hardwaretest offen |
| F09 | Textmarker (Multiply) und Radierer für ganze Striche | umgesetzt |
| F10 | Auswahl, Undo/Redo (200 Schritte je Sitzung) | umgesetzt |
| F11 | Seiten verschieben, drehen, duplizieren, löschen (letzte Seite geschützt) | umgesetzt |
| F12 | Dokumente umbenennen, verschieben, duplizieren, zusammenführen | umgesetzt |
| F13 | Seiten als neues Dokument extrahieren | umgesetzt |
| F14 | AcroForm: Text, Checkbox, Radio, Dropdown; mehrseitige Felder gekoppelt | umgesetzt |
| F15 | PDF-Export (ganz oder Auswahl), Formulare abgeflacht, Ergebnis geprüft | umgesetzt |
| F16 | Autosave mit sichtbarem Status, Revisionsprüfung, Wiederholung | umgesetzt |
| F17 | Papierkorb für Ordner und Dokumente, endgültiges Löschen mit Bestätigung | umgesetzt |
| F18 | Backup manuell und automatisch, Prüfung, Wiederherstellung | umgesetzt |
| F19 | Windows-Installer (NSIS und MSI, WebView2 offline) über CI | konfiguriert, Build auf Windows-Runner |

## Schnellstart unter Windows

Voraussetzungen: Windows 10/11 x64, [Node.js 22](https://nodejs.org), [Rust stable](https://rustup.rs) mit MSVC-Toolchain, „Visual Studio Build Tools“ mit „Desktopentwicklung mit C++“. WebView2 ist unter Windows 11 vorinstalliert.

```powershell
npm ci
npm run app:dev      # Entwicklungsmodus mit Hot Reload
npm run app:build    # Release: Installer unter src-tauri\target\release\bundle\
```

Ohne eigene Windows-Entwicklungsumgebung: Repository auf GitHub hochladen. Der Workflow `.github/workflows/build.yml` führt alle Tests aus und baut die Installer auf einem Windows-Runner. Das Ergebnis liegt als Artefakt `werkbyte-campus-windows` am Workflow-Lauf (inklusive `SHA256SUMS.txt`).

Browser-Vorschau ohne Rust (mit In-Memory-Testbackend, nichts wird gespeichert):

```bash
npm ci
npm run dev          # http://localhost:1420
```

## Tests

```bash
npm test                                   # Geometrie, Textlayout, Undo/Redo, Autosave, PDF-Golden-Tests
npm run typecheck
cd src-tauri && cargo test -p campus-core  # Kern gegen echte SQLite-Dateien
cd src-tauri && cargo test --lib           # IPC-Vertrag über die Tauri-Mock-Runtime inkl. Berechtigungen
```

Die PDF-Golden-Tests exportieren mit pdf-lib und prüfen das Ergebnis unabhängig mit PDF.js: Pixelpositionen bei allen vier PDF-Rotationen kombiniert mit Nutzerdrehung und CropBox-Versatz, Formularwerte getrennter Kopien, Umlaute und mathematische Zeichen, Textmarker, Bilder, Seitenauswahl. Gerenderte Ergebnisse landen in `tests/output/`.

## Architektur in Kürze

```
src/                    React + TypeScript (Oberfläche, Editor, Rendering, Export-Worker)
  domain/               Dokumentmodell, Befehle mit Inversem, Autosave-Warteschlange
  rendering/            Koordinatenvertrag, Textlayout, Stiftgeometrie, Primitive
  pdf/                  PDF.js-Adapter, Importanalyse, Exportkomposition (pdf-lib, im Worker)
  features/             Bibliothek, Editor, Backup
  ipc/                  Typisierte Befehle; In-Memory-Double für Browser und UI-Tests
src-tauri/
  campus-core/          Fachlogik, SQLite, Objektspeicher, Backup (ohne Tauri, separat testbar)
  src/commands/         Schmale IPC-Grenze, native Dialoge, Drag-and-drop
  migrations/           Nummerierte SQL-Migrationen
  capabilities/         Minimale Rechte des Hauptfensters
docs/                   ADRs, Datenformat, Bedrohungsmodell, Phase-0-Bericht, Abnahme, Bedienhilfe
```

Leitregeln aus §16 der Spezifikation sind umgesetzt: Originale werden nie überschrieben, kein PDF wird nach Strichen neu erzeugt, die Oberfläche hat keinen Datei- oder SQL-Zugriff, „Gespeichert“ erscheint erst nach bestätigtem Commit, Fehlerpfade sind reguläre Abläufe.

## Abweichungen und bewusste Entscheidungen

- **Bibliotheksverzeichnis:** `%LOCALAPPDATA%\werkbyte\Campus\Libraries\<uuid>`. Die UUID des Ordners wird vor dem Anlegen vergeben und ist nicht identisch mit der internen Bibliotheks-ID.
- **Prototype-Freezing deaktiviert:** Tauris Option `freezePrototype` bricht fontkit (Schrifteinbettung) beim Laden ab. Begründung und Ausgleich in [ADR 0007](docs/adr/0007-freeze-prototype.md).
- **Verschlüsselte PDFs** werden gemäß Spezifikation abgelehnt, auch solche mit reinem Owner-Passwort. Das betrifft vermutlich einen Teil echter Skripte; Messung und Optionen im [Phase-0-Bericht](docs/phase0-bericht.md).
- **Texteditor:** Während der Eingabe bricht das Textfeld des Browsers um; nach dem Speichern gilt der gemeinsame Layoutdienst, den auch der Export nutzt. Kleine Abweichungen beim Umbruch sind während der Eingabe möglich.
- **Sprache:** Oberfläche nur Deutsch.

## Lizenz und Drittanbieter

Eigener Code: Lizenz noch festzulegen (`UNLICENSED`). Drittanbieter-Inventar: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), erzeugt mit `node scripts/third-party.mjs`. Vor einer Veröffentlichung Name „werkbyte Campus“, Logo und mögliche Kennzeichenrechte prüfen.
