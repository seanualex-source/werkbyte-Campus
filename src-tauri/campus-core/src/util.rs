use crate::error::{CampusError, Result};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn is_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok() && s.len() == 36
}

pub fn require_uuid(s: &str, what: &str) -> Result<()> {
    if is_uuid(s) {
        Ok(())
    } else {
        Err(CampusError::invalid(format!("Ungültige ID für {what}.")))
    }
}

pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Liest eine Datei streamend und berechnet SHA-256 und Länge.
pub fn hash_file(path: &Path) -> Result<(String, u64)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

/// Schreibt Daten in eine temporäre Datei neben dem Ziel, synchronisiert und benennt atomar um.
pub fn write_atomic(target: &Path, data: &[u8]) -> Result<()> {
    let dir = target.parent().ok_or_else(|| CampusError::invalid("Zielpfad ohne Verzeichnis."))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.tmp", new_id()));
    {
        let mut f = File::create(&tmp)?;
        if let Err(e) = f.write_all(data).and_then(|_| f.sync_all()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// Namen bereinigen: Steuerzeichen entfernen, trimmen, Länge prüfen.
pub fn clean_name(name: &str, max: usize, what: &str) -> Result<String> {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
    if cleaned.is_empty() {
        return Err(CampusError::invalid(format!("{what} darf nicht leer sein.")));
    }
    if cleaned.chars().count() > max {
        return Err(CampusError::invalid(format!("{what} ist zu lang (maximal {max} Zeichen).")));
    }
    Ok(cleaned)
}

pub fn finite(v: f64, what: &str) -> Result<f64> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(CampusError::invalid(format!("{what} ist keine gültige Zahl.")))
    }
}
