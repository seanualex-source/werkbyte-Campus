# Abnahmeprotokoll MVP (A01 bis A16)

Legende: **automatisiert** = durch Test belegt · **manuell** = im UI-Durchlauf geprüft · **offen** = erfordert Windows-Zielumgebung oder Messung.

| ID | Kriterium | Status | Beleg |
|---|---|---|---|
| A01 | Ordner und Unterordner nach Neustart vorhanden und sortiert | automatisiert | `library_create_reopen_and_exclusive_lock`, `folders_nesting_cycles_and_depth` |
| A02 | PDF importieren, externe Quelle löschen, Dokument bleibt lesbar | automatisiert | `import_survives_external_deletion_and_deduplicates`, IPC-Test |
| A03 | Text, Bild, Strich auf PDF- und Notizseite nach Neustart einzeln bearbeitbar | automatisiert + manuell | Rust-Mutationstests, echte App nach `kill -9` |
| A04 | Seite verschieben, drehen, duplizieren: Objekte korrekt, Kopie unabhängig | automatisiert | Rust- und TS-Tests, Golden-Test Rotation |
| A05 | Zusammenführen mit gleichen Quellseiten: Reihenfolge, Formulare unabhängig | automatisiert | `compose_copies_are_independent_including_forms` |
| A06 | Formulare ausfüllen und exportieren, Werte in externen Viewern sichtbar, abgeflacht | automatisiert (PDF.js) / **offen** (zweiter externer Viewer) | Golden-Test |
| A07 | Seitenauswahl exportieren | automatisiert | Golden-Test „Seitenauswahl“ |
| A08 | Nach bestätigtem Speichern hart beenden, letzte Revision vorhanden | manuell (echte App, Linux) | E2E mit `kill -9` |
| A09 | Voller Datenträger: kein falscher Erfolgsstatus, letzte Revision intakt | automatisiert (Logik) / **offen** (echter voller Datenträger) | SaveQueue-Tests, atomare Transaktionen |
| A10 | Ordner in Papierkorb und zurück, ganzer Teilbaum | automatisiert | `folders_nesting_cycles_and_depth`, `trash_restore_to_recovery_folder_and_purge` |
| A11 | Backup auf frischer Installation einspielen | automatisiert (Kern) / **offen** (Windows-VM) | `backup_roundtrip_and_tamper_detection` |
| A12 | Manipuliertes Backup oder nicht unterstütztes PDF verständlich abgelehnt | automatisiert | Manipulationstest, Importklassifikation |
| A13 | Installierte App ohne Netzwerk | **offen** | CSP ohne Netzwerkziele, WebView2 offline eingebettet |
| A14 | Update und Deinstallation ohne Bibliotheksverlust | **offen** | Bibliothek liegt außerhalb des Installationsordners; Migrationsrahmen mit Vorab-Sicherung vorhanden |
| A15 | Leistungsziele (§10) | **offen** | Messung auf Referenzgerät |
| A16 | 100 Undo/Redo-Aktionen konsistent, keine doppelten IDs | automatisiert | TS-Test „100 Aktionen …“ |

## Testlauf vom 2026-11-06
- `cargo test -p campus-core`: 14 bestanden
- `cargo test --lib` (IPC-Vertrag): 4 bestanden
- `npm test`: 22 bestanden
- `npm run typecheck`: ohne Fehler
- UI-Durchläufe (Chrome, In-Memory-Backend): Import, Formular, Stift, Textmarker, Text, Notizseite, Export, Radierer, Undo, Seiten-Drag, Papierkorb, Sicherungsdialog
- Echte App (WebKitGTK, Linux): Start, Bibliothek, Notizdokument, Stift, Textmarker, harter Abbruch, Wiederöffnen
