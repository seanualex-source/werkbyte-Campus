//! Schmale IPC-Grenze. Jeder Befehl validiert seine Eingaben im Kern; Dateipfade werden nie
//! vom Renderer übernommen, sondern ausschließlich über native Dialoge oder Drag-and-drop-Ereignisse
//! des Fensters ermittelt und als kurzlebige Tokens weitergegeben.

use crate::state::{AppConfig, AppState};
use campus_core::backup;
use campus_core::documents::{self, ListFilter};
use campus_core::error::{CampusError, ErrorCode, Result};
use campus_core::model::*;
use campus_core::objects::{self, BlobKind, StagedFile};
use campus_core::{apply, compose, folders, gc, images, importer, limits, trash};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

type CmdResult<T> = std::result::Result<T, CampusError>;

fn run_blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> impl std::future::Future<Output = Result<T>> {
    async move {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .map_err(|e| CampusError::internal(format!("Hintergrundaufgabe fehlgeschlagen: {e}")))?
    }
}

// ───────────────────────────── Bibliothek ─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub library: Option<LibraryInfo>,
    pub error: Option<CampusError>,
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> CmdResult<AppInfo> {
    Ok(AppInfo {
        version: APP_VERSION.into(),
        library: state.lib_info.lock().ok().and_then(|i| i.clone()),
        error: state.lib_error.lock().ok().and_then(|e| e.clone()),
    })
}

#[tauri::command]
pub async fn library_choose_location<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> CmdResult<Option<LibraryInfo>> {
    let Some(folder) = app.dialog().file().set_title("Ort für die Campus-Bibliothek wählen").blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|_| CampusError::invalid("Ungültiger Ordner."))?;
    // Ein leerer oder bestehender Bibliotheksordner wird direkt verwendet, sonst ein Unterordner angelegt.
    let root = if campus_core::library::looks_like_library(&path) || std::fs::read_dir(&path).map(|mut d| d.next().is_none()).unwrap_or(false) {
        path
    } else {
        path.join("werkbyte Campus Bibliothek")
    };
    let info = state.open_library(&root, APP_VERSION)?;
    state.paths.save_config(&AppConfig { library_path: Some(root.to_string_lossy().to_string()) })?;
    Ok(Some(info))
}

#[tauri::command]
pub async fn library_retry(state: State<'_, AppState>) -> CmdResult<LibraryInfo> {
    let cfg = state.paths.load_config();
    let root = cfg.library_path.map(PathBuf::from).ok_or_else(|| CampusError::not_found("Kein Bibliotheksort konfiguriert."))?;
    state.open_library(&root, APP_VERSION)
}

// ───────────────────────────── Ordner ─────────────────────────────

#[tauri::command]
pub async fn folder_list(state: State<'_, AppState>) -> CmdResult<Vec<FolderRec>> {
    state.with_lib(|l| folders::list(&l.conn))
}

#[tauri::command]
pub async fn folder_create(state: State<'_, AppState>, parent_id: Option<String>, name: String) -> CmdResult<FolderRec> {
    state.with_lib(|l| folders::create(&l.conn, parent_id.as_deref(), &name))
}

#[tauri::command]
pub async fn folder_rename(state: State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    state.with_lib(|l| folders::rename(&l.conn, &id, &name))
}

#[tauri::command]
pub async fn folder_move(state: State<'_, AppState>, id: String, parent_id: Option<String>) -> CmdResult<()> {
    state.with_lib(|l| folders::move_to(&l.conn, &id, parent_id.as_deref()))
}

#[tauri::command]
pub async fn folder_trash(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    state.with_lib(|l| folders::trash(&mut l.conn, &id))
}

// ───────────────────────────── Dokumente ─────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListArgs {
    pub kind: String,
    pub folder_id: Option<String>,
    pub query: Option<String>,
}

#[tauri::command]
pub async fn document_list(state: State<'_, AppState>, args: ListArgs) -> CmdResult<Vec<DocumentSummary>> {
    let filter = match args.kind.as_str() {
        "all" => ListFilter::All,
        "root" => ListFilter::Root,
        "recent" => ListFilter::Recent,
        "folder" => ListFilter::Folder(args.folder_id.clone().ok_or_else(|| CampusError::invalid("Ordner fehlt."))?),
        _ => return Err(CampusError::invalid("Unbekannter Listenfilter.")),
    };
    state.with_lib(|l| documents::list(&l.conn, &filter, args.query.as_deref()))
}

