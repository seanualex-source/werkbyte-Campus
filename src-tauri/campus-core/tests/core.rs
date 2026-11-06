//! Integrationstests des Kerns gegen echte, temporäre SQLite-Bibliotheken.

use campus_core::apply::apply;
use campus_core::backup;
use campus_core::compose::compose;
use campus_core::documents::{self, ListFilter};
use campus_core::error::ErrorCode;
use campus_core::folders;
use campus_core::gc;
use campus_core::importer::{self, AnalysisField, AnalysisPage, AnalysisWidget, ImportAnalysis};
use campus_core::library::Library;
use campus_core::model::*;
use campus_core::objects::{self, BlobKind};
use campus_core::trash;
use campus_core::util::new_id;
use serde_json::json;
use std::collections::HashSet;
use std::path::Path;

fn open(root: &Path) -> Library {
    Library::open(root, None).expect("Bibliothek öffnen").0
}

fn fake_pdf(dir: &Path, name: &str, salt: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, format!("%PDF-1.7\n% Testdatei {salt}\n%%EOF\n")).unwrap();
    p
}

fn analysis(title: &str, pages: usize, with_form: bool) -> ImportAnalysis {
    ImportAnalysis {
        title: title.into(),
        folder_id: None,
        page_count: pages as i64,
        pages: (0..pages)
            .map(|i| AnalysisPage {
                index: i as i64,
                crop_x: 0.0,
                crop_y: 0.0,
                width_pt: 595.0,
                height_pt: 842.0,
                intrinsic_rotation: 0,
                user_unit: 1.0,
            })
            .collect(),
        fields: if with_form {
            vec![
                AnalysisField {
                    key: "name".into(),
                    field_type: "text".into(),
                    options: vec![],
                    multiline: false,
                    max_length: None,
                    value: json!(""),
                    widgets: vec![
                        AnalysisWidget { page_index: 0, widget_key: "name#0".into(), x: 50.0, y: 50.0, width: 200.0, height: 20.0, on_value: None },
                        AnalysisWidget { page_index: 1.min(pages as i64 - 1), widget_key: "name#1".into(), x: 50.0, y: 80.0, width: 200.0, height: 20.0, on_value: None },
                    ],
                },
                AnalysisField {
                    key: "ok".into(),
                    field_type: "checkbox".into(),
                    options: vec![],
                    multiline: false,
                    max_length: None,
                    value: json!(false),
                    widgets: vec![AnalysisWidget { page_index: 0, widget_key: "ok#0".into(), x: 10.0, y: 10.0, width: 12.0, height: 12.0, on_value: Some("Yes".into()) }],
                },
            ]
        } else {
            vec![]
        },
        warnings: vec![],
        pdf_version: Some("1.7".into()),
    }
}

fn import(lib: &mut Library, src: &Path, a: &ImportAnalysis) -> String {
    let staged = objects::stage_from_path(&lib.root, src, &[BlobKind::Pdf], 1 << 30, &|| false).unwrap();
    importer::commit(&mut lib.conn, &lib.root.clone(), &staged, a).unwrap()
}

fn mutation(doc: &str, rev: i64, ops: Vec<Op>) -> Mutation {
    Mutation { request_id: new_id(), document_id: doc.into(), expected_revision: rev, payload: ops }
}

fn text_ann(page: &str, text: &str) -> AnnotationRec {
    AnnotationRec {
        id: new_id(),
        page_id: page.into(),
        kind: "text".into(),
        z_index: 1,
        payload_version: 1,
        payload: json!({"x": 42, "y": 70, "width": 240, "height": 72, "text": text, "fontAssetId": "bundled-font-regular-v1",
            "fontSize": 12, "lineHeight": 1.3, "color": "#17212B", "align": "left"}),
    }
}

fn ink_ann(page: &str) -> AnnotationRec {
    AnnotationRec {
        id: new_id(),
        page_id: page.into(),
        kind: "ink".into(),
        z_index: 2,
        payload_version: 1,
        payload: json!({"points": [{"x": 1, "y": 2, "pressure": 0.5}, {"x": 10, "y": 20, "pressure": 0.7}],
            "baseWidth": 2.0, "color": "#1F4E8C", "opacity": 1.0, "smoothingVersion": 1}),
    }
}

