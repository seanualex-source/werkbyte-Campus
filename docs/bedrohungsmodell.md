# Bedrohungsmodell (MVP)

**Schutzziele:** Vertraulichkeit und Integrität der Unterlagen, keine stillen Datenverluste, Begrenzung des Dateizugriffs auf Bibliothek und ausdrücklich gewählte Dateien.
**Außerhalb:** ein bereits kompromittiertes Windows-Benutzerkonto, physischer Zugriff, Schutz der Bibliothek durch Verschlüsselung (nicht vorhanden, wird nicht behauptet).

| Eingang | Risiko | Maßnahme | Nachweis |
|---|---|---|---|
| Fremde PDFs | Parserfehler, Ressourcenerschöpfung, Skripte | Analyse nur der Staging-Kopie; Limits (200 MiB, 1.000 Seiten); PDF-JavaScript, Launch-Aktionen, Anhänge und Formularübermittlung werden nicht ausgeführt; XFA, Signaturfelder und Verschlüsselung abgelehnt; Exportfähigkeitstest vor dem Import | `tests/export.test.ts` (defekt, Seitenlimit), `rejects_non_pdf_and_oversize` |
| Bilder | Riesige Abmessungen, falsche Typen | Nur PNG/JPEG nach Magic Bytes, 25 MiB, 40 Megapixel vor dem Dekodieren geprüft; kein SVG | `image_import_limits_and_png` |
| Backup-Archive | Pfadtraversal, Zip-Bomben, Manipulation | Strenges Pfadmuster, keine Links/Verzeichnisse, Größen- und Verhältnisgrenzen, SHA-256 je Datei, SQLite-Integrität, Restore nur in neues Verzeichnis | `archive_path_rules`, `backup_roundtrip_and_tamper_detection` |
| Dokument- und Ordnernamen | Pfadmissbrauch, HTML-Injektion | Namen sind nie Speicherpfade; Steuerzeichen entfernt; Darstellung nur als Text (React escaping) | `folders_nesting_cycles_and_depth` |
| Renderer (WebView) | Zugriff auf beliebige Pfade | Keine Pfade aus der Oberfläche; native Dialoge im Backend; Export nur über Einmal-Token; Capability erlaubt nur Campus-Befehle, fremde Ursprünge werden abgewiesen | `foreign_origin_is_rejected_by_capabilities`, `import_staging_blob_and_export_binary_roundtrip` |
| Netzwerk | Datenabfluss, nachgeladener Code | Keine Telemetrie, kein Konto, keine CDN-Skripte oder Remote-Fonts; CSP erlaubt nur `self`, IPC und `blob:`/`data:` für lokale Bilder | `tauri.conf.json` |
| Gleichzeitiger Zugriff | Beschädigte Bibliothek | Ein Writer je Bibliothek (OS-Lock), Single-Instance-Plugin, WAL nur lokal | `library_create_reopen_and_exclusive_lock` |
| Abbrüche | Halbfertige Zustände | Datei vor Datenbank veröffentlichen; Staging-Bereinigung beim Start; verzögerte Bereinigung mit Frist und Pins | `crash_between_publish_and_commit_leaves_no_dangling_reference`, E2E `kill -9` |
| Interne Dateien manipuliert | Falsche Darstellung | Länge und SHA-256 bei jedem Lesen geprüft; expliziter Reparaturhinweis | `tampered_object_is_reported_not_returned` |

**Bekannte Abweichung:** `freezePrototype` ist deaktiviert (ADR 0007).

**Logs:** Die App schreibt derzeit keine Inhaltsprotokolle. Fehlermeldungen in der Oberfläche enthalten keine PDF-Texte oder Formularwerte.

**Updates:** Installer müssen vor Veröffentlichung signiert werden (Zertifikat noch zu beschaffen). Migrationen erzeugen vorher eine Sicherung.
