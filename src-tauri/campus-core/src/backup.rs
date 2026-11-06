//! Backup, Prüfung, Wiederherstellung und Aufbewahrung (Spezifikation §7).
//!
//! Ablauf: (1) unter Writer-Sperre konsistenten SQLite-Snapshot über die Online-Backup-API erzeugen
//! und benötigte Objekte bestimmen, (2) ohne Sperre Archiv als temporäre Datei schreiben,
//! (3) Archiv vollständig prüfen, (4) erst dann unter endgültigem Namen veröffentlichen.

use crate::db::{self, SCHEMA_VERSION};
use crate::error::{CampusError, ErrorCode, Result};
use crate::library::{DB_FILE, LIBRARY_JSON};
use crate::limits::*;
use crate::util::{is_sha256_hex, new_id};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const BACKUP_FORMAT_VERSION: i64 = 1;
pub const BACKUP_EXT: &str = "campus-backup";
pub const BACKUP_SUBDIR: &str = "werkbyte-campus-backups";
const MANIFEST: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub backup_format_version: i64,
    pub library_id: String,
    pub created_at: String,
    pub app_version: String,
    pub schema_version: i64,
    pub kind: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone)]
pub struct SnapshotPlan {
    pub snapshot_path: PathBuf,
    pub library_json_path: PathBuf,
    pub objects: Vec<(String, String, u64)>,
    pub library_id: String,
    pub schema_version: i64,
}

impl SnapshotPlan {
    pub fn hashes(&self) -> Vec<String> {
        self.objects.iter().map(|(h, _, _)| h.clone()).collect()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub file_name: String,
    pub manifest_hash: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedBackup {
    pub path: String,
    pub library_id: String,
    pub created_at: String,
    pub app_version: String,
    pub schema_version: i64,
    pub kind: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub document_count: i64,
}

fn backup_err(msg: impl Into<String>) -> CampusError {
    CampusError::new(ErrorCode::BackupInvalid, msg)
}

/// Phase 1: muss unter der Writer-Sperre laufen. Erzeugt einen konsistenten Datenbank-Snapshot.
pub fn prepare_snapshot(conn: &Connection, root: &Path) -> Result<SnapshotPlan> {
    let snap = root.join("staging").join(format!("backup-{}.sqlite", new_id()));
    {
        let mut dst = Connection::open(&snap)?;
        let backup = rusqlite::backup::Backup::new(conn, &mut dst)?;
        backup.run_to_completion(1024, Duration::from_millis(0), None)?;
    }
    let result = (|| -> Result<SnapshotPlan> {
        let snap_conn = Connection::open(&snap)?;
        // Snapshot als Einzeldatei ohne WAL ablegen.
        let _: String = snap_conn.query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0))?;
        let library_id: String = snap_conn.query_row("SELECT id FROM library_meta", [], |r| r.get(0))?;
        let schema_version = db::current_version(&snap_conn)?;
        let mut stmt = snap_conn.prepare("SELECT hash, relative_path, size_bytes FROM blobs ORDER BY hash")?;
        let objects = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? as u64)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(SnapshotPlan {
            snapshot_path: snap.clone(),
            library_json_path: root.join(LIBRARY_JSON),
            objects,
            library_id,
            schema_version,
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&snap);
    }
    result
}

struct HashingWriter<'a, W: Write> {
    inner: &'a mut W,
    hasher: Sha256,
    count: u64,
}

impl<W: Write> Write for HashingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.count += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn copy_into_zip<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    src: &Path,
    deflate: bool,
    cancel: &dyn Fn() -> bool,
) -> Result<(String, u64)> {
    let method = if deflate { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored };
    let opts = zip::write::SimpleFileOptions::default().compression_method(method).large_file(true);
    zip.start_file(name, opts)?;
    let mut input = BufReader::new(File::open(src)?);
    let mut hw = HashingWriter { inner: zip, hasher: Sha256::new(), count: 0 };
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if cancel() {
            return Err(CampusError::new(ErrorCode::Cancelled, "Backup abgebrochen."));
        }
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hw.write_all(&buf[..n])?;
    }
    Ok((hex::encode(hw.hasher.finalize()), hw.count))
}