fn note_bundle() -> PageBundle {
    PageBundle {
        id: new_id(),
        kind: "note".into(),
        source_id: None,
        source_page_index: None,
        width_pt: 595.0,
        height_pt: 842.0,
        rotation: 0,
        background: Some(json!({"type": "grid", "spacingPt": 14.17, "color": "#B9C3CE", "lineWidthPt": 0.5})),
        annotations: vec![],
        widgets: vec![],
    }
}

#[test]
fn library_create_reopen_and_exclusive_lock() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    let (lib, info) = Library::open(&root, None).unwrap();
    assert_eq!(info.schema_version, 1);
    assert_eq!(info.migrated, vec![1]);
    // Zweiter Schreiber wird abgewiesen.
    match Library::open(&root, None) {
        Err(e) => assert_eq!(e.code, ErrorCode::LibraryLocked),
        Ok(_) => panic!("zweiter Writer darf nicht öffnen"),
    }
    let id = lib.id.clone();
    drop(lib);
    let (lib2, info2) = Library::open(&root, None).unwrap();
    assert_eq!(lib2.id, id);
    assert!(info2.migrated.is_empty());
}

#[test]
fn folders_nesting_cycles_and_depth() {
    let dir = tempfile::tempdir().unwrap();
    let mut lib = open(dir.path());
    let a = folders::create(&lib.conn, None, "Semester 1").unwrap();
    let b = folders::create(&lib.conn, Some(&a.id), "Mathematik").unwrap();
    let c = folders::create(&lib.conn, Some(&b.id), "Übungen").unwrap();
    // Zyklus verhindern
    let err = folders::move_to(&lib.conn, &a.id, Some(&c.id)).unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    let err = folders::move_to(&lib.conn, &a.id, Some(&a.id)).unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    // Tiefe 32
    let mut parent = c.id.clone();
    for i in 3..32 {
        parent = folders::create(&lib.conn, Some(&parent), &format!("Ebene {i}")).unwrap().id;
    }
    let err = folders::create(&lib.conn, Some(&parent), "zu tief").unwrap_err();
    assert_eq!(err.code, ErrorCode::LimitExceeded);
    // Leere Namen und Steuerzeichen
    assert!(folders::create(&lib.conn, None, "   ").is_err());
    let f = folders::create(&lib.conn, None, "A\u{0007}B").unwrap();
    assert_eq!(f.name, "AB");
    // Papierkorb mit Teilbaum
    let batch = folders::trash(&mut lib.conn, &a.id).unwrap();
    assert!(folders::list(&lib.conn).unwrap().iter().all(|x| x.id != c.id));
    trash::restore(&mut lib.conn, &batch).unwrap();
    assert!(folders::list(&lib.conn).unwrap().iter().any(|x| x.id == c.id));
}

#[test]
fn import_survives_external_deletion_and_deduplicates() {
    let dir = tempfile::tempdir().unwrap();
    let mut lib = open(&dir.path().join("lib"));
    let src = fake_pdf(dir.path(), "skript.pdf", "a");
    let d1 = import(&mut lib, &src, &analysis("Skript", 3, false));
    let src2 = fake_pdf(dir.path(), "skript-kopie.pdf", "a");
    let d2 = import(&mut lib, &src2, &analysis("Skript", 3, false));
    std::fs::remove_file(&src).unwrap();
    std::fs::remove_file(&src2).unwrap();
    let s1 = documents::load(&lib.conn, &d1).unwrap();
    let s2 = documents::load(&lib.conn, &d2).unwrap();
    assert_eq!(s1.pages.len(), 3);
    assert_eq!(s1.sources[0].blob_hash, s2.sources[0].blob_hash, "gleicher Inhalt wird dedupliziert");
    assert_eq!(s2.document.title, "Skript (2)", "gleiche Namen erhalten eine sichtbare Nummer");
    let (bytes, kind) = objects::read_blob(&lib.conn, &lib.root, &s1.sources[0].blob_hash).unwrap();
    assert_eq!(kind, BlobKind::Pdf);
    assert!(bytes.starts_with(b"%PDF-"));
    let blobs: i64 = lib.conn.query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0)).unwrap();
    assert_eq!(blobs, 1);
    // Staging ist nach dem Import leer.
    assert_eq!(std::fs::read_dir(lib.root.join("staging")).unwrap().count(), 0);
}