#[tauri::command]
pub async fn document_create_note(
    state: State<'_, AppState>,
    folder_id: Option<String>,
    title: String,
    paper: NotePaper,
) -> CmdResult<String> {
    state.with_lib(|l| documents::create_note(&mut l.conn, folder_id.as_deref(), &title, &paper))
}

#[tauri::command]
pub async fn document_rename(state: State<'_, AppState>, id: String, title: String) -> CmdResult<()> {
    state.with_lib(|l| documents::rename(&l.conn, &id, &title))
}

#[tauri::command]
pub async fn document_move(state: State<'_, AppState>, id: String, folder_id: Option<String>) -> CmdResult<()> {
    state.with_lib(|l| documents::move_to(&l.conn, &id, folder_id.as_deref()))
}

#[tauri::command]
pub async fn document_trash(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    state.with_lib(|l| documents::trash(&l.conn, &id))
}

#[tauri::command]
pub async fn document_load(state: State<'_, AppState>, id: String) -> CmdResult<DocumentSnapshot> {
    state.with_lib(|l| {
        documents::mark_opened(&l.conn, &id)?;
        documents::load(&l.conn, &id)
    })
}

#[tauri::command]
pub async fn document_apply(state: State<'_, AppState>, mutation: Mutation) -> CmdResult<ApplyResult> {
    state.with_lib(|l| apply::apply(&mut l.conn, &mutation))
}

#[tauri::command]
pub async fn document_compose(
    state: State<'_, AppState>,
    title: String,
    folder_id: Option<String>,
    parts: Vec<ComposePart>,
) -> CmdResult<String> {
    state.with_lib(|l| compose::compose(&mut l.conn, &title, folder_id.as_deref(), &parts))
}

#[tauri::command]
pub async fn document_set_view(state: State<'_, AppState>, id: String, view: ViewRec) -> CmdResult<()> {
    state.with_lib(|l| documents::set_view(&l.conn, &id, &view))
}

// ───────────────────────────── Papierkorb ─────────────────────────────

#[tauri::command]
pub async fn trash_list(state: State<'_, AppState>) -> CmdResult<Vec<TrashItem>> {
    state.with_lib(|l| trash::list(&l.conn))
}

#[tauri::command]
pub async fn trash_summary(state: State<'_, AppState>) -> CmdResult<TrashSummary> {
    state.with_lib(|l| trash::summary(&l.conn))
}

#[tauri::command]
pub async fn trash_restore(state: State<'_, AppState>, batch_id: String) -> CmdResult<()> {
    state.with_lib(|l| trash::restore(&mut l.conn, &batch_id))
}

#[tauri::command]
pub async fn trash_purge(state: State<'_, AppState>, batch_id: String, confirmed: bool) -> CmdResult<()> {
    if !confirmed {
        return Err(CampusError::invalid("Endgültiges Löschen muss bestätigt werden."));
    }
    state.with_lib(|l| trash::purge(&mut l.conn, &batch_id))
}

#[tauri::command]
pub async fn trash_empty(state: State<'_, AppState>, confirmed: bool) -> CmdResult<usize> {
    if !confirmed {
        return Err(CampusError::invalid("Leeren des Papierkorbs muss bestätigt werden."));
    }
    state.with_lib(|l| trash::empty(&mut l.conn))
}

