//! SQLite-Verbindung und Migrationsrunner (Spezifikation §6.1, §7.5).

use crate::error::{CampusError, ErrorCode, Result};
use crate::util::{now_iso, sha256_hex};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::Path;
use std::time::Duration;

pub const SCHEMA_VERSION: i64 = 1;

pub const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../../migrations/001_initial.sql"))];

pub fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(CampusError::internal(format!("WAL-Modus konnte nicht aktiviert werden ({mode}).")));
    }
    conn.pragma_update(None, "synchronous", "FULL")?;
    let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    if fk != 1 {
        return Err(CampusError::internal("Fremdschlüssel konnten nicht aktiviert werden."));
    }
    Ok(())
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    Ok(conn)
}

pub fn open_readonly(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

fn ensure_migration_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );",
    )?;
    Ok(())
}

pub fn current_version(conn: &Connection) -> Result<i64> {
    let exists: Option<String> = conn
        .query_row("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'", [], |r| r.get(0))
        .optional()?;
    if exists.is_none() {
        return Ok(0);
    }
    Ok(conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))?)
}

/// Prüft, ob die Datenbank eine unterstützte Version hat, und ob Migrationen ausstehen.
pub fn pending_migrations(conn: &Connection) -> Result<Vec<i64>> {
    let current = current_version(conn)?;
    if current > SCHEMA_VERSION {
        return Err(CampusError::new(
            ErrorCode::SchemaTooNew,
            format!(
                "Die Bibliothek wurde mit einer neueren Campus-Version erstellt (Schema {current}, unterstützt {SCHEMA_VERSION}). Bitte Campus aktualisieren."
            ),
        ));
    }
    Ok(MIGRATIONS.iter().filter(|(v, _)| *v > current).map(|(v, _)| *v).collect())
}

/// Wendet alle ausstehenden Migrationen in je einer Transaktion an und prüft Prüfsummen bereits angewandter.
pub fn migrate(conn: &mut Connection) -> Result<Vec<i64>> {
    ensure_migration_table(conn)?;
    let pending = pending_migrations(conn)?;
    // Bereits angewandte Migrationen müssen zur ausgelieferten Fassung passen.
    {
        let mut stmt = conn.prepare("SELECT version, checksum FROM schema_migrations")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (version, checksum) = row?;
            if let Some((_, sql)) = MIGRATIONS.iter().find(|(v, _)| *v == version) {
                if sha256_hex(sql.as_bytes()) != checksum {
                    return Err(CampusError::internal(format!(
                        "Migration {version} weicht von der ausgelieferten Fassung ab."
                    )));
                }
            }
        }
    }
    for version in &pending {
        let sql = MIGRATIONS.iter().find(|(v, _)| v == version).map(|(_, s)| *s).unwrap();
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![version, sha256_hex(sql.as_bytes()), now_iso()],
        )?;
        tx.commit()?;
    }
    Ok(pending)
}

/// Vollständige Integritätsprüfung (für Restore und Migration).
pub fn integrity_check(conn: &Connection) -> Result<()> {
    let result: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if result != "ok" {
        return Err(CampusError::new(ErrorCode::BackupInvalid, format!("SQLite-Integritätsprüfung fehlgeschlagen: {result}")));
    }
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let mut rows = stmt.query([])?;
    if rows.next()?.is_some() {
        return Err(CampusError::new(ErrorCode::BackupInvalid, "Fremdschlüsselprüfung fehlgeschlagen."));
    }
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<serde_json::Value>> {
    let raw: Option<String> =
        conn.query_row("SELECT value_json FROM settings WHERE key=?1", [key], |r| r.get(0)).optional()?;
    Ok(match raw {
        Some(s) => Some(serde_json::from_str(&s)?),
        None => None,
    })
}

pub fn set_setting(conn: &Connection, key: &str, value: &serde_json::Value) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value_json) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        rusqlite::params![key, value.to_string()],
    )?;
    Ok(())
}
