# Phase 0: Technische Nachweise (Bericht zu Tor G0)

**Stand:** 2026-11-06 · **Umgebung:** Linux x64 (Container), Node 22, Rust 1.97, Chrome (Browser-Vorschau), WebKitGTK 2.52 (echte Tauri-App unter Xvfb). Windows-Zielhardware und WebView2 wurden noch **nicht** getestet.

## Ergebnis je Prüfauftrag

| Prüfauftrag (§11) | Ergebnis | Beleg |
|---|---|---|
| Tauri-Fenster mit lokal gebündeltem PDF.js | bestanden (Linux) | echte App gestartet, Bibliothek angelegt, Editor bedient |
| CropBox-Versatz und alle Rotationen anzeigen und mit Annotation exportieren | bestanden | Golden-Test: 4 PDF-Rotationen × 2 Nutzerdrehungen, Pixelprüfung mit PDF.js |
| Echter Stift mit Druck und Touch-Navigation | **offen** | Druckverarbeitung und Pointer-Cancel implementiert; nur Maus getestet |
| Textlayout mit eingebetteter Schrift, Umlauten, Sonderzeichen | bestanden | Golden-Test (Ä Ö Ü ß ∫ ² ≤ ∑ π extrahierbar), fehlende Glyphen werden gemeldet |
| AcroForm Text, Checkbox, Radio, Dropdown setzen und flatten | bestanden | Golden-Test, Export in UI-Durchlauf |
| Mehrseitige Gruppen, doppelte Seiten mit verschiedenen Werten | bestanden | Golden-Test und Rust-Test |
| 100/500/1.000-Seiten-Korpus, Binärtransport vermessen | **offen** | Limits implementiert; Messung auf Referenzgerät steht aus |
| Abhängigkeiten, Lizenzen, Sicherheitsbefunde erfassen | bestanden | `THIRD_PARTY_NOTICES.md` (19 npm-Pakete, 275 Crates), `npm install`: 0 Schwachstellen gemeldet |

## Befunde
1. **`freezePrototype` bricht fontkit** (nur in der echten App sichtbar, nicht im Browser). Behoben durch Deaktivierung, siehe ADR 0007.
2. **Strenge CSP blockiert den Vite-Entwicklungsserver.** Eigene `devCsp` für den Entwicklungsmodus; Release-CSP unverändert streng.
3. **Widget-Rechtecke** enthalten den Rahmen des Feldes (pdf-lib), Positionen sind korrekt.
4. **Lizenzen:** 5 Crates unter MPL-2.0 (u. a. `cssparser`, `selectors` über Tauri). MPL ist dateibezogen; Weitergabe im Binärpaket mit Lizenzhinweis und Quellverweis ist üblich, aber vor Release rechtlich zu bestätigen.

## Risiken für G0
- **Verschlüsselte Skripte:** Viele Vorlesungs-PDFs haben vermutlich nur ein Owner-Passwort (Druck- oder Kopiersperre). Diese werden derzeit wie gefordert abgelehnt. Empfehlung: Anteil im eigenen Korpus zählen; falls relevant, PDFium für Import und Export prüfen (ADR 0001).
- **Speicher bei großen PDFs:** pdf-lib lädt Quellen vollständig. Für Exporte mit vielen großen Quellen ist das 1,5-GiB-Ziel noch nicht belegt.
- **Stiftlatenz unter WebView2:** Live-Ebene nutzt `desynchronized` und `getCoalescedEvents`; p95 < 35 ms ist nicht gemessen.

## Empfehlung zu G0
Bedingt bestanden: Anzeige, Export, Koordinaten und Formularfälle sind belegt. Vor der Freigabe des Schemas für Endnutzer die drei offenen Punkte (Stifthardware, Korpusmessung, Owner-Passwort-Anteil) auf Windows klären.