#[test]
fn rejects_non_pdf_and_oversize() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(&dir.path().join("lib"));
    let p = dir.path().join("x.pdf");
    std::fs::write(&p, b"kein pdf").unwrap();
    let err = objects::stage_from_path(&lib.root, &p, &[BlobKind::Pdf], 1 << 20, &|| false).unwrap_err();
    assert_eq!(err.code, ErrorCode::PdfUnsupported);
    let big = fake_pdf(dir.path(), "big.pdf", &"x".repeat(2000));
    let err = objects::stage_from_path(&lib.root, &big, &[BlobKind::Pdf], 100, &|| false).unwrap_err();
    assert_eq!(err.code, ErrorCode::LimitExceeded);
    assert_eq!(std::fs::read_dir(lib.root.join("staging")).unwrap().count(), 0);
}

#[test]
fn tampered_object_is_reported_not_returned() {
    let dir = tempfile::tempdir().unwrap();
    let mut lib = open(&dir.path().join("lib"));
    let src = fake_pdf(dir.path(), "a.pdf", "tamper");
    let d = import(&mut lib, &src, &analysis("A", 1, false));
    let snap = documents::load(&lib.conn, &d).unwrap();
    let hash = &snap.sources[0].blob_hash;
    let rel = objects::object_rel_path(hash, BlobKind::Pdf);
    std::fs::write(lib.root.join(&rel), b"%PDF-1.7 manipuliert").unwrap();
    let err = objects::read_blob(&lib.conn, &lib.root, hash).unwrap_err();
    assert_eq!(err.code, ErrorCode::PdfCorrupt);
    std::fs::remove_file(lib.root.join(&rel)).unwrap();
    let err = objects::read_blob(&lib.conn, &lib.root, hash).unwrap_err();
    assert_eq!(err.code, ErrorCode::FileMissing);
}

#[test]
fn mutations_revision_idempotency_and_page_rules() {
    let dir = tempfile::tempdir().unwrap();
    let mut lib = open(dir.path());
    let doc = documents::create_note(
        &mut lib.conn,
        None,
        "Mitschrift",
        &NotePaper { orientation: "portrait".into(), background: documents::default_background("ruled") },
    )
    .unwrap();
    let snap = documents::load(&lib.conn, &doc).unwrap();
    let p0 = snap.pages[0].id.clone();
    // Letzte Seite nicht löschbar
    let err = apply(&mut lib.conn, &mutation(&doc, 0, vec![Op::DeletePage { page_id: p0.clone() }])).unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    // Seite einfügen + Annotationen
    let nb = note_bundle();
    let p1 = nb.id.clone();
    let t = text_ann(&p0, "Definition und eigene Anmerkung: ÄÖÜ ∫ x² dx");
    let m = mutation(&doc, 0, vec![Op::AddPage { page: nb, position: 0 }, Op::UpsertAnnotation { annotation: t.clone() }, Op::UpsertAnnotation { annotation: ink_ann(&p1) }]);
    let r1 = apply(&mut lib.conn, &m).unwrap();
    assert_eq!(r1.revision, 1);
    // Idempotenz: dieselbe Anfrage erneut -> gleiches Ergebnis, keine Duplikate
    let r1b = apply(&mut lib.conn, &m).unwrap();
    assert_eq!(r1, r1b);
    let count: i64 = lib.conn.query_row("SELECT COUNT(*) FROM annotations", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 2);
    // Revisionskonflikt
    let err = apply(&mut lib.conn, &mutation(&doc, 0, vec![Op::RotatePage { page_id: p0.clone(), rotation: 90 }])).unwrap_err();
    assert_eq!(err.code, ErrorCode::RevisionConflict);
    // Reihenfolge, Drehung, IDs bleiben stabil
    apply(&mut lib.conn, &mutation(&doc, 1, vec![Op::MovePage { page_id: p1.clone(), to_position: 1 }, Op::RotatePage { page_id: p0.clone(), rotation: 270 }])).unwrap();
    let snap = documents::load(&lib.conn, &doc).unwrap();
    assert_eq!(snap.pages.iter().map(|p| p.id.clone()).collect::<Vec<_>>(), vec![p0.clone(), p1.clone()]);
    assert_eq!(snap.pages[0].rotation, 270);
    assert_eq!(snap.annotations.iter().filter(|a| a.page_id == p0).count(), 1);
    // Ungültige Payloads werden abgelehnt
    let mut bad = text_ann(&p0, "x");
    bad.payload["color"] = json!("red");
    assert!(apply(&mut lib.conn, &mutation(&doc, 2, vec![Op::UpsertAnnotation { annotation: bad }])).is_err());
    let mut bad = text_ann(&p0, "x");
    bad.payload["unknownField"] = json!(1);
    assert!(apply(&mut lib.conn, &mutation(&doc, 2, vec![Op::UpsertAnnotation { annotation: bad }])).is_err());
    // Fehlgeschlagene Mutation ändert nichts (atomar)
    let before: i64 = lib.conn.query_row("SELECT revision FROM documents WHERE id=?1", [&doc], |r| r.get(0)).unwrap();
    let ok_then_bad = mutation(&doc, 2, vec![Op::UpsertAnnotation { annotation: text_ann(&p0, "neu") }, Op::DeletePage { page_id: new_id() }]);
    assert!(apply(&mut lib.conn, &ok_then_bad).is_err());
    let after: i64 = lib.conn.query_row("SELECT revision FROM documents WHERE id=?1", [&doc], |r| r.get(0)).unwrap();
    assert_eq!(before, after);
    let count: i64 = lib.conn.query_row("SELECT COUNT(*) FROM annotations", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 2);
}