// ───────────────────────────── Import ─────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StagedInfo {
    pub staging_id: String,
    pub name: String,
    pub size: u64,
    pub hash: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StageFailure {
    pub name: String,
    pub error: CampusError,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StageReport {
    pub staged: Vec<StagedInfo>,
    pub failed: Vec<StageFailure>,
}

fn library_root(state: &AppState) -> Result<PathBuf> {
    state.with_lib(|l| Ok(l.root.clone()))
}

pub fn stage_paths(state: &AppState, paths: Vec<PathBuf>) -> StageReport {
    let mut report = StageReport { staged: vec![], failed: vec![] };
    let root = match library_root(state) {
        Ok(r) => r,
        Err(e) => {
            report.failed.push(StageFailure { name: "Bibliothek".into(), error: e });
            return report;
        }
    };
    for p in paths {
        let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        match objects::stage_from_path(&root, &p, &[BlobKind::Pdf], limits::MAX_PDF_BYTES, &|| false) {
            Ok(st) => {
                let info = StagedInfo { staging_id: st.id.clone(), name: st.original_name.clone(), size: st.size, hash: st.hash.clone() };
                state.staged.lock().unwrap().insert(st.id.clone(), st);
                report.staged.push(info);
            }
            Err(error) => report.failed.push(StageFailure { name, error }),
        }
    }
    report
}

#[tauri::command]
pub async fn import_pick<R: Runtime>(app: AppHandle<R>) -> CmdResult<StageReport> {
    let picked = app
        .dialog()
        .file()
        .set_title("PDF importieren")
        .add_filter("PDF-Dokumente", &["pdf", "PDF"])
        .blocking_pick_files();
    let Some(files) = picked else {
        return Ok(StageReport { staged: vec![], failed: vec![] });
    };
    let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
    let app2 = app.clone();
    run_blocking(move || Ok(stage_paths(&app2.state::<AppState>(), paths))).await
}

fn staged(state: &AppState, id: &str) -> Result<StagedFile> {
    state
        .staged
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| CampusError::not_found("Importdatei nicht mehr verfügbar. Bitte erneut auswählen."))
}

#[tauri::command]
pub async fn import_staged_read(state: State<'_, AppState>, staging_id: String) -> CmdResult<Response> {
    let st = staged(&state, &staging_id)?;
    let bytes = std::fs::read(&st.path)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn import_commit<R: Runtime>(app: AppHandle<R>, staging_id: String, analysis: importer::ImportAnalysis) -> CmdResult<String> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let st = staged(&state, &staging_id)?;
        let doc = state.with_lib(|l| {
            let root = l.root.clone();
            importer::commit(&mut l.conn, &root, &st, &analysis)
        })?;
        state.staged.lock().unwrap().remove(&staging_id);
        Ok(doc)
    })
    .await
}

#[tauri::command]
pub async fn import_discard(state: State<'_, AppState>, staging_id: String) -> CmdResult<()> {
    if let Some(st) = state.staged.lock().unwrap().remove(&staging_id) {
        let _ = std::fs::remove_file(&st.path);
    }
    Ok(())
}

// ───────────────────────────── Objekte und Bilder ─────────────────────────────

