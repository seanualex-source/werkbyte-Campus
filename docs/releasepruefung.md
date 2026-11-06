# Releaseprüfung

1. `npm ci`, `npm run typecheck`, `npm test`, `cargo test -p campus-core`, `cargo test --lib` (alle grün)
2. `npm audit` und `cargo audit` ohne offene kritische Befunde
3. `node scripts/third-party.mjs` und Lizenzen prüfen (MPL-2.0-Crates, WebView2-Redistribution, Schrift)
4. Gebündelte SQLite-Version gegen bekannte Integritätsfehler prüfen (`select sqlite_version()`)
5. Windows-Installer aus CI auf sauberer Windows-11-VM ohne Netzwerk installieren (A13)
6. Nutzerreise aus §1 vollständig durchspielen, inklusive Export und Prüfung in zwei externen PDF-Viewern (A06)
7. Backup erstellen, auf frischer Installation wiederherstellen (A11)
8. Update von der Vorversion mit Migration und Vorab-Sicherung; Deinstallation lässt Bibliothek bestehen (A14)
9. Stift auf mindestens einem Zielgerät: Druck, Touch-Navigation, Pointer-Cancel, Latenz messen
10. Leistungsziele aus §10 auf Referenzgerät messen und protokollieren (A15)
11. Installer signieren, `SHA256SUMS.txt` veröffentlichen, Versionsnummer und Buildidentität im Testbericht festhalten