#[test]
fn thousandfold_reordering_keeps_positions_dense() {
    let dir = tempfile::tempdir().unwrap();
    let mut lib = open(dir.path());
    let doc = documents::create_note(&mut lib.conn, None, "Viele Seiten", &NotePaper { orientation: "portrait".into(), background: documents::default_background("blank") }).unwrap();
    let mut ops = vec![];
    for i in 0..30 {
        ops.push(Op::AddPage { page: note_bundle(), position: i });
    }
    apply(&mut lib.conn, &mutation(&doc, 0, ops)).unwrap();
    let ids: Vec<String> = documents::load(&lib.conn, &doc).unwrap().pages.into_iter().map(|p| p.id).collect();
    let mut rev = 1;
    let mut seed = 12345u64;
    for _ in 0..1000 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let pid = ids[(seed >> 33) as usize % ids.len()].clone();
        let to = ((seed >> 13) % 31) as i64;
        apply(&mut lib.conn, &mutation(&doc, rev, vec![Op::MovePage { page_id: pid, to_position: to }])).unwrap();
        rev += 1;
    }
    let pages = documents::load(&lib.conn, &doc).unwrap().pages;
    assert_eq!(pages.len(), 31);
    for (i, p) in pages.iter().enumerate() {
        assert_eq!(p.position, i as i64);
    }
    let set: HashSet<_> = pages.iter().map(|p| p.id.clone()).collect();
    assert_eq!(set.len(), 31);
}

