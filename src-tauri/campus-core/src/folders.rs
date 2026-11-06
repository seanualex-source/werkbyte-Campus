//! Virtuelle Ordner: Anlegen, Umbenennen, Verschieben mit Zyklus- und Tiefenprüfung (F01).

use crate::error::{CampusError, Result};
use crate::limits::MAX_FOLDER_DEPTH;
use crate::model::FolderRec;
use crate::util::{clean_name, new_id, now_iso, require_uuid};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;

fn live_parent(conn: &Connection, id: &str) -> Result<Option<Option<String>>> {
    Ok(conn
        .query_row("SELECT parent_id FROM folders WHERE id=?1 AND deleted_at IS NULL", [id], |r| r.get(0))
        .optional()?)
}

/// Tiefe eines Ordners (Wurzelordner = 1).
pub fn depth(conn: &Connection, id: &str) -> Result<usize> {
    let mut d = 0;
    let mut cur = Some(id.to_string());
    while let Some(c) = cur {
        d += 1;
        if d > MAX_FOLDER_DEPTH + 1 {
            return Err(CampusError::internal("Ordnerstruktur enthält einen Zyklus."));
        }
        cur = live_parent(conn, &c)?.ok_or_else(|| CampusError::not_found("Ordner nicht gefunden."))?;
    }
    Ok(d)
}

fn subtree_height(conn: &Connection, id: &str) -> Result<usize> {
    let mut stmt = conn.prepare("SELECT id FROM folders WHERE parent_id=?1 AND deleted_at IS NULL")?;
    let children: Vec<String> = stmt.query_map([id], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    let mut max = 0;
    for c in children {
        max = max.max(subtree_height(conn, &c)?);
    }
    Ok(max + 1)
}

pub fn subtree_ids(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let mut out = vec![id.to_string()];
    let mut i = 0;
    let mut stmt = conn.prepare("SELECT id FROM folders WHERE parent_id=?1 AND deleted_at IS NULL")?;
    while i < out.len() {
        let cur = out[i].clone();
        let kids: Vec<String> = stmt.query_map([&cur], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
        out.extend(kids);
        i += 1;
    }
    Ok(out)
}

pub fn list(conn: &Connection) -> Result<Vec<FolderRec>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, name, sort_order, created_at, updated_at FROM folders
         WHERE deleted_at IS NULL ORDER BY sort_order, name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(FolderRec {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            name: r.get(2)?,
            sort_order: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn create(conn: &Connection, parent_id: Option<&str>, name: &str) -> Result<FolderRec> {
    let name = clean_name(name, 200, "Ordnername")?;
    if let Some(p) = parent_id {
        require_uuid(p, "Elternordner")?;
        if depth(conn, p)? + 1 > MAX_FOLDER_DEPTH {
            return Err(CampusError::limit(format!("Ordner dürfen höchstens {MAX_FOLDER_DEPTH} Ebenen tief sein.")));
        }
    }
    let id = new_id();
    let now = now_iso();
    let order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM folders WHERE parent_id IS ?1",
        [parent_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO folders(id, parent_id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![id, parent_id, name, order, now],
    )?;
    Ok(FolderRec { id, parent_id: parent_id.map(String::from), name, sort_order: order, created_at: now.clone(), updated_at: now })
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<()> {
    require_uuid(id, "Ordner")?;
    let name = clean_name(name, 200, "Ordnername")?;
    let n = conn.execute(
        "UPDATE folders SET name=?2, updated_at=?3 WHERE id=?1 AND deleted_at IS NULL",
        rusqlite::params![id, name, now_iso()],
    )?;
    if n == 0 {
        return Err(CampusError::not_found("Ordner nicht gefunden."));
    }
    Ok(())
}

pub fn move_to(conn: &Connection, id: &str, new_parent: Option<&str>) -> Result<()> {
    require_uuid(id, "Ordner")?;
    live_parent(conn, id)?.ok_or_else(|| CampusError::not_found("Ordner nicht gefunden."))?;
    if let Some(p) = new_parent {
        require_uuid(p, "Zielordner")?;
        let subtree = subtree_ids(conn, id)?;
        if subtree.iter().any(|s| s == p) {
            return Err(CampusError::invalid("Ein Ordner kann nicht in sich selbst oder einen Unterordner verschoben werden."));
        }
        let target_depth = depth(conn, p)?;
        if target_depth + subtree_height(conn, id)? > MAX_FOLDER_DEPTH {
            return Err(CampusError::limit(format!("Ordner dürfen höchstens {MAX_FOLDER_DEPTH} Ebenen tief sein.")));
        }
    }
    conn.execute(
        "UPDATE folders SET parent_id=?2, updated_at=?3 WHERE id=?1",
        rusqlite::params![id, new_parent, now_iso()],
    )?;
    Ok(())
}

/// Verschiebt einen Ordner samt Teilbaum und Dokumenten in den Papierkorb (ein Batch).
pub fn trash(conn: &mut Connection, id: &str) -> Result<String> {
    require_uuid(id, "Ordner")?;
    live_parent(conn, id)?.ok_or_else(|| CampusError::not_found("Ordner nicht gefunden."))?;
    let tx = conn.transaction()?;
    let ids = subtree_ids(&tx, id)?;
    let batch = new_id();
    let now = now_iso();
    for fid in &ids {
        tx.execute(
            "UPDATE folders SET deleted_at=?2, trash_batch_id=?3 WHERE id=?1 AND deleted_at IS NULL",
            rusqlite::params![fid, now, batch],
        )?;
        tx.execute(
            "UPDATE documents SET deleted_at=?2, trash_batch_id=?3 WHERE folder_id=?1 AND deleted_at IS NULL",
            rusqlite::params![fid, now, batch],
        )?;
    }
    tx.commit()?;
    Ok(batch)
}

/// Pfad (Namen) vom Wurzelordner bis zum Ordner, für Brotkrumen.
pub fn path_names(conn: &Connection, id: &str) -> Result<Vec<(String, String)>> {
    let all: HashMap<String, FolderRec> = list(conn)?.into_iter().map(|f| (f.id.clone(), f)).collect();
    let mut out = Vec::new();
    let mut cur = all.get(id);
    let mut guard = 0;
    while let Some(f) = cur {
        out.push((f.id.clone(), f.name.clone()));
        cur = f.parent_id.as_ref().and_then(|p| all.get(p));
        guard += 1;
        if guard > MAX_FOLDER_DEPTH + 1 {
            break;
        }
    }
    out.reverse();
    Ok(out)
}
