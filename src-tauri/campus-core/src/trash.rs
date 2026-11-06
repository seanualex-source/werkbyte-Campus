//! Papierkorb: Auflisten, Wiederherstellen, endgültiges Löschen (F17, §3.3, §6.4).

use crate::error::{CampusError, Result};
use crate::model::{TrashItem, TrashSummary};
use crate::util::{new_id, now_iso, require_uuid};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub const RECOVERY_FOLDER_NAME: &str = "Wiederhergestellt";

pub fn list(conn: &Connection) -> Result<Vec<TrashItem>> {
    let mut items = Vec::new();
    // Oberste Ordner eines Batches: Elternordner gehört nicht zum selben Batch.
    let mut stmt = conn.prepare(
        "SELECT f.trash_batch_id, f.deleted_at, f.id, f.name FROM folders f
         WHERE f.deleted_at IS NOT NULL AND (f.parent_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM folders p WHERE p.id=f.parent_id AND p.trash_batch_id = f.trash_batch_id))
         ORDER BY f.deleted_at DESC",
    )?;
    let rows: Vec<(String, String, String, String)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<std::result::Result<_, _>>()?;
    for (batch, at, id, name) in rows {
        let fc: i64 = conn.query_row("SELECT COUNT(*) FROM folders WHERE trash_batch_id=?1", [&batch], |r| r.get(0))?;
        let dc: i64 = conn.query_row("SELECT COUNT(*) FROM documents WHERE trash_batch_id=?1", [&batch], |r| r.get(0))?;
        items.push(TrashItem { batch_id: batch, deleted_at: at, kind: "folder".into(), id, name, folder_count: fc, document_count: dc });
    }
    let mut stmt = conn.prepare(
        "SELECT d.trash_batch_id, d.deleted_at, d.id, d.title FROM documents d
         WHERE d.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.trash_batch_id = d.trash_batch_id)
         ORDER BY d.deleted_at DESC",
    )?;
    let rows: Vec<(String, String, String, String)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<std::result::Result<_, _>>()?;
    for (batch, at, id, name) in rows {
        items.push(TrashItem { batch_id: batch, deleted_at: at, kind: "document".into(), id, name, folder_count: 0, document_count: 1 });
    }
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(items)
}

fn recovery_folder(tx: &Transaction<'_>) -> Result<String> {
    if let Some(id) = tx
        .query_row(
            "SELECT id FROM folders WHERE parent_id IS NULL AND name=?1 AND deleted_at IS NULL",
            [RECOVERY_FOLDER_NAME],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let id = new_id();
    let now = now_iso();
    tx.execute(
        "INSERT INTO folders(id, parent_id, name, sort_order, created_at, updated_at) VALUES (?1, NULL, ?2, 9999, ?3, ?3)",
        params![id, RECOVERY_FOLDER_NAME, now],
    )?;
    Ok(id)
}

fn folder_is_live(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    Ok(tx
        .query_row("SELECT 1 FROM folders WHERE id=?1 AND deleted_at IS NULL", [id], |r| r.get::<_, i64>(0))
        .optional()?
        .is_some())
}

/// Stellt einen Batch wieder her. Fehlt der ursprüngliche Elternordner, landet der Inhalt
/// im Ordner „Wiederhergestellt“.
pub fn restore(conn: &mut Connection, batch: &str) -> Result<()> {
    require_uuid(batch, "Papierkorbeintrag")?;
    let tx = conn.transaction()?;
    let mut stmt = tx.prepare("SELECT id, parent_id, orphaned FROM folders WHERE trash_batch_id=?1")?;
    let folders: Vec<(String, Option<String>, bool)> = stmt
        .query_map([batch], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? == 1)))?
        .collect::<std::result::Result<_, _>>()?;
    drop(stmt);
    let mut stmt = tx.prepare("SELECT id, folder_id, orphaned FROM documents WHERE trash_batch_id=?1")?;
    let docs: Vec<(String, Option<String>, bool)> = stmt
        .query_map([batch], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? == 1)))?
        .collect::<std::result::Result<_, _>>()?;
    drop(stmt);
    if folders.is_empty() && docs.is_empty() {
        return Err(CampusError::not_found("Papierkorbeintrag nicht gefunden."));
    }
    let batch_folder_ids: Vec<&String> = folders.iter().map(|(id, _, _)| id).collect();
    tx.execute("UPDATE folders SET deleted_at=NULL, trash_batch_id=NULL, orphaned=0 WHERE trash_batch_id=?1", [batch])?;
    tx.execute("UPDATE documents SET deleted_at=NULL, trash_batch_id=NULL, orphaned=0 WHERE trash_batch_id=?1", [batch])?;
    // Ursprünglicher Elternordner, sonst Wiederherstellungsordner (auch wenn der Elternordner
    // inzwischen endgültig gelöscht wurde).
    for (id, parent, orphaned) in &folders {
        let lost = match parent {
            Some(p) => !batch_folder_ids.contains(&p) && !folder_is_live(&tx, p)?,
            None => *orphaned,
        };
        if lost {
            let r = recovery_folder(&tx)?;
            tx.execute("UPDATE folders SET parent_id=?2 WHERE id=?1", params![id, r])?;
        }
    }
    for (id, folder, orphaned) in &docs {
        let lost = match folder {
            Some(f) => !folder_is_live(&tx, f)?,
            None => *orphaned,
        };
        if lost {
            let r = recovery_folder(&tx)?;
            tx.execute("UPDATE documents SET folder_id=?2 WHERE id=?1", params![id, r])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn summary(conn: &Connection) -> Result<TrashSummary> {
    let batch_count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT trash_batch_id) FROM (SELECT trash_batch_id FROM folders WHERE trash_batch_id IS NOT NULL
         UNION ALL SELECT trash_batch_id FROM documents WHERE trash_batch_id IS NOT NULL)",
        [],
        |r| r.get(0),
    )?;
    let folder_count: i64 = conn.query_row("SELECT COUNT(*) FROM folders WHERE deleted_at IS NOT NULL", [], |r| r.get(0))?;
    let document_count: i64 = conn.query_row("SELECT COUNT(*) FROM documents WHERE deleted_at IS NOT NULL", [], |r| r.get(0))?;
    // Geschätzt frei werdender Speicher: Objekte, die nur von Papierkorb-Dokumenten referenziert werden.
    let freed: i64 = conn.query_row(
        "WITH trashed AS (SELECT id FROM documents WHERE deleted_at IS NOT NULL),
              live AS (SELECT id FROM documents WHERE deleted_at IS NULL),
              hashes_of(doc, hash) AS (
                SELECT p.document_id, s.blob_hash FROM pages p JOIN pdf_sources s ON s.id = p.source_id
                UNION SELECT p.document_id, r.blob_hash FROM asset_refs r JOIN annotations a ON a.id=r.annotation_id JOIN pages p ON p.id=a.page_id)
         SELECT COALESCE(SUM(b.size_bytes), 0) FROM blobs b WHERE
           b.hash IN (SELECT hash FROM hashes_of WHERE doc IN (SELECT id FROM trashed))
           AND b.hash NOT IN (SELECT hash FROM hashes_of WHERE doc IN (SELECT id FROM live))",
        [],
        |r| r.get(0),
    )?;
    Ok(TrashSummary { batch_count, folder_count, document_count, freed_bytes_estimate: freed })
}