#[test]
fn compose_copies_are_independent_including_forms() {
    let dir = tempfile::tempdir().unwrap();
    let mut lib = open(&dir.path().join("lib"));
    let src = fake_pdf(dir.path(), "form.pdf", "form");
    let doc = import(&mut lib, &src, &analysis("Formular", 2, true));
    let snap = documents::load(&lib.conn, &doc).unwrap();
    assert_eq!(snap.form_groups.len(), 1);
    assert_eq!(snap.widgets.len(), 3);
    let g = snap.form_groups[0].id.clone();
    let p0 = snap.pages[0].id.clone();
    apply(
        &mut lib.conn,
        &mutation(&doc, 0, vec![
            Op::SetFormValue { group_id: g.clone(), field_key: "name".into(), value: json!("Alex") },
            Op::UpsertAnnotation { annotation: text_ann(&p0, "Notiz") },
        ]),
    )
    .unwrap();
    // Ungültiger Wert wird abgelehnt
    assert!(apply(&mut lib.conn, &mutation(&doc, 1, vec![Op::SetFormValue { group_id: g.clone(), field_key: "ok".into(), value: json!("ja") }])).is_err());
    // Zusammenführen: dasselbe Dokument zweimal -> zwei unabhängige Formulargruppen
    let merged = compose(
        &mut lib.conn,
        "Zusammengeführt",
        None,
        &[ComposePart { document_id: doc.clone(), page_ids: None }, ComposePart { document_id: doc.clone(), page_ids: None }],
    )
    .unwrap();
    let m = documents::load(&lib.conn, &merged).unwrap();
    assert_eq!(m.pages.len(), 4);
    assert_eq!(m.form_groups.len(), 2);
    assert_eq!(m.widgets.len(), 6);
    assert_eq!(m.annotations.len(), 2);
    let original_ids: HashSet<_> = snap.pages.iter().map(|p| p.id.clone()).collect();
    assert!(m.pages.iter().all(|p| !original_ids.contains(&p.id)), "neue Seiten-IDs");
    // Wert in einer Kopie ändern: Original und zweite Kopie bleiben unverändert
    let g1 = m.form_groups[0].id.clone();
    apply(&mut lib.conn, &mutation(&merged, 0, vec![Op::SetFormValue { group_id: g1.clone(), field_key: "name".into(), value: json!("Kopie 1") }])).unwrap();
    let m = documents::load(&lib.conn, &merged).unwrap();
    let vals: Vec<_> = m.form_values.iter().filter(|v| v.field_key == "name").map(|v| (v.group_id.clone(), v.value.clone())).collect();
    assert!(vals.contains(&(g1.clone(), json!("Kopie 1"))));
    assert!(vals.iter().any(|(gid, v)| gid != &g1 && v == &json!("Alex")));
    let o = documents::load(&lib.conn, &doc).unwrap();
    assert_eq!(o.form_values.iter().find(|v| v.field_key == "name").unwrap().value, json!("Alex"));
    // Seiten extrahieren: Auswahl, Quelle bleibt erhalten
    let ex = compose(&mut lib.conn, "Auszug", None, &[ComposePart { document_id: doc.clone(), page_ids: Some(vec![snap.pages[1].id.clone()]) }]).unwrap();
    let e = documents::load(&lib.conn, &ex).unwrap();
    assert_eq!(e.pages.len(), 1);
    assert_eq!(e.widgets.len(), 1);
    assert_eq!(documents::load(&lib.conn, &doc).unwrap().pages.len(), 2);
}

#[test]
fn trash_restore_to_recovery_folder_and_purge() {
    let dir = tempfile::tempdir().unwrap();
    let mut lib = open(&dir.path().join("lib"));
    let parent = folders::create(&lib.conn, None, "Semester 1").unwrap();
    let child = folders::create(&lib.conn, Some(&parent.id), "Mathe").unwrap();
    let src = fake_pdf(dir.path(), "s.pdf", "trash");
    let mut a = analysis("Skript", 1, false);
    a.folder_id = Some(child.id.clone());
    let doc = import(&mut lib, &src, &a);
    // Dokument einzeln löschen, dann den Elternordner löschen und endgültig entfernen
    let doc_batch = documents::trash(&lib.conn, &doc).unwrap();
    let folder_batch = folders::trash(&mut lib.conn, &parent.id).unwrap();
    let items = trash::list(&lib.conn).unwrap();
    assert_eq!(items.len(), 2);
    trash::purge(&mut lib.conn, &folder_batch).unwrap();
    trash::restore(&mut lib.conn, &doc_batch).unwrap();
    let s = documents::summary(&lib.conn, &doc).unwrap();
    let rec = folders::list(&lib.conn).unwrap().into_iter().find(|f| f.name == trash::RECOVERY_FOLDER_NAME).unwrap();
    assert_eq!(s.folder_id, Some(rec.id));
    // Endgültiges Löschen entfernt Quelle; GC markiert, löscht aber erst nach der Frist
    let b = documents::trash(&lib.conn, &doc).unwrap();
    let summary = trash::summary(&lib.conn).unwrap();
    assert!(summary.freed_bytes_estimate > 0);
    trash::purge(&mut lib.conn, &b).unwrap();
    let report = gc::sweep(&lib.conn, &lib.root, &HashSet::new()).unwrap();
    assert_eq!(report.marked, 1);
    assert_eq!(report.deleted, 0);
    // Frist künstlich ablaufen lassen
    lib.conn.execute("UPDATE blobs SET unreferenced_since='2000-01-01T00:00:00.000Z'", []).unwrap();
    let hash: String = lib.conn.query_row("SELECT hash FROM blobs", [], |r| r.get(0)).unwrap();
    let pinned: HashSet<String> = [hash.clone()].into_iter().collect();
    assert_eq!(gc::sweep(&lib.conn, &lib.root, &pinned).unwrap().deleted, 0, "gepinnte Objekte bleiben");
    assert_eq!(gc::sweep(&lib.conn, &lib.root, &HashSet::new()).unwrap().deleted, 1);
    assert!(!lib.root.join(objects::object_rel_path(&hash, BlobKind::Pdf)).exists());
}

