//! Bibliothek öffnen/anlegen, exklusiver Schreib-Lock, Startup-Recovery (Spezifikation §6.1, §6.2).

use crate::db;
use crate::error::{CampusError, ErrorCode, Result};
use crate::limits::APPLIED_REQUEST_RETENTION_DAYS;
use crate::model::LibraryInfo;
use crate::util::{new_id, now_iso, write_atomic};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const LIBRARY_FORMAT_VERSION: i64 = 1;
pub const DB_FILE: &str = "campus.sqlite";
pub const LIBRARY_JSON: &str = "library.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryJson {
    pub library_id: String,
    pub format_version: i64,
    pub app: String,
    pub created_at: String,
}

pub struct Library {
    pub root: PathBuf,
    pub conn: Connection,
    pub id: String,
    _lock: File,
}

/// Wird vor einer Datenmigration aufgerufen und muss eine Sicherung erzeugen; Fehler bricht ab.
pub type PreMigrationHook<'a> = &'a mut dyn FnMut(&Path, &Connection) -> Result<()>;

impl Library {
    pub fn db_path(root: &Path) -> PathBuf {
        root.join(DB_FILE)
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.root.join("staging")
    }

    /// Öffnet die Bibliothek unter `root` oder legt sie an. Genau ein schreibender Prozess je Bibliothek.
    pub fn open(root: &Path, pre_migration: Option<PreMigrationHook<'_>>) -> Result<(Library, LibraryInfo)> {
        std::fs::create_dir_all(root)?;
        for dir in ["objects", "staging", "cache", "cache/thumbnails", "logs"] {
            std::fs::create_dir_all(root.join(dir))?;
        }
        let lock = acquire_lock(root)?;
        let db_path = Self::db_path(root);
        let is_new = !db_path.exists();
        let mut conn = db::open(&db_path)?;

        let mut migrated = Vec::new();
        if is_new {
            migrated = db::migrate(&mut conn)?;
            let id = new_id();
            conn.execute(
                "INSERT INTO library_meta(id, format_version, created_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, LIBRARY_FORMAT_VERSION, now_iso()],
            )?;
            let json = LibraryJson {
                library_id: id,
                format_version: LIBRARY_FORMAT_VERSION,
                app: "werkbyte Campus".into(),
                created_at: now_iso(),
            };
            write_atomic(&root.join(LIBRARY_JSON), serde_json::to_string_pretty(&json)?.as_bytes())?;
        } else {
            // Erst prüfen, ob die Bibliothek zu neu ist; dann ggf. Sicherung vor Migration.
            let pending = db::pending_migrations(&conn)?;
            if !pending.is_empty() {
                if db::current_version(&conn)? > 0 {
                    match pre_migration {
                        Some(hook) => hook(root, &conn)?,
                        None => {
                            return Err(CampusError::internal(
                                "Migration erforderlich, aber keine Sicherung vorbereitet.",
                            ))
                        }
                    }
                }
                migrated = db::migrate(&mut conn)?;
                db::integrity_check(&conn)?;
            }
        }

        let id: String = conn.query_row("SELECT id FROM library_meta", [], |r| r.get(0))?;
        let recovered = recover_staging(root)?;
        // Idempotenzschlüssel nur zeitlich begrenzt aufbewahren.
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(APPLIED_REQUEST_RETENTION_DAYS))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        conn.execute("DELETE FROM applied_requests WHERE created_at < ?1", [cutoff])?;

        let info = LibraryInfo {
            library_id: id.clone(),
            root: root.to_string_lossy().to_string(),
            schema_version: db::current_version(&conn)?,
            migrated,
            recovered_staging_files: recovered,
        };
        Ok((Library { root: root.to_path_buf(), conn, id, _lock: lock }, info))
    }
}

fn acquire_lock(root: &Path) -> Result<File> {
    let path = root.join("library.lock");
    let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path)?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            return Err(CampusError::new(
                ErrorCode::LibraryLocked,
                "Die Bibliothek wird bereits von einer anderen Campus-Instanz verwendet.",
            ))
        }
        Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
    }
    // Das Betriebssystem gibt den Lock beim Prozessende frei; ein veralteter Lock kann daher nicht bestehen bleiben.
    file.set_len(0)?;
    let _ = writeln!(file, "pid={} since={}", std::process::id(), now_iso());
    Ok(file)
}

/// Entfernt Reste abgebrochener Importe. Läuft nur beim Öffnen, also vor jedem Job.
fn recover_staging(root: &Path) -> Result<usize> {
    let staging = root.join("staging");
    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(&staging) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                std::fs::remove_file(&p)?;
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Prüft, ob ein Verzeichnis wie eine Campus-Bibliothek aussieht.
pub fn looks_like_library(root: &Path) -> bool {
    root.join(DB_FILE).is_file() && root.join(LIBRARY_JSON).is_file()
}
