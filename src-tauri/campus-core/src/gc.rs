//! Verzögerte Bereinigung nicht mehr referenzierter Objektdateien (§6.2, §6.4).
//! Löscht frühestens nach der Sicherheitsfrist und nie gepinnte Objekte (laufende Exporte/Backups).

use crate::error::Result;
use crate::limits::GC_GRACE_DAYS;
use crate::util::now_iso;
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct GcReport {
    pub marked: usize,
    pub deleted: usize,
    pub stray_files_deleted: usize,
}

pub fn sweep(conn: &Connection, root: &Path, pinned: &HashSet<String>) -> Result<GcReport> {
    let mut report = GcReport::default();
    let referenced: HashSet<String> = {
        let mut stmt = conn.prepare(
            "SELECT blob_hash FROM pdf_sources UNION SELECT blob_hash FROM asset_refs",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(GC_GRACE_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let rows: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT hash, relative_path, unreferenced_since FROM blobs")?;
        let r = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        r.collect::<std::result::Result<_, _>>()?
    };
    let mut known_paths = HashSet::new();
    for (hash, rel, since) in rows {
        known_paths.insert(rel.clone());
        if referenced.contains(&hash) {
            if since.is_some() {
                conn.execute("UPDATE blobs SET unreferenced_since=NULL WHERE hash=?1", [&hash])?;
            }
            continue;
        }
        match since {
            None => {
                conn.execute("UPDATE blobs SET unreferenced_since=?2 WHERE hash=?1", rusqlite::params![hash, now_iso()])?;
                report.marked += 1;
            }
            Some(s) if s < cutoff && !pinned.contains(&hash) => {
                conn.execute("DELETE FROM blobs WHERE hash=?1", [&hash])?;
                let _ = std::fs::remove_file(root.join(&rel));
                report.deleted += 1;
            }
            _ => {}
        }
    }
    // Objektdateien ohne Datenbankzeile (z. B. Abbruch zwischen Veröffentlichung und Commit)
    // erst nach der Sicherheitsfrist entfernen.
    let grace = std::time::Duration::from_secs((GC_GRACE_DAYS as u64) * 86_400);
    if let Ok(dirs) = std::fs::read_dir(root.join("objects")) {
        for d in dirs.flatten() {
            if let Ok(files) = std::fs::read_dir(d.path()) {
                for f in files.flatten() {
                    let p = f.path();
                    let rel = format!(
                        "objects/{}/{}",
                        d.file_name().to_string_lossy(),
                        f.file_name().to_string_lossy()
                    );
                    if known_paths.contains(&rel) {
                        continue;
                    }
                    let hash = f.file_name().to_string_lossy().split('.').next().unwrap_or("").to_string();
                    if pinned.contains(&hash) {
                        continue;
                    }
                    let old = f
                        .metadata()
                        .and_then(|m| m.modified())
                        .map(|t| t.elapsed().map(|e| e > grace).unwrap_or(false))
                        .unwrap_or(false);
                    if old && std::fs::remove_file(&p).is_ok() {
                        report.stray_files_deleted += 1;
                    }
                }
            }
        }
    }
    Ok(report)
}
