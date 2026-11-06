# ADR 0006: IPC ohne Renderer-Pfade, Binärdaten ohne Base64

**Status:** angenommen · **Datum:** 2026-11-06

## Entscheidung
- Dateipfade kommen nie aus der Oberfläche. Import-, Bild-, Export- und Backup-Dialoge werden im Rust-Kern geöffnet. Für den Export erhält die Oberfläche nur ein kurzlebiges Token (30 Minuten, einmalig verwendbar). Drag-and-drop-Pfade stammen aus dem Fensterereignis des Betriebssystems und werden direkt im Backend gestaged.
- Binärdaten werden als rohe IPC-Antworten (`tauri::ipc::Response`) bzw. rohe Anfragekörper mit Headern (`x-export-id`, `x-target-token`) übertragen, nicht als Base64-JSON.
- Jeder mutierende Dokumentbefehl trägt `requestId` und `expectedRevision`. Wiederholte Anfragen liefern das gespeicherte Ergebnis.
- Die Capability-Datei erlaubt dem Hauptfenster nur die Campus-Befehle sowie Ereignisse und Fenstersteuerung; Dialog-, Dateisystem-, Shell- und HTTP-Plugins sind für die Oberfläche nicht freigegeben. Ein Test prüft, dass fremde Ursprünge abgewiesen werden.

## Offene Messung
Speicher- und Zeitbedarf des Binärtransports für 200-MiB-PDFs auf Zielhardware messen; bei Bedarf auf ein Custom-URI-Protokoll mit Range-Anfragen umstellen.