#[test]
fn backup_roundtrip_and_tamper_detection() {
    let dir = tempfile::tempdir().unwrap();
    let mut lib = open(&dir.path().join("lib"));
    let src = fake_pdf(dir.path(), "s.pdf", "backup");
    let doc = import(&mut lib, &src, &analysis("Skript", 2, true));
    let snap = documents::load(&lib.conn, &doc).unwrap();
    apply(&mut lib.conn, &mutation(&doc, 0, vec![Op::UpsertAnnotation { annotation: text_ann(&snap.pages[0].id, "Gesichert") }])).unwrap();
    let plan = backup::prepare_snapshot(&lib.conn, &lib.root).unwrap();
    // Änderung NACH dem Snapshot darf nicht im Backup landen.
    apply(&mut lib.conn, &mutation(&doc, 1, vec![Op::UpsertAnnotation { annotation: text_ann(&snap.pages[1].id, "Nach Snapshot") }])).unwrap();
    let target = dir.path().join("backups");
    let res = backup::write_archive(&lib.root, &plan, &target, "manual", "0.1.0", &|| false).unwrap();
    std::fs::remove_file(&plan.snapshot_path).unwrap();
    let verified = backup::verify_archive(Path::new(&res.path)).unwrap();
    assert_eq!(verified.library_id, lib.id);
    assert_eq!(verified.document_count, 1);
    // Wiederherstellen in ein neues Verzeichnis und öffnen
    let restored_root = dir.path().join("restored");
    backup::restore_archive(Path::new(&res.path), &restored_root).unwrap();
    let restored = open(&restored_root);
    let rs = documents::load(&restored.conn, &doc).unwrap();
    assert_eq!(rs.annotations.len(), 1);
    assert_eq!(rs.annotations[0].payload["text"], json!("Gesichert"));
    assert_eq!(rs.document.revision, 1);
    assert_eq!(rs.form_groups.len(), 1);
    objects::read_blob(&restored.conn, &restored.root, &rs.sources[0].blob_hash).unwrap();
    // Restore in ein nicht leeres Verzeichnis wird abgelehnt
    assert!(backup::restore_archive(Path::new(&res.path), &restored_root).is_err());
    // Manipuliertes Archiv: ein Byte im gespeicherten (unkomprimierten) Objekt ändern
    let mut bytes = std::fs::read(&res.path).unwrap();
    let needle = b"% Testdatei backup";
    let pos = bytes.windows(needle.len()).position(|w| w == needle).expect("Objekt im Archiv");
    bytes[pos + 2] = b'X';
    let bad = dir.path().join("bad.campus-backup");
    std::fs::write(&bad, &bytes).unwrap();
    let err = backup::verify_archive(&bad).unwrap_err();
    assert!(matches!(err.code, ErrorCode::BackupInvalid), "{err:?}");
    assert!(backup::restore_archive(&bad, &dir.path().join("restored-bad")).is_err());
    assert!(!dir.path().join("restored-bad").exists());
}

