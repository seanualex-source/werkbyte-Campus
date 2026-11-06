//! IPC-Vertragstests: ruft die echten Befehle über die Tauri-Mock-Runtime mit genau den
//! JSON-Formen auf, die das Frontend sendet (camelCase, verschachtelte Ops, Binärkörper).

use crate::commands;
use crate::state::{AppPaths, AppState};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

struct Env {
    _app: tauri::App<MockRuntime>,
    w: WebviewWindow<MockRuntime>,
    dir: tempfile::TempDir,
}

fn setup() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("base");
    let state = AppState::new(AppPaths { config: base.join("config.json"), base });
    state.open_library(&dir.path().join("lib"), "test").unwrap();
    let app = crate::with_commands(mock_builder()).manage(state).build(tauri::generate_context!()).unwrap();
    let w = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    Env { _app: app, w, dir }
}

fn request(cmd: &str, body: InvokeBody, headers: &[(&str, &str)]) -> InvokeRequest {
    let mut h = tauri::http::HeaderMap::new();
    for (k, v) in headers {
        h.insert(tauri::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
    }
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body,
        headers: h,
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn call(e: &Env, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(&e.w, request(cmd, InvokeBody::Json(body), &[])).map(|r| r.deserialize::<Value>().unwrap())
}

fn ok(e: &Env, cmd: &str, body: Value) -> Value {
    call(e, cmd, body).unwrap_or_else(|err| panic!("{cmd} fehlgeschlagen: {err}"))
}

fn raw(e: &Env, cmd: &str, body: Value) -> Vec<u8> {
    match get_ipc_response(&e.w, request(cmd, InvokeBody::Json(body), &[])).unwrap() {
        tauri::ipc::InvokeResponseBody::Raw(b) => b,
        other => panic!("Binärantwort erwartet, erhalten: {other:?}"),
    }
}

#[test]
fn library_folders_documents_and_mutations() {
    let e = setup();
    let info = ok(&e, "app_info", json!({}));
    assert_eq!(info["library"]["schemaVersion"], 1);
    let sem = ok(&e, "folder_create", json!({ "parentId": null, "name": "Semester 1" }));
    let math = ok(&e, "folder_create", json!({ "parentId": sem["id"], "name": "Mathematik" }));
    let bg = json!({ "type": "ruled", "spacingPt": 22, "color": "#B9C3CE", "lineWidthPt": 0.5 });
    let doc = ok(&e, "document_create_note", json!({ "folderId": math["id"], "title": "Vorlesung 1", "paper": { "orientation": "portrait", "background": bg } }));
    let list = ok(&e, "document_list", json!({ "args": { "kind": "folder", "folderId": math["id"], "query": null } }));
    assert_eq!(list.as_array().unwrap().len(), 1);
    let snap = ok(&e, "document_load", json!({ "id": doc }));
    let p0 = snap["pages"][0]["id"].as_str().unwrap().to_string();
    let new_page = uuid::Uuid::new_v4().to_string();
    let ann = uuid::Uuid::new_v4().to_string();
    // Exakt die Form, die das Frontend (domain/ops.ts) erzeugt.
    let mutation = json!({ "mutation": {
        "requestId": uuid::Uuid::new_v4().to_string(),
        "documentId": doc,
        "expectedRevision": 0,
        "payload": [
            { "op": "addPage", "position": 1, "page": { "id": new_page, "kind": "note", "sourceId": null, "sourcePageIndex": null,
                "widthPt": 595.2756, "heightPt": 841.8898, "rotation": 0, "background": { "type": "grid", "spacingPt": 14.17, "color": "#C7D0DB", "lineWidthPt": 0.4 },
                "annotations": [], "widgets": [] } },
            { "op": "upsertAnnotation", "annotation": { "id": ann, "pageId": p0, "kind": "text", "zIndex": 1, "payloadVersion": 1,
                "payload": { "x": 42, "y": 70, "width": 240, "height": 72, "text": "Grüße ∫", "fontAssetId": "bundled-font-regular-v1", "fontSize": 12, "lineHeight": 1.3, "color": "#17212B", "align": "left", "orient": 0 } } },
            { "op": "rotatePage", "pageId": new_page, "rotation": 90 },
            { "op": "movePage", "pageId": new_page, "toPosition": 0 },
            { "op": "rename", "title": "Vorlesung 1 (neu)" }
        ]
    }});
    let r = ok(&e, "document_apply", mutation.clone());
    assert_eq!(r["revision"], 1);
    // Wiederholung derselben Anfrage: gleiches Ergebnis
    assert_eq!(ok(&e, "document_apply", mutation), r);
    let snap = ok(&e, "document_load", json!({ "id": doc }));
    assert_eq!(snap["document"]["title"], "Vorlesung 1 (neu)");
    assert_eq!(snap["pages"][0]["id"], new_page);
    assert_eq!(snap["pages"][0]["rotation"], 90);
    assert_eq!(snap["annotations"][0]["payload"]["text"], "Grüße ∫");
    // Fehlerobjekt hat die Form {code, message, retryable}
    let err = call(&e, "document_apply", json!({ "mutation": { "requestId": "x1", "documentId": doc, "expectedRevision": 0, "payload": [] } })).unwrap_err();
    assert_eq!(err["code"], "REVISION_CONFLICT");
    assert!(err["message"].as_str().unwrap().len() > 5);
    assert_eq!(err["retryable"], false);
    // Zusammenführen, Papierkorb, Wiederherstellen
    let merged = ok(&e, "document_compose", json!({ "title": "Kopie", "folderId": null, "parts": [{ "documentId": doc, "pageIds": null }] }));
    assert!(merged.is_string());
    let batch = ok(&e, "folder_trash", json!({ "id": sem["id"] }));
    assert_eq!(ok(&e, "trash_list", json!({})).as_array().unwrap().len(), 1);
    let sum = ok(&e, "trash_summary", json!({}));
    assert_eq!(sum["documentCount"], 1);
    ok(&e, "trash_restore", json!({ "batchId": batch }));
    assert!(call(&e, "trash_empty", json!({ "confirmed": false })).is_err());
    ok(&e, "document_set_view", json!({ "id": doc, "view": { "pageId": new_page, "zoom": 1.25, "scrollOffset": 0 } }));
    assert_eq!(ok(&e, "document_load", json!({ "id": doc }))["view"]["zoom"], 1.25);
}

#[test]
fn import_staging_blob_and_export_binary_roundtrip() {
    let e = setup();
    let pdf = e.dir.path().join("skript.pdf");
    std::fs::write(&pdf, b"%PDF-1.7\n% Testskript\n%%EOF\n").unwrap();
    let state = e.w.state::<AppState>();
    let report = commands::stage_paths(&state, vec![pdf.clone()]);
    assert_eq!(report.staged.len(), 1);
    let sid = report.staged[0].staging_id.clone();
    let bytes = raw(&e, "import_staged_read", json!({ "stagingId": sid }));
    assert!(bytes.starts_with(b"%PDF-"));
    // Analyse in der Form von ImportAnalysis (TypeScript)
    let analysis = json!({ "title": "Skript", "folderId": null, "pageCount": 1,
        "pages": [{ "index": 0, "cropX": 0, "cropY": 0, "widthPt": 595, "heightPt": 842, "intrinsicRotation": 90, "userUnit": 1 }],
        "fields": [{ "key": "name", "fieldType": "text", "options": [], "multiline": false, "maxLength": null, "value": "",
            "widgets": [{ "pageIndex": 0, "widgetKey": "name#0", "x": 10, "y": 10, "width": 100, "height": 20, "onValue": null }] }],
        "warnings": ["Hinweis"], "pdfVersion": "1.7" });
    let doc = ok(&e, "import_commit", json!({ "stagingId": sid, "analysis": analysis }));
    std::fs::remove_file(&pdf).unwrap();
    let snap = ok(&e, "document_load", json!({ "id": doc }));
    assert_eq!(snap["sourcePages"][0]["intrinsicRotation"], 90);
    assert_eq!(snap["widgets"].as_array().unwrap().len(), 1);
    assert_eq!(snap["sources"][0]["fields"][0]["fieldKey"], "name");
    let hash = snap["sources"][0]["blobHash"].as_str().unwrap().to_string();
    assert!(raw(&e, "blob_read", json!({ "hash": hash })).starts_with(b"%PDF-"));
    // Export: Snapshot, Pin, Binärkörper mit Headern, atomares Schreiben
    let prep = ok(&e, "export_prepare", json!({ "documentId": doc }));
    let export_id = prep["exportId"].as_str().unwrap().to_string();
    let target = e.dir.path().join("out").join("Export.pdf");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let token = state.issue_target(target.clone());
    assert!(state.pinned().contains(&hash));
    let res = get_ipc_response(
        &e.w,
        request("export_finish", InvokeBody::Raw(b"%PDF-1.7 export".to_vec()), &[("x-export-id", &export_id), ("x-target-token", &token)]),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(res["bytes"], 15);
    assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-1.7 export");
    assert!(!state.pinned().contains(&hash), "Pins werden nach dem Export freigegeben");
    // Token ist verbraucht: erneutes Schreiben wird abgelehnt
    let again = get_ipc_response(&e.w, request("export_finish", InvokeBody::Raw(b"%PDF-1.7 x".to_vec()), &[("x-export-id", &export_id), ("x-target-token", &token)]));
    assert!(again.is_err());
    // Kein PDF wird abgelehnt
    let prep2 = ok(&e, "export_prepare", json!({ "documentId": doc }));
    let token2 = state.issue_target(target.clone());
    let bad = get_ipc_response(&e.w, request("export_finish", InvokeBody::Raw(b"nope".to_vec()), &[("x-export-id", prep2["exportId"].as_str().unwrap()), ("x-target-token", &token2)]));
    assert!(bad.is_err());
}

#[test]
fn backup_via_ipc() {
    let e = setup();
    let state = e.w.state::<AppState>();
    let target = e.dir.path().join("usb");
    std::fs::create_dir_all(&target).unwrap();
    state
        .with_lib(|l| campus_core::db::set_setting(&l.conn, "backupTarget", &json!(target.to_string_lossy())))
        .unwrap();
    let bg = json!({ "type": "blank", "spacingPt": 22, "color": "#B9C3CE", "lineWidthPt": 0.5 });
    ok(&e, "document_create_note", json!({ "folderId": null, "title": "A", "paper": { "orientation": "landscape", "background": bg } }));
    let r = ok(&e, "backup_create", json!({ "kind": "manual" }));
    assert!(r["fileName"].as_str().unwrap().starts_with("campus-manual-"));
    // Automatisch: kurz nach einer Sicherung nicht fällig
    assert!(ok(&e, "backup_create", json!({ "kind": "auto" })).is_null());
    let st = ok(&e, "backup_status", json!({}));
    assert_eq!(st["backups"].as_array().unwrap().len(), 1);
    assert_eq!(st["lastSuccess"]["status"], "ok");
    assert!(call(&e, "backup_create", json!({ "kind": "anders" })).is_err());
}

#[test]
fn foreign_origin_is_rejected_by_capabilities() {
    let e = setup();
    let mut req = request("folder_list", InvokeBody::Json(json!({})), &[]);
    req.url = "https://example.com".parse().unwrap();
    let err = get_ipc_response(&e.w, req).unwrap_err();
    assert!(err.to_string().contains("not allowed"), "{err}");
}
