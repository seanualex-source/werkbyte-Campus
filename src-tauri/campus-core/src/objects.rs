//! Inhaltsadressierter, unveränderlicher Objektspeicher mit Staging (Spezifikation §6.2).
//! Reihenfolge: Datei vollständig schreiben und veröffentlichen, erst danach Datenbankeintrag.

use crate::error::{CampusError, ErrorCode, Result};
use crate::util::{hash_file, is_sha256_hex, new_id, now_iso};
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobKind {
    Pdf,
    Png,
    Jpeg,
}

impl BlobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BlobKind::Pdf => "pdf",
            BlobKind::Png => "png",
            BlobKind::Jpeg => "jpeg",
        }
    }
    pub fn ext(self) -> &'static str {
        match self {
            BlobKind::Pdf => "pdf",
            BlobKind::Png => "png",
            BlobKind::Jpeg => "jpg",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pdf" => Some(BlobKind::Pdf),
            "png" => Some(BlobKind::Png),
            "jpeg" => Some(BlobKind::Jpeg),
            _ => None,
        }
    }
}

pub fn sniff_kind(head: &[u8]) -> Option<BlobKind> {
    if head.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(BlobKind::Png);
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(BlobKind::Jpeg);
    }
    // PDF-Kopf darf laut Praxis innerhalb der ersten 1024 Bytes stehen.
    let window = &head[..head.len().min(1024)];
    if window.windows(5).any(|w| w == b"%PDF-") {
        return Some(BlobKind::Pdf);
    }
    None
}

pub fn object_rel_path(hash: &str, kind: BlobKind) -> String {
    format!("objects/{}/{}.{}", &hash[0..2], hash, kind.ext())
}

#[derive(Debug, Clone)]
pub struct StagedFile {
    pub id: String,
    pub path: PathBuf,
    pub hash: String,
    pub size: u64,
    pub original_name: String,
    pub kind: BlobKind,
}

/// Kopiert eine externe Datei streamend nach `staging/`, berechnet dabei den Hash und synchronisiert.
pub fn stage_from_path(
    root: &Path,
    src: &Path,
    expected: &[BlobKind],
    max_size: u64,
    cancel: &dyn Fn() -> bool,
) -> Result<StagedFile> {
    let meta = std::fs::metadata(src)?;
    if !meta.is_file() {
        return Err(CampusError::invalid("Es können nur Dateien importiert werden."));
    }
    if meta.len() > max_size {
        return Err(CampusError::limit(format!(
            "Die Datei ist größer als {} MiB.",
            max_size / (1024 * 1024)
        )));
    }
    let mut input = File::open(src)?;
    let id = new_id();
    let part = root.join("staging").join(format!("{id}.part"));
    let result = (|| -> Result<(String, u64, Option<BlobKind>)> {
        let mut out = File::create(&part)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut total = 0u64;
        let mut head: Vec<u8> = Vec::with_capacity(1024);
        loop {
            if cancel() {
                return Err(CampusError::new(ErrorCode::Cancelled, "Import abgebrochen."));
            }
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            if head.len() < 1024 {
                let take = (1024 - head.len()).min(n);
                head.extend_from_slice(&buf[..take]);
            }
            total += n as u64;
            if total > max_size {
                return Err(CampusError::limit("Die Datei ist während des Kopierens über das Limit gewachsen."));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
        }
        out.sync_all()?;
        Ok((hex::encode(hasher.finalize()), total, sniff_kind(&head)))
    })();
    let (hash, size, kind) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
    };
    let kind = match kind {
        Some(k) if expected.contains(&k) => k,
        _ => {
            let _ = std::fs::remove_file(&part);
            return Err(CampusError::new(ErrorCode::PdfUnsupported, "Der Dateityp wird nicht unterstützt."));
        }
    };
    let staged = root.join("staging").join(format!("{id}.{}", kind.ext()));
    std::fs::rename(&part, &staged)?;
    let original_name = src.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Datei".into());
    Ok(StagedFile { id, path: staged, hash, size, original_name, kind })
}

