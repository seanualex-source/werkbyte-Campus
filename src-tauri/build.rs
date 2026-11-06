// Die App-Befehle werden über ein App-Manifest als Berechtigungen deklariert. So kann die
// Capability-Datei genau festlegen, welche Befehle das Hauptfenster aufrufen darf.
const COMMANDS: &[&str] = &[
    "app_info", "library_choose_location", "library_retry",
    "folder_list", "folder_create", "folder_rename", "folder_move", "folder_trash",
    "document_list", "document_create_note", "document_rename", "document_move", "document_trash",
    "document_load", "document_apply", "document_compose", "document_set_view",
    "trash_list", "trash_summary", "trash_restore", "trash_purge", "trash_empty",
    "import_pick", "import_staged_read", "import_commit", "import_discard",
    "blob_read", "image_pick",
    "export_pick_target", "export_prepare", "export_finish", "export_cancel",
    "backup_status", "backup_choose_target", "backup_create", "backup_verify_pick", "backup_restore_pick",
    "maintenance_gc",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build fehlgeschlagen");
}
