//! werkbyte Campus · Tauri-Anwendung
//!
//! Diese Schicht verbindet Fenster, native Dialoge und IPC mit dem Kern (`campus-core`).
//! Fachlogik, Speicherung und Backup liegen ausschließlich im Kern.

mod commands;
mod state;

use state::{AppConfig, AppPaths, AppState};
use std::path::PathBuf;
use tauri::{DragDropEvent, Manager, Runtime, WindowEvent};

fn resolve_paths(app: &tauri::App) -> AppPaths {
    // Produktkonvention: %LOCALAPPDATA%\werkbyte\Campus; tatsächlicher Pfad über die Plattform-API.
    let base = app
        .path()
        .local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("werkbyte")
        .join("Campus");
    AppPaths { config: base.join("config.json"), base }
}

/// Registriert alle Campus-Befehle (auch für Tests mit der Mock-Runtime).
pub fn with_commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::library_choose_location,
            commands::library_retry,
            commands::folder_list,
            commands::folder_create,
            commands::folder_rename,
            commands::folder_move,
            commands::folder_trash,
            commands::document_list,
            commands::document_create_note,
            commands::document_rename,
            commands::document_move,
            commands::document_trash,
            commands::document_load,
            commands::document_apply,
            commands::document_compose,
            commands::document_set_view,
            commands::trash_list,
            commands::trash_summary,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_empty,
            commands::import_pick,
            commands::import_staged_read,
            commands::import_commit,
            commands::import_discard,
            commands::blob_read,
            commands::image_pick,
            commands::export_pick_target,
            commands::export_prepare,
            commands::export_finish,
            commands::export_cancel,
            commands::backup_status,
            commands::backup_choose_target,
            commands::backup_create,
            commands::backup_verify_pick,
            commands::backup_restore_pick,
            commands::maintenance_gc,
        ])
}

pub fn run() {
    with_commands(tauri::Builder::default())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Zweiter Start fokussiert die bestehende Instanz.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = resolve_paths(app);
            let _ = std::fs::create_dir_all(&paths.base);
            let state = AppState::new(paths);
            let mut cfg = state.paths.load_config();
            let root = match &cfg.library_path {
                Some(p) => PathBuf::from(p),
                None => {
                    let p = state.paths.libraries_dir().join(campus_core::util::new_id());
                    cfg = AppConfig { library_path: Some(p.to_string_lossy().to_string()) };
                    let _ = state.paths.save_config(&cfg);
                    p
                }
            };
            // Fehler (z. B. gesperrt oder zu neues Schema) werden im UI angezeigt, nicht verschluckt.
            let _ = state.open_library(&root, commands::APP_VERSION);
            // Verzögerte Bereinigung beim Start, bevor Jobs laufen.
            let pinned = state.pinned();
            let _ = state.with_lib(|l| campus_core::gc::sweep(&l.conn, &l.root, &pinned));
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                commands::handle_drop(window.app_handle(), paths.clone());
            }
        })
        .run(tauri::generate_context!())
        .expect("werkbyte Campus konnte nicht gestartet werden");
}

#[cfg(test)]
mod ipc_tests;