fn purge_batch(tx: &Transaction<'_>, batch: &str) -> Result<()> {
    // Elemente anderer Batches, deren Elternordner hier endgültig gelöscht wird, an die Wurzel hängen,
    // damit sie unabhängig wiederherstellbar bleiben.
    tx.execute(
        "UPDATE folders SET parent_id=NULL, orphaned=1 WHERE parent_id IN (SELECT id FROM folders WHERE trash_batch_id=?1)
         AND (trash_batch_id IS NULL OR trash_batch_id <> ?1)",
        [batch],
    )?;
    tx.execute(
        "UPDATE documents SET folder_id=NULL, orphaned=1 WHERE folder_id IN (SELECT id FROM folders WHERE trash_batch_id=?1)
         AND (trash_batch_id IS NULL OR trash_batch_id <> ?1)",
        [batch],
    )?;
    tx.execute("DELETE FROM documents WHERE trash_batch_id=?1", [batch])?;
    // Ordner von unten nach oben löschen (Kaskade greift innerhalb des Batches).
    tx.execute("DELETE FROM folders WHERE trash_batch_id=?1", [batch])?;
    Ok(())
}

pub fn cleanup_orphan_sources(tx: &Transaction<'_>) -> Result<()> {
    tx.execute(
        "DELETE FROM pdf_sources WHERE id NOT IN (SELECT source_id FROM pages WHERE source_id IS NOT NULL)
         AND id NOT IN (SELECT source_id FROM form_groups)",
        [],
    )?;
    Ok(())
}

pub fn purge(conn: &mut Connection, batch: &str) -> Result<()> {
    require_uuid(batch, "Papierkorbeintrag")?;
    let tx = conn.transaction()?;
    purge_batch(&tx, batch)?;
    cleanup_orphan_sources(&tx)?;
    tx.commit()?;
    Ok(())
}

pub fn empty(conn: &mut Connection) -> Result<usize> {
    let tx = conn.transaction()?;
    let mut stmt = tx.prepare(
        "SELECT DISTINCT trash_batch_id FROM folders WHERE trash_batch_id IS NOT NULL
         UNION SELECT DISTINCT trash_batch_id FROM documents WHERE trash_batch_id IS NOT NULL",
    )?;
    let batches: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    drop(stmt);
    for b in &batches {
        purge_batch(&tx, b)?;
    }
    cleanup_orphan_sources(&tx)?;
    tx.commit()?;
    Ok(batches.len())
}
