# ADR 0005: Backupformat `.campus-backup`

**Status:** angenommen · **Datum:** 2026-11-06

## Entscheidung
ZIP64-Archiv mit `campus.sqlite` (konsistenter Snapshot über die SQLite-Online-Backup-API, Journalmodus DELETE), `library.json`, allen in der Snapshot-Datenbank bekannten Objekten (`objects/ab/<sha256>.<ext>`, unkomprimiert) und `manifest.json` (Formatversion, Bibliotheks-ID, App- und Schemaversion, Art, Dateiliste mit Größe und SHA-256).

Ablauf: Snapshot unter Writer-Sperre, Objekte gegen Bereinigung pinnen, Sperre freigeben, Archiv als temporäre Datei schreiben, vollständig prüfen (Pfade, Größen, Prüfsummen, Kompressionsverhältnis, SQLite-Integrität und Fremdschlüssel, jede Datenbankreferenz vorhanden), erst dann umbenennen und Erfolg melden.

Wiederherstellung immer in ein neues Verzeichnis; nur Pfade nach strengem Muster sind zulässig (keine Traversal-, absoluten oder Linkeinträge). Aufbewahrung: 7 tägliche und 4 wöchentliche automatische Sicherungen; manuelle und Migrationssicherungen werden nie automatisch gelöscht; gelöscht werden nur Dateien mit lesbarem Campus-Manifest.

## Bekannte Grenze
Jede Sicherung ist eine Vollkopie. Bei großen Bibliotheken wächst der Platzbedarf entsprechend. Ein inkrementelles Format (gemeinsamer Objektordner am Ziel) ist als P1 vorgemerkt.