/// Legt Bytes (z. B. ein normalisiertes Bild) im Staging ab.
pub fn stage_from_bytes(root: &Path, data: &[u8], original_name: &str, kind: BlobKind) -> Result<StagedFile> {
    let id = new_id();
    let part = root.join("staging").join(format!("{id}.part"));
    {
        let mut f = File::create(&part)?;
        if let Err(e) = f.write_all(data).and_then(|_| f.sync_all()) {
            let _ = std::fs::remove_file(&part);
            return Err(e.into());
        }
    }
    let staged = root.join("staging").join(format!("{id}.{}", kind.ext()));
    std::fs::rename(&part, &staged)?;
    Ok(StagedFile {
        id,
        path: staged,
        hash: crate::util::sha256_hex(data),
        size: data.len() as u64,
        original_name: original_name.to_string(),
        kind,
    })
}

/// Veröffentlicht eine Staging-Datei unter ihrem Hash. Vorhandene Objekte werden auf Länge
/// und Integrität geprüft und nur bei Beschädigung ersetzt.
pub fn publish(root: &Path, staged: &StagedFile) -> Result<String> {
    let rel = object_rel_path(&staged.hash, staged.kind);
    let dest = root.join(&rel);
    if dest.exists() {
        let (hash, len) = hash_file(&dest)?;
        if hash == staged.hash && len == staged.size {
            std::fs::remove_file(&staged.path)?;
            return Ok(rel);
        }
        // Beschädigtes Objekt wird durch die geprüfte Staging-Kopie ersetzt (Reparatur).
    }
    std::fs::create_dir_all(dest.parent().unwrap())?;
    std::fs::rename(&staged.path, &dest)?;
    Ok(rel)
}

pub fn ensure_blob_row(conn: &Connection, hash: &str, kind: BlobKind, size: u64, rel: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO blobs(hash, kind, size_bytes, relative_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(hash) DO UPDATE SET unreferenced_since = NULL",
        rusqlite::params![hash, kind.as_str(), size as i64, rel, now_iso()],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct BlobInfo {
    pub hash: String,
    pub kind: BlobKind,
    pub size: u64,
    pub relative_path: String,
}

pub fn blob_info(conn: &Connection, hash: &str) -> Result<Option<BlobInfo>> {
    if !is_sha256_hex(hash) {
        return Err(CampusError::invalid("Ungültige Objektreferenz."));
    }
    let row = conn
        .query_row("SELECT kind, size_bytes, relative_path FROM blobs WHERE hash=?1", [hash], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        })
        .optional()?;
    Ok(row.and_then(|(k, s, p)| {
        BlobKind::parse(&k).map(|kind| BlobInfo { hash: hash.to_string(), kind, size: s as u64, relative_path: p })
    }))
}

/// Liest ein Objekt vollständig und prüft Länge und Prüfsumme. Eine veränderte oder fehlende
/// Datei führt zu einem expliziten Fehler statt zu einer leeren Seite.
pub fn read_blob(conn: &Connection, root: &Path, hash: &str) -> Result<(Vec<u8>, BlobKind)> {
    let info = blob_info(conn, hash)?.ok_or_else(|| CampusError::not_found("Objekt ist in der Bibliothek nicht bekannt."))?;
    let path = root.join(&info.relative_path);
    let data = std::fs::read(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CampusError::new(
                ErrorCode::FileMissing,
                "Eine interne Originaldatei fehlt. Bitte die Bibliothek aus einem Backup wiederherstellen.",
            )
        } else {
            e.into()
        }
    })?;
    if data.len() as u64 != info.size || crate::util::sha256_hex(&data) != hash {
        return Err(CampusError::new(
            ErrorCode::PdfCorrupt,
            "Eine interne Originaldatei wurde verändert oder ist beschädigt. Bitte aus einem Backup wiederherstellen.",
        ));
    }
    Ok((data, info.kind))
}