#[tauri::command]
pub async fn blob_read<R: Runtime>(app: AppHandle<R>, hash: String) -> CmdResult<Response> {
    let bytes = run_blocking(move || {
        let state = app.state::<AppState>();
        state.with_lib(|l| objects::read_blob(&l.conn, &l.root, &hash).map(|(b, _)| b))
    })
    .await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn image_pick<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<images::ImportedImage>> {
    let Some(file) = app
        .dialog()
        .file()
        .set_title("Bild einfügen")
        .add_filter("Bilder", &["png", "jpg", "jpeg", "PNG", "JPG", "JPEG"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|_| CampusError::invalid("Ungültige Datei."))?;
    let meta = std::fs::metadata(&path)?;
    if meta.len() > limits::MAX_IMAGE_BYTES {
        return Err(CampusError::limit("Bilder dürfen höchstens 25 MiB groß sein."));
    }
    run_blocking(move || {
        let data = std::fs::read(&path)?;
        let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let state = app.state::<AppState>();
        state.with_lib(|l| images::import_image_bytes(&l.conn, &l.root, data, &name)).map(Some)
    })
    .await
}

// ───────────────────────────── Export ─────────────────────────────

#[tauri::command]
pub async fn export_pick_target<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, suggested_name: String) -> CmdResult<Option<String>> {
    let clean: String = suggested_name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect::<String>()
        .trim()
        .chars()
        .take(150)
        .collect();
    let name = if clean.is_empty() { "Export".to_string() } else { clean };
    let Some(file) = app
        .dialog()
        .file()
        .set_title("Als PDF exportieren")
        .set_file_name(format!("{name}.pdf"))
        .add_filter("PDF-Dokument", &["pdf"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let mut path = file.into_path().map_err(|_| CampusError::invalid("Ungültiges Ziel."))?;
    if path.extension().map(|e| !e.eq_ignore_ascii_case("pdf")).unwrap_or(true) {
        path.set_extension("pdf");
    }
    Ok(Some(state.issue_target(path)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPrepared {
    pub export_id: String,
    pub snapshot: DocumentSnapshot,
}

#[tauri::command]
pub async fn export_prepare(state: State<'_, AppState>, document_id: String) -> CmdResult<ExportPrepared> {
    let snapshot = state.with_lib(|l| documents::load(&l.conn, &document_id))?;
    let mut hashes: Vec<String> = snapshot.sources.iter().map(|s| s.blob_hash.clone()).collect();
    for a in &snapshot.annotations {
        if let Some(h) = a.payload.get("blobHash").and_then(Value::as_str) {
            hashes.push(h.to_string());
        }
    }
    state.pin(&hashes);
    let export_id = campus_core::util::new_id();
    state.exports.lock().unwrap().insert(export_id.clone(), hashes);
    Ok(ExportPrepared { export_id, snapshot })
}

fn release_export(state: &AppState, export_id: &str) {
    if let Some(h) = state.exports.lock().unwrap().remove(export_id) {
        state.unpin(&h);
    }
}

#[tauri::command]
pub async fn export_cancel(state: State<'_, AppState>, export_id: String) -> CmdResult<()> {
    release_export(&state, &export_id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDone {
    pub path: String,
    pub bytes: u64,
}

/// Erhält das fertige PDF als Binärkörper. Schreibt erst eine temporäre Datei im Zielordner
/// und benennt sie anschließend atomar um. Ein vorhandenes Ziel wurde im Speichern-Dialog
/// ausdrücklich zum Überschreiben bestätigt.
#[tauri::command]
pub async fn export_finish<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> CmdResult<ExportDone> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
    let export_id = header("x-export-id").ok_or_else(|| CampusError::invalid("Export-ID fehlt."))?;
    let token = header("x-target-token").ok_or_else(|| CampusError::invalid("Dateiziel fehlt."))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CampusError::invalid("Exportdaten fehlen."));
    };
    let bytes = bytes.clone();
    if !bytes.starts_with(b"%PDF-") {
        return Err(CampusError::invalid("Exportdaten sind kein PDF."));
    }
    let state = app.state::<AppState>();
    let target = match state.take_target(&token) {
        Ok(t) => t,
        Err(e) => {
            release_export(&state, &export_id);
            return Err(e);
        }
    };
    let app2 = app.clone();
    let result = run_blocking(move || {
        campus_core::util::write_atomic(&target, &bytes)?;
        Ok(ExportDone { path: target.to_string_lossy().to_string(), bytes: bytes.len() as u64 })
    })
    .await;
    release_export(&app2.state::<AppState>(), &export_id);
    result
}

// ───────────────────────────── Backup ─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRun {
    pub id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub kind: String,
    pub file_name: Option<String>,
    pub message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub target: Option<String>,
    pub target_reachable: bool,
    pub running: bool,
    pub last_success: Option<BackupRun>,
    pub last_run: Option<BackupRun>,
    pub backups: Vec<backup::BackupFileInfo>,
    pub same_drive_warning: bool,
    pub library_root: String,
}

fn backup_target(conn: &rusqlite::Connection) -> Result<Option<PathBuf>> {
    Ok(campus_core::db::get_setting(conn, "backupTarget")?.and_then(|v| v.as_str().map(PathBuf::from)))
}

fn load_run(conn: &rusqlite::Connection, where_clause: &str) -> Result<Option<BackupRun>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            &format!("SELECT id, started_at, finished_at, status, kind, file_name, message FROM backup_runs {where_clause} ORDER BY started_at DESC LIMIT 1"),
            [],
            |r| {
                Ok(BackupRun {
                    id: r.get(0)?,
                    started_at: r.get(1)?,
                    finished_at: r.get(2)?,
                    status: r.get(3)?,
                    kind: r.get(4)?,
                    file_name: r.get(5)?,
                    message: r.get(6)?,
                })
            },
        )
        .optional()?)
}

fn drive_of(p: &Path) -> Option<String> {
    p.components().next().map(|c| c.as_os_str().to_string_lossy().to_uppercase())
}

#[tauri::command]
pub async fn backup_status(state: State<'_, AppState>) -> CmdResult<BackupStatus> {
    let (target, last_success, last_run, root) = state.with_lib(|l| {
        Ok((
            backup_target(&l.conn)?,
            load_run(&l.conn, "WHERE status='ok'")?,
            load_run(&l.conn, "")?,
            l.root.clone(),
        ))
    })?;
    let dir = target.as_ref().map(|t| t.join(backup::BACKUP_SUBDIR));
    let reachable = target.as_ref().map(|t| t.is_dir()).unwrap_or(false);
    let backups = match (&dir, reachable) {
        (Some(d), true) => backup::list_backups(d).unwrap_or_default(),
        _ => vec![],
    };
    let same_drive = target.as_ref().map(|t| drive_of(t) == drive_of(&root)).unwrap_or(false);
    Ok(BackupStatus {
        target: target.map(|t| t.to_string_lossy().to_string()),
        target_reachable: reachable,
        running: state.backup_running.load(Ordering::SeqCst),
        last_success,
        last_run,
        backups,
        same_drive_warning: same_drive,
        library_root: root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn backup_choose_target<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> CmdResult<Option<String>> {
    let Some(folder) = app.dialog().file().set_title("Ziel für Sicherungen wählen").blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|_| CampusError::invalid("Ungültiger Ordner."))?;
    let root = library_root(&state)?;
    if path.starts_with(&root) {
        return Err(CampusError::invalid("Sicherungen dürfen nicht innerhalb der Bibliothek liegen."));
    }
    let s = path.to_string_lossy().to_string();
    state.with_lib(|l| campus_core::db::set_setting(&l.conn, "backupTarget", &Value::String(s.clone())))?;
    Ok(Some(s))
}

struct RunningGuard<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// `kind`: "manual" erzeugt immer eine Sicherung; "auto" nur, wenn seit der letzten
/// erfolgreichen Sicherung mindestens 24 Stunden vergangen sind und sich etwas geändert hat.
#[tauri::command]
pub async fn backup_create<R: Runtime>(app: AppHandle<R>, kind: String) -> CmdResult<Option<backup::BackupResult>> {
    if !matches!(kind.as_str(), "manual" | "auto") {
        return Err(CampusError::invalid("Unbekannte Sicherungsart."));
    }
    run_blocking(move || {
        let state = app.state::<AppState>();
        if state.backup_running.swap(true, Ordering::SeqCst) {
            return Err(CampusError::invalid("Es läuft bereits eine Sicherung."));
        }
        let _guard = RunningGuard(&state.backup_running);
        // Phase 1 unter Writer-Sperre.
        let prepared = state.with_lib(|l| {
            let target = backup_target(&l.conn)?.ok_or_else(|| CampusError::invalid("Bitte zuerst ein Sicherungsziel wählen."))?;
            if kind == "auto" {
                let last = load_run(&l.conn, "WHERE status='ok'")?;
                if let Some(last) = &last {
                    let finished = last.finished_at.clone().unwrap_or_default();
                    let age_ok = is_older_than_hours(&finished, 24);
                    let changed: i64 = l.conn.query_row(
                        "SELECT COUNT(*) FROM documents WHERE updated_at > ?1 OR deleted_at > ?1",
                        [&finished],
                        |r| r.get(0),
                    )?;
                    let changed_folders: i64 =
                        l.conn.query_row("SELECT COUNT(*) FROM folders WHERE updated_at > ?1 OR deleted_at > ?1", [&finished], |r| r.get(0))?;
                    if !age_ok || (changed == 0 && changed_folders == 0) {
                        return Ok(None);
                    }
                }
            }
            if !target.is_dir() {
                return Err(CampusError::new(ErrorCode::FileMissing, "Das Sicherungsziel ist nicht erreichbar."));
            }
            let run_id = campus_core::util::new_id();
            l.conn.execute(
                "INSERT INTO backup_runs(id, started_at, status, kind, target_label) VALUES (?1, ?2, 'running', ?3, ?4)",
                rusqlite::params![run_id, campus_core::util::now_iso(), kind, target.to_string_lossy()],
            )?;
            let plan = backup::prepare_snapshot(&l.conn, &l.root)?;
            Ok(Some((run_id, plan, target, l.root.clone())))
        })?;
        let Some((run_id, plan, target, root)) = prepared else { return Ok(None) };
        let hashes = plan.hashes();
        state.pin(&hashes);
        // Phase 2 ohne Sperre: Objekte sind unveränderlich und gepinnt.
        let dir = target.join(backup::BACKUP_SUBDIR);
        let result = backup::write_archive(&root, &plan, &dir, &kind, APP_VERSION, &|| false);
        state.unpin(&hashes);
        let _ = std::fs::remove_file(&plan.snapshot_path);
        let finished = campus_core::util::now_iso();
        match &result {
            Ok(r) => {
                state.with_lib(|l| {
                    l.conn.execute(
                        "UPDATE backup_runs SET status='ok', finished_at=?2, manifest_hash=?3, file_name=?4 WHERE id=?1",
                        rusqlite::params![run_id, finished, r.manifest_hash, r.file_name],
                    )?;
                    Ok(())
                })?;
                if kind == "auto" {
                    let _ = backup::apply_retention(&dir, 7, 4);
                }
            }
            Err(e) => {
                let _ = state.with_lib(|l| {
                    l.conn.execute(
                        "UPDATE backup_runs SET status='failed', finished_at=?2, message=?3 WHERE id=?1",
                        rusqlite::params![run_id, finished, e.message],
                    )?;
                    Ok(())
                });
            }
        }
        result.map(Some)
    })
    .await
}

fn is_older_than_hours(iso: &str, hours: i64) -> bool {
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(t) => (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_hours() >= hours,
        Err(_) => true,
    }
}

async fn pick_backup_file<R: Runtime>(app: &AppHandle<R>, title: &str) -> Result<Option<PathBuf>> {
    let Some(file) = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter("Campus-Sicherung", &[backup::BACKUP_EXT])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    Ok(Some(file.into_path().map_err(|_| CampusError::invalid("Ungültige Datei."))?))
}

#[tauri::command]
pub async fn backup_verify_pick<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<backup::VerifiedBackup>> {
    let Some(path) = pick_backup_file(&app, "Sicherung prüfen").await? else { return Ok(None) };
    run_blocking(move || backup::verify_archive(&path).map(Some)).await
}

/// Stellt eine Sicherung in ein neues Bibliotheksverzeichnis wieder her und öffnet es.
/// Die bisherige Bibliothek bleibt unverändert erhalten.
#[tauri::command]
pub async fn backup_restore_pick<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<LibraryInfo>> {
    let Some(path) = pick_backup_file(&app, "Sicherung wiederherstellen").await? else { return Ok(None) };
    run_blocking(move || {
        let state = app.state::<AppState>();
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        let dest = state.paths.libraries_dir().join(format!("wiederhergestellt-{stamp}"));
        backup::restore_archive(&path, &dest)?;
        // Aktuelle Bibliothek schließen, neue öffnen.
        {
            let mut guard = state.lib.lock().unwrap();
            *guard = None;
        }
        let info = state.open_library(&dest, APP_VERSION)?;
        state.paths.save_config(&AppConfig { library_path: Some(dest.to_string_lossy().to_string()) })?;
        Ok(Some(info))
    })
    .await
}

// ───────────────────────────── Wartung ─────────────────────────────

#[tauri::command]
pub async fn maintenance_gc<R: Runtime>(app: AppHandle<R>) -> CmdResult<Value> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let pinned = state.pinned();
        let report = state.with_lib(|l| gc::sweep(&l.conn, &l.root, &pinned))?;
        Ok(serde_json::json!({ "marked": report.marked, "deleted": report.deleted, "strayFilesDeleted": report.stray_files_deleted }))
    })
    .await
}

/// Drag-and-drop von Dateien in das Fenster: Pfade stammen vom Betriebssystem, nicht vom Renderer.
pub fn handle_drop<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let pdfs: Vec<PathBuf> = paths.into_iter().filter(|p| p.is_file()).collect();
        if pdfs.is_empty() {
            return;
        }
        let report = stage_paths(&app2.state::<AppState>(), pdfs);
        let _ = app2.emit("campus://import-staged", report);
    });
}
