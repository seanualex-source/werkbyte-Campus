//! Laufzeitzustand der App: geöffnete Bibliothek (zentraler Writer), Staging-Tokens,
//! kurzlebige Dateiziele und Pins gegen Bereinigung.

use campus_core::backup;
use campus_core::error::{CampusError, ErrorCode, Result};
use campus_core::library::Library;
use campus_core::model::LibraryInfo;
use campus_core::objects::StagedFile;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const TOKEN_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub library_path: Option<String>,
}

pub struct AppPaths {
    pub base: PathBuf,
    pub config: PathBuf,
}

impl AppPaths {
    pub fn libraries_dir(&self) -> PathBuf {
        self.base.join("Libraries")
    }
    pub fn fallback_backup_dir(&self) -> PathBuf {
        self.base.join("Sicherungen")
    }
    pub fn load_config(&self) -> AppConfig {
        std::fs::read(&self.config).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn save_config(&self, cfg: &AppConfig) -> Result<()> {
        campus_core::util::write_atomic(&self.config, serde_json::to_string_pretty(cfg)?.as_bytes())
    }
}

pub struct AppState {
    pub paths: AppPaths,
    pub lib: Mutex<Option<Library>>,
    pub lib_info: Mutex<Option<LibraryInfo>>,
    pub lib_error: Mutex<Option<CampusError>>,
    pub staged: Mutex<HashMap<String, StagedFile>>,
    pub file_targets: Mutex<HashMap<String, (PathBuf, Instant)>>,
    pub exports: Mutex<HashMap<String, Vec<String>>>,
    pub pins: Mutex<HashMap<String, usize>>,
    pub backup_running: AtomicBool,
}

impl AppState {
    pub fn new(paths: AppPaths) -> Self {
        Self {
            paths,
            lib: Mutex::new(None),
            lib_info: Mutex::new(None),
            lib_error: Mutex::new(None),
            staged: Mutex::new(HashMap::new()),
            file_targets: Mutex::new(HashMap::new()),
            exports: Mutex::new(HashMap::new()),
            pins: Mutex::new(HashMap::new()),
            backup_running: AtomicBool::new(false),
        }
    }

    /// Führt eine Operation mit der geöffneten Bibliothek aus. Der Mutex ist der zentrale Writer.
    pub fn with_lib<T>(&self, f: impl FnOnce(&mut Library) -> Result<T>) -> Result<T> {
        let mut guard = self.lib.lock().map_err(|_| CampusError::internal("Interner Sperrfehler."))?;
        match guard.as_mut() {
            Some(lib) => f(lib),
            None => Err(self
                .lib_error
                .lock()
                .ok()
                .and_then(|e| e.clone())
                .unwrap_or_else(|| CampusError::new(ErrorCode::NotFound, "Keine Bibliothek geöffnet."))),
        }
    }

    pub fn pin(&self, hashes: &[String]) {
        if let Ok(mut p) = self.pins.lock() {
            for h in hashes {
                *p.entry(h.clone()).or_insert(0) += 1;
            }
        }
    }

    pub fn unpin(&self, hashes: &[String]) {
        if let Ok(mut p) = self.pins.lock() {
            for h in hashes {
                if let Some(c) = p.get_mut(h) {
                    *c -= 1;
                    if *c == 0 {
                        p.remove(h);
                    }
                }
            }
        }
    }

    pub fn pinned(&self) -> std::collections::HashSet<String> {
        self.pins.lock().map(|p| p.keys().cloned().collect()).unwrap_or_default()
    }

    pub fn issue_target(&self, path: PathBuf) -> String {
        let token = campus_core::util::new_id();
        if let Ok(mut t) = self.file_targets.lock() {
            t.retain(|_, (_, at)| at.elapsed() < TOKEN_TTL);
            t.insert(token.clone(), (path, Instant::now()));
        }
        token
    }

    pub fn take_target(&self, token: &str) -> Result<PathBuf> {
        let mut t = self.file_targets.lock().map_err(|_| CampusError::internal("Interner Sperrfehler."))?;
        match t.remove(token) {
            Some((p, at)) if at.elapsed() < TOKEN_TTL => Ok(p),
            _ => Err(CampusError::new(ErrorCode::AccessDenied, "Das Dateiziel ist abgelaufen. Bitte erneut auswählen.")),
        }
    }

    /// Öffnet eine Bibliothek und ersetzt die aktuelle. Vor einer Migration wird eine Sicherung erzeugt.
    pub fn open_library(&self, root: &Path, app_version: &str) -> Result<LibraryInfo> {
        let fallback = self.paths.fallback_backup_dir();
        let mut hook = |lib_root: &Path, conn: &rusqlite::Connection| -> Result<()> {
            let target = campus_core::db::get_setting(conn, "backupTarget")?
                .and_then(|v| v.as_str().map(PathBuf::from))
                .map(|p| p.join(backup::BACKUP_SUBDIR))
                .unwrap_or_else(|| fallback.clone());
            let plan = backup::prepare_snapshot(conn, lib_root)?;
            let res = backup::write_archive(lib_root, &plan, &target, "migration", app_version, &|| false);
            let _ = std::fs::remove_file(&plan.snapshot_path);
            res.map(|_| ())
        };
        // Alte Bibliothek zuerst schließen (Lock freigeben), falls derselbe Pfad erneut geöffnet wird.
        let mut guard = self.lib.lock().map_err(|_| CampusError::internal("Interner Sperrfehler."))?;
        let previous_root = guard.as_ref().map(|l| l.root.clone());
        if previous_root.as_deref() == Some(root) {
            *guard = None;
        }
        match Library::open(root, Some(&mut hook)) {
            Ok((lib, info)) => {
                *guard = Some(lib);
                *self.lib_info.lock().unwrap() = Some(info.clone());
                *self.lib_error.lock().unwrap() = None;
                if let Ok(mut s) = self.staged.lock() {
                    s.clear();
                }
                Ok(info)
            }
            Err(e) => {
                if guard.is_none() {
                    *self.lib_error.lock().unwrap() = Some(e.clone());
                }
                Err(e)
            }
        }
    }
}
