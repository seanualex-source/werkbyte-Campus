# Festgelegte Versionen

Gesperrt durch `package-lock.json` und `src-tauri/Cargo.lock`. Vor jedem Release Sicherheitsmeldungen prüfen (`npm audit`, `cargo audit`) und `node scripts/third-party.mjs` erneut ausführen.

| Komponente | Version | Zweck |
|---|---|---|
| Tauri (Rust) | 2.x laut Cargo.lock | Desktop-Hülle, IPC, Capabilities |
| @tauri-apps/api, @tauri-apps/cli | 2.12.4 | Frontend-IPC, Build |
| tauri-plugin-dialog | 2.x | Native Dateidialoge (nur aus Rust genutzt) |
| tauri-plugin-single-instance | 2.x | Zweiter Start fokussiert die laufende Instanz |
| rusqlite (SQLite gebündelt) | 0.41 | Datenbank, Online-Backup-API |
| zip | 9.x (nur deflate) | Backup-Archive |
| image | 0.25 (png, jpeg) | Bildprüfung, EXIF-Ausrichtung |
| React | 19.3.1 | Oberfläche |
| Vite | 8.3.6 | Build |
| TypeScript | 7.0.2 | Typprüfung |
| pdfjs-dist | 6.5.438 | Anzeige, Textebene |
| pdf-lib | 1.17.1 | Export, Formular-Flattening |
| @pdf-lib/fontkit | 1.1.1 | Schrifteinbettung und Metriken |
| perfect-freehand | 1.2.3 | Stiftgeometrie (Glättungsversion 1) |
| zustand | 5.0.16 | Zustandsverwaltung |
| DejaVu Sans | 2.37 | Gebündelte Schrift |
| Vitest | 5.1.0 | Tests |