pub fn backup_file_name(kind: &str, now: chrono::DateTime<chrono::Utc>) -> String {
    format!("campus-{kind}-{}.{BACKUP_EXT}", now.format("%Y%m%d-%H%M%S"))
}

/// Phase 2: schreibt das Archiv ohne Writer-Sperre (Objekte sind unveränderlich und gepinnt).
pub fn write_archive(
    root: &Path,
    plan: &SnapshotPlan,
    target_dir: &Path,
    kind: &str,
    app_version: &str,
    cancel: &dyn Fn() -> bool,
) -> Result<BackupResult> {
    std::fs::create_dir_all(target_dir)?;
    let now = chrono::Utc::now();
    let mut file_name = backup_file_name(kind, now);
    if target_dir.join(&file_name).exists() {
        file_name = format!("campus-{kind}-{}-{}.{BACKUP_EXT}", now.format("%Y%m%d-%H%M%S"), &new_id()[..8]);
    }
    let final_path = target_dir.join(&file_name);
    let tmp_path = target_dir.join(format!(".{file_name}.{}.tmp", &new_id()[..8]));
    let result = (|| -> Result<BackupResult> {
        let out = File::create(&tmp_path)?;
        let mut zip = zip::ZipWriter::new(BufWriter::new(out));
        let mut entries = Vec::new();
        let (h, n) = copy_into_zip(&mut zip, DB_FILE, &plan.snapshot_path, true, cancel)?;
        entries.push(ManifestEntry { path: DB_FILE.into(), size: n, sha256: h });
        let (h, n) = copy_into_zip(&mut zip, LIBRARY_JSON, &plan.library_json_path, true, cancel)?;
        entries.push(ManifestEntry { path: LIBRARY_JSON.into(), size: n, sha256: h });
        for (hash, rel, size) in &plan.objects {
            let (h, n) = copy_into_zip(&mut zip, rel, &root.join(rel), false, cancel)?;
            if &h != hash || n != *size {
                return Err(CampusError::new(
                    ErrorCode::PdfCorrupt,
                    format!("Interne Datei {rel} ist beschädigt; Backup wird nicht als erfolgreich gewertet."),
                ));
            }
            entries.push(ManifestEntry { path: rel.clone(), size: n, sha256: h });
        }
        let manifest = Manifest {
            backup_format_version: BACKUP_FORMAT_VERSION,
            library_id: plan.library_id.clone(),
            created_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            app_version: app_version.to_string(),
            schema_version: plan.schema_version,
            kind: kind.to_string(),
            file_count: entries.len() as u64,
            total_bytes: entries.iter().map(|e| e.size).sum(),
            entries,
        };
        let manifest_json = serde_json::to_vec_pretty(&manifest)?;
        zip.start_file(MANIFEST, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated))?;
        zip.write_all(&manifest_json)?;
        let writer = zip.finish()?;
        let file = writer.into_inner().map_err(|e| CampusError::from(e.into_error()))?;
        file.sync_all()?;
        drop(file);
        // Vollständige Prüfung des geschriebenen Archivs vor der Veröffentlichung.
        verify_archive(&tmp_path)?;
        std::fs::rename(&tmp_path, &final_path)?;
        Ok(BackupResult {
            path: final_path.to_string_lossy().to_string(),
            file_name: file_name.clone(),
            manifest_hash: crate::util::sha256_hex(&manifest_json),
            file_count: manifest.file_count,
            total_bytes: manifest.total_bytes,
            created_at: manifest.created_at.clone(),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

/// Strenge Prüfung von Archivpfaden: nur bekannte Muster, keine Traversal- oder absoluten Pfade.
pub fn safe_entry_name(name: &str) -> bool {
    if name == DB_FILE || name == LIBRARY_JSON || name == MANIFEST {
        return true;
    }
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() != 3 || parts[0] != "objects" {
        return false;
    }
    let prefix = parts[1];
    let file = parts[2];
    let Some((hash, ext)) = file.split_once('.') else { return false };
    prefix.len() == 2 && is_sha256_hex(hash) && hash.starts_with(prefix) && matches!(ext, "pdf" | "png" | "jpg")
}

fn read_manifest(archive: &mut zip::ZipArchive<File>) -> Result<Manifest> {
    let mut f = archive.by_name(MANIFEST).map_err(|_| backup_err("Sicherung enthält kein Manifest."))?;
    if f.size() > 64 * 1024 * 1024 {
        return Err(backup_err("Manifest ist unplausibel groß."));
    }
    let mut buf = Vec::new();
    f.by_ref().take(64 * 1024 * 1024).read_to_end(&mut buf)?;
    let m: Manifest = serde_json::from_slice(&buf).map_err(|e| backup_err(format!("Manifest unlesbar: {e}")))?;
    Ok(m)
}

fn hash_entry<R: Read>(mut r: R, limit: u64, sink: Option<&mut dyn Write>) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    let mut sink = sink;
    loop {
        let n = r.read(&mut buf).map_err(|e| backup_err(format!("Archiveintrag unlesbar oder beschädigt: {e}")))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > limit {
            return Err(backup_err("Archiveintrag ist größer als im Manifest angegeben."));
        }
        hasher.update(&buf[..n]);
        if let Some(s) = sink.as_deref_mut() {
            s.write_all(&buf[..n])?;
        }
    }
    Ok((hex::encode(hasher.finalize()), total))
}

fn check_entry_meta(f: &zip::read::ZipFile<'_, File>, expected: &ManifestEntry) -> Result<()> {
    if f.is_dir() || f.is_symlink() {
        return Err(backup_err("Sicherung enthält unzulässige Verzeichnis- oder Linkeinträge."));
    }
    if f.size() != expected.size {
        return Err(backup_err(format!("Größe von {} stimmt nicht mit dem Manifest überein.", expected.path)));
    }
    let compressed = f.compressed_size().max(1);
    if f.size() > 1024 * 1024 && f.size() / compressed > MAX_BACKUP_COMPRESSION_RATIO {
        return Err(backup_err("Unplausibles Kompressionsverhältnis im Archiv."));
    }
    Ok(())
}

/// Prüft Archivstruktur, Pfade, Größen, Prüfsummen, Formatversion und SQLite-Integrität.
pub fn verify_archive(path: &Path) -> Result<VerifiedBackup> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    if archive.len() > MAX_BACKUP_ENTRIES {
        return Err(backup_err("Sicherung enthält zu viele Einträge."));
    }
    let manifest = read_manifest(&mut archive)?;
    if manifest.backup_format_version > BACKUP_FORMAT_VERSION {
        return Err(CampusError::new(ErrorCode::SchemaTooNew, "Die Sicherung stammt aus einer neueren Campus-Version."));
    }
    if manifest.backup_format_version < 1 {
        return Err(backup_err("Unbekanntes Sicherungsformat."));
    }
    if manifest.schema_version > SCHEMA_VERSION {
        return Err(CampusError::new(ErrorCode::SchemaTooNew, "Die Sicherung enthält ein neueres Datenbankschema."));
    }
    if manifest.total_bytes > MAX_BACKUP_TOTAL_BYTES || manifest.entries.len() as u64 != manifest.file_count {
        return Err(backup_err("Manifestangaben sind unplausibel."));
    }
    let total: u64 = manifest.entries.iter().map(|e| e.size).sum();
    if total != manifest.total_bytes {
        return Err(backup_err("Manifestsumme stimmt nicht."));
    }
    let mut by_path = std::collections::HashMap::new();
    for e in &manifest.entries {
        if !safe_entry_name(&e.path) || e.path == MANIFEST || !is_sha256_hex(&e.sha256) {
            return Err(backup_err(format!("Unzulässiger Pfad im Manifest: {}", e.path)));
        }
        if by_path.insert(e.path.clone(), e.clone()).is_some() {
            return Err(backup_err("Doppelter Eintrag im Manifest."));
        }
    }
    if !by_path.contains_key(DB_FILE) || !by_path.contains_key(LIBRARY_JSON) {
        return Err(backup_err("Sicherung ist unvollständig (Datenbank oder Bibliotheksdatei fehlt)."));
    }
    let mut seen = std::collections::HashSet::new();
    let tmp_dir = std::env::temp_dir().join(format!("campus-verify-{}", new_id()));
    std::fs::create_dir_all(&tmp_dir)?;
    let result = (|| -> Result<VerifiedBackup> {
        let db_tmp = tmp_dir.join(DB_FILE);
        for i in 0..archive.len() {
            let f = archive.by_index(i)?;
            let name = f.name()?.to_string();
            if !safe_entry_name(&name) {
                return Err(backup_err(format!("Unzulässiger Archivpfad: {name}")));
            }
            if name == MANIFEST {
                continue;
            }
            let expected = by_path.get(&name).ok_or_else(|| backup_err(format!("Eintrag {name} fehlt im Manifest.")))?;
            if !seen.insert(name.clone()) {
                return Err(backup_err("Doppelter Archiveintrag."));
            }
            check_entry_meta(&f, expected)?;
            let (h, n) = if name == DB_FILE {
                let mut out = File::create(&db_tmp)?;
                let r = hash_entry(f, expected.size, Some(&mut out))?;
                out.sync_all()?;
                r
            } else {
                hash_entry(f, expected.size, None)?
            };
            if n != expected.size || h != expected.sha256 {
                return Err(backup_err(format!("Prüfsumme von {name} stimmt nicht.")));
            }
            if let Some(stem) = name.strip_prefix("objects/") {
                let hash = stem.split('/').nth(1).and_then(|f| f.split('.').next()).unwrap_or("");
                if hash != h {
                    return Err(backup_err(format!("Objekt {name} entspricht nicht seinem Namen.")));
                }
            }
        }
        if seen.len() != by_path.len() {
            return Err(backup_err("Im Archiv fehlen Dateien aus dem Manifest."));
        }
        let conn = db::open_readonly(&db_tmp)?;
        db::integrity_check(&conn)?;
        let version = db::current_version(&conn)?;
        if version > SCHEMA_VERSION {
            return Err(CampusError::new(ErrorCode::SchemaTooNew, "Die Sicherung enthält ein neueres Datenbankschema."));
        }
        let lib_id: String = conn.query_row("SELECT id FROM library_meta", [], |r| r.get(0))?;
        if lib_id != manifest.library_id {
            return Err(backup_err("Bibliotheks-ID in Manifest und Datenbank stimmen nicht überein."));
        }
        // Jede in der Datenbank bekannte Datei muss mit passender Größe enthalten sein.
        let mut stmt = conn.prepare("SELECT hash, relative_path, size_bytes FROM blobs")?;
        let blobs = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? as u64)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (hash, rel, size) in blobs {
            match by_path.get(&rel) {
                Some(e) if e.sha256 == hash && e.size == size => {}
                _ => return Err(backup_err(format!("Objekt {rel} fehlt in der Sicherung."))),
            }
        }
        let document_count: i64 = conn.query_row("SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL", [], |r| r.get(0))?;
        drop(stmt);
        drop(conn);
        Ok(VerifiedBackup {
            path: path.to_string_lossy().to_string(),
            library_id: manifest.library_id.clone(),
            created_at: manifest.created_at.clone(),
            app_version: manifest.app_version.clone(),
            schema_version: manifest.schema_version,
            kind: manifest.kind.clone(),
            file_count: manifest.file_count,
            total_bytes: manifest.total_bytes,
            document_count,
        })
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Stellt eine geprüfte Sicherung in ein NEUES Verzeichnis wieder her. Überschreibt nie bestehende Daten.
pub fn restore_archive(path: &Path, dest_root: &Path) -> Result<VerifiedBackup> {
    let verified = verify_archive(path)?;
    if dest_root.exists() && std::fs::read_dir(dest_root)?.next().is_some() {
        return Err(CampusError::invalid("Das Zielverzeichnis für die Wiederherstellung ist nicht leer."));
    }
    std::fs::create_dir_all(dest_root)?;
    let result = (|| -> Result<()> {
        let file = File::open(path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        let manifest = read_manifest(&mut archive)?;
        let by_path: std::collections::HashMap<_, _> = manifest.entries.iter().map(|e| (e.path.clone(), e.clone())).collect();
        for i in 0..archive.len() {
            let f = archive.by_index(i)?;
            let name = f.name()?.to_string();
            if name == MANIFEST {
                continue;
            }
            if !safe_entry_name(&name) {
                return Err(backup_err("Unzulässiger Archivpfad."));
            }
            let expected = by_path.get(&name).ok_or_else(|| backup_err("Eintrag fehlt im Manifest."))?;
            check_entry_meta(&f, expected)?;
            let target = dest_root.join(&name);
            // Pfade sind durch safe_entry_name auf bekannte, relative Muster beschränkt.
            if !target.starts_with(dest_root) {
                return Err(backup_err("Pfadausbruch erkannt."));
            }
            std::fs::create_dir_all(target.parent().unwrap())?;
            let part = target.with_extension("part");
            let mut out = File::create(&part)?;
            let (h, n) = hash_entry(f, expected.size, Some(&mut out))?;
            out.sync_all()?;
            drop(out);
            if h != expected.sha256 || n != expected.size {
                return Err(backup_err(format!("Prüfsumme von {name} stimmt beim Entpacken nicht.")));
            }
            std::fs::rename(&part, &target)?;
        }
        for dir in ["objects", "staging", "cache", "cache/thumbnails", "logs"] {
            std::fs::create_dir_all(dest_root.join(dir))?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(dest_root);
        return Err(e);
    }
    Ok(verified)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileInfo {
    pub path: String,
    pub file_name: String,
    pub kind: String,
    pub stamp: String,
    pub size_bytes: u64,
}

fn parse_name(name: &str) -> Option<(String, String)> {
    let stem = name.strip_suffix(&format!(".{BACKUP_EXT}"))?;
    let rest = stem.strip_prefix("campus-")?;
    let (kind, stamp) = rest.split_once('-')?;
    if !matches!(kind, "auto" | "manual" | "migration") {
        return None;
    }
    let stamp15 = stamp.get(0..15)?;
    if stamp15.len() != 15 || stamp15.as_bytes()[8] != b'-' {
        return None;
    }
    Some((kind.to_string(), stamp15.to_string()))
}

pub fn list_backups(dir: &Path) -> Result<Vec<BackupFileInfo>> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(out) };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some((kind, stamp)) = parse_name(&name) {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(BackupFileInfo { path: e.path().to_string_lossy().to_string(), file_name: name, kind, stamp, size_bytes: size });
        }
    }
    out.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    Ok(out)
}

/// Aufbewahrung: 7 tägliche und 4 wöchentliche automatische Sicherungen. Manuelle und
/// Migrationssicherungen werden nie automatisch gelöscht. Gelöscht werden nur Dateien,
/// deren Manifest lesbar ist (also von Campus erzeugte Sicherungen).
pub fn apply_retention(dir: &Path, keep_daily: usize, keep_weekly: usize) -> Result<Vec<String>> {
    let autos: Vec<BackupFileInfo> = list_backups(dir)?.into_iter().filter(|b| b.kind == "auto").collect();
    let mut keep = std::collections::HashSet::new();
    let mut days = Vec::new();
    let mut weeks = Vec::new();
    for b in &autos {
        let day = b.stamp[0..8].to_string();
        if days.len() < keep_daily && !days.contains(&day) {
            days.push(day);
            keep.insert(b.path.clone());
        }
        if let Ok(d) = chrono::NaiveDate::parse_from_str(&b.stamp[0..8], "%Y%m%d") {
            use chrono::Datelike;
            let w = format!("{}-{}", d.iso_week().year(), d.iso_week().week());
            if weeks.len() < keep_weekly && !weeks.contains(&w) {
                weeks.push(w);
                keep.insert(b.path.clone());
            }
        }
    }
    let mut deleted = Vec::new();
    for b in autos {
        if keep.contains(&b.path) {
            continue;
        }
        let recognised = File::open(&b.path)
            .ok()
            .and_then(|f| zip::ZipArchive::new(f).ok())
            .map(|mut a| read_manifest(&mut a).is_ok())
            .unwrap_or(false);
        if recognised && std::fs::remove_file(&b.path).is_ok() {
            deleted.push(b.path);
        }
    }
    Ok(deleted)
}