#[test]
fn archive_path_rules() {
    assert!(backup::safe_entry_name("campus.sqlite"));
    let h = "ab".to_string() + &"0".repeat(62);
    assert!(backup::safe_entry_name(&format!("objects/ab/{h}.pdf")));
    assert!(!backup::safe_entry_name(&format!("objects/cd/{h}.pdf")));
    assert!(!backup::safe_entry_name("../campus.sqlite"));
    assert!(!backup::safe_entry_name("/etc/passwd"));
    assert!(!backup::safe_entry_name("objects/ab/../../x.pdf"));
    assert!(!backup::safe_entry_name(&format!("objects/ab/{h}.exe")));
    assert!(!backup::safe_entry_name("C:\\Windows\\x"));
}

#[test]
fn retention_keeps_daily_and_weekly_and_never_manual() {
    let dir = tempfile::tempdir().unwrap();
    let mut lib = open(&dir.path().join("lib"));
    let src = fake_pdf(dir.path(), "s.pdf", "ret");
    import(&mut lib, &src, &analysis("S", 1, false));
    let plan = backup::prepare_snapshot(&lib.conn, &lib.root).unwrap();
    let target = dir.path().join("b");
    let res = backup::write_archive(&lib.root, &plan, &target, "auto", "0.1.0", &|| false).unwrap();
    let base = std::fs::read(&res.path).unwrap();
    std::fs::remove_file(&res.path).unwrap();
    // 40 Tage tägliche Sicherungen simulieren
    let start = chrono::NaiveDate::from_ymd_opt(2026, 9, 1).unwrap();
    for d in 0..40 {
        let date = start + chrono::Duration::days(d);
        std::fs::write(target.join(format!("campus-auto-{}-020000.campus-backup", date.format("%Y%m%d"))), &base).unwrap();
    }
    std::fs::write(target.join("campus-manual-20260801-100000.campus-backup"), &base).unwrap();
    std::fs::write(target.join("fremde-datei.campus-backup"), b"x").unwrap();
    let deleted = backup::apply_retention(&target, 7, 4).unwrap();
    let left = backup::list_backups(&target).unwrap();
    let autos = left.iter().filter(|b| b.kind == "auto").count();
    assert!(autos >= 7 && autos <= 11, "{autos}");
    assert_eq!(deleted.len(), 40 - autos);
    assert!(left.iter().any(|b| b.kind == "manual"));
    assert!(target.join("fremde-datei.campus-backup").exists());
}

#[test]
fn crash_between_publish_and_commit_leaves_no_dangling_reference() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lib");
    {
        let lib = open(&root);
        let src = fake_pdf(dir.path(), "s.pdf", "crash");
        let staged = objects::stage_from_path(&lib.root, &src, &[BlobKind::Pdf], 1 << 20, &|| false).unwrap();
        // Simulierter Abbruch: Datei veröffentlicht, aber keine Transaktion.
        objects::publish(&lib.root, &staged).unwrap();
        // Zweite Datei bleibt im Staging liegen.
        let src2 = fake_pdf(dir.path(), "t.pdf", "crash2");
        objects::stage_from_path(&lib.root, &src2, &[BlobKind::Pdf], 1 << 20, &|| false).unwrap();
    }
    let (lib, info) = Library::open(&root, None).unwrap();
    assert_eq!(info.recovered_staging_files, 1);
    let docs = documents::list(&lib.conn, &ListFilter::All, None).unwrap();
    assert!(docs.is_empty());
    let blobs: i64 = lib.conn.query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0)).unwrap();
    assert_eq!(blobs, 0, "keine Datenbankreferenz auf unvollständige Importe");
    lib.conn.execute_batch("PRAGMA integrity_check").unwrap();
}

#[test]
fn image_import_limits_and_png() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let mut png = Vec::new();
    let img = image::RgbaImage::from_pixel(4, 3, image::Rgba([255, 0, 0, 255]));
    image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    let r = campus_core::images::import_image_bytes(&lib.conn, &lib.root, png, "rot.png").unwrap();
    assert_eq!((r.width_px, r.height_px), (4, 3));
    assert_eq!(r.kind, "png");
    assert!(campus_core::images::import_image_bytes(&lib.conn, &lib.root, b"GIF89a".to_vec(), "x.gif").is_err());
}
