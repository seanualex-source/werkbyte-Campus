//! Dokumente: Liste, Anlegen, Laden als Snapshot, Umbenennen, Verschieben, Papierkorb (F03, F05, F12).

use crate::error::{CampusError, Result};
use crate::model::*;
use crate::util::{clean_name, new_id, now_iso, require_uuid};
use crate::validate::validate_background;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub const A4_W: f64 = 595.2756;
pub const A4_H: f64 = 841.8898;

#[derive(Debug, Clone)]
pub enum ListFilter {
    All,
    Root,
    Folder(String),
    Recent,
}

const SUMMARY_SQL: &str = "SELECT d.id, d.folder_id, d.title, d.revision, d.created_at, d.updated_at, d.last_opened_at,
    (SELECT COUNT(*) FROM pages p WHERE p.document_id = d.id) FROM documents d";

fn map_summary(r: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentSummary> {
    Ok(DocumentSummary {
        id: r.get(0)?,
        folder_id: r.get(1)?,
        title: r.get(2)?,
        revision: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        last_opened_at: r.get(6)?,
        page_count: r.get(7)?,
    })
}

pub fn list(conn: &Connection, filter: &ListFilter, query: Option<&str>) -> Result<Vec<DocumentSummary>> {
    let q = query.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    let mut docs: Vec<DocumentSummary> = match filter {
        ListFilter::All => {
            let mut s = conn.prepare(&format!("{SUMMARY_SQL} WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC"))?;
            let rows = s.query_map([], map_summary)?;
            rows.collect::<std::result::Result<_, _>>()?
        }
        ListFilter::Root => {
            let mut s = conn.prepare(&format!(
                "{SUMMARY_SQL} WHERE d.deleted_at IS NULL AND d.folder_id IS NULL ORDER BY d.title COLLATE NOCASE"
            ))?;
            let rows = s.query_map([], map_summary)?;
            rows.collect::<std::result::Result<_, _>>()?
        }
        ListFilter::Folder(id) => {
            require_uuid(id, "Ordner")?;
            let mut s = conn.prepare(&format!(
                "{SUMMARY_SQL} WHERE d.deleted_at IS NULL AND d.folder_id=?1 ORDER BY d.title COLLATE NOCASE"
            ))?;
            let rows = s.query_map([id], map_summary)?;
            rows.collect::<std::result::Result<_, _>>()?
        }
        ListFilter::Recent => {
            let mut s = conn.prepare(&format!(
                "{SUMMARY_SQL} WHERE d.deleted_at IS NULL AND d.last_opened_at IS NOT NULL ORDER BY d.last_opened_at DESC LIMIT 30"
            ))?;
            let rows = s.query_map([], map_summary)?;
            rows.collect::<std::result::Result<_, _>>()?
        }
    };
    if let Some(q) = q {
        docs.retain(|d| d.title.to_lowercase().contains(&q));
    }
    Ok(docs)
}

pub fn summary(conn: &Connection, id: &str) -> Result<DocumentSummary> {
    require_uuid(id, "Dokument")?;
    conn.query_row(&format!("{SUMMARY_SQL} WHERE d.id=?1 AND d.deleted_at IS NULL"), [id], map_summary)
        .optional()?
        .ok_or_else(|| CampusError::not_found("Dokument nicht gefunden."))
}

fn check_folder(conn: &Connection, folder_id: Option<&str>) -> Result<()> {
    if let Some(f) = folder_id {
        require_uuid(f, "Ordner")?;
        let ok: Option<i64> = conn
            .query_row("SELECT 1 FROM folders WHERE id=?1 AND deleted_at IS NULL", [f], |r| r.get(0))
            .optional()?;
        if ok.is_none() {
            return Err(CampusError::not_found("Zielordner nicht gefunden."));
        }
    }
    Ok(())
}

/// Bei gleichen Namen im selben Ordner wird eine sichtbare Nummer angehängt (§3.3).
pub fn unique_title(conn: &Connection, folder_id: Option<&str>, title: &str) -> Result<String> {
    let base = clean_name(title, 280, "Titel")?;
    let mut stmt = conn.prepare("SELECT title FROM documents WHERE folder_id IS ?1 AND deleted_at IS NULL")?;
    let existing: Vec<String> = stmt.query_map([folder_id], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    if !existing.iter().any(|t| t == &base) {
        return Ok(base);
    }
    for n in 2..10_000 {
        let candidate = format!("{base} ({n})");
        if !existing.iter().any(|t| t == &candidate) {
            return Ok(candidate);
        }
    }
    Ok(format!("{base} ({})", new_id()))
}

pub fn insert_document(conn: &Connection, folder_id: Option<&str>, title: &str) -> Result<String> {
    check_folder(conn, folder_id)?;
    let title = unique_title(conn, folder_id, title)?;
    let id = new_id();
    let now = now_iso();
    conn.execute(
        "INSERT INTO documents(id, folder_id, title, revision, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
        params![id, folder_id, title, now],
    )?;
    Ok(id)
}

pub fn default_background(kind: &str) -> Value {
    serde_json::json!({ "type": kind, "spacingPt": if kind == "grid" { 14.17 } else { 22.0 }, "color": "#B9C3CE", "lineWidthPt": 0.5 })
}

pub fn create_note(conn: &mut Connection, folder_id: Option<&str>, title: &str, paper: &NotePaper) -> Result<String> {
    let bg = validate_background(&paper.background)?;
    let (w, h) = if paper.orientation == "landscape" { (A4_H, A4_W) } else { (A4_W, A4_H) };
    let tx = conn.transaction()?;
    let id = insert_document(&tx, folder_id, title)?;
    tx.execute(
        "INSERT INTO pages(id, document_id, position, kind, width_pt, height_pt, rotation, background_json)
         VALUES (?1, ?2, 0, 'note', ?3, ?4, 0, ?5)",
        params![new_id(), id, w, h, bg.to_string()],
    )?;
    tx.commit()?;
    Ok(id)
}

pub fn rename(conn: &Connection, id: &str, title: &str) -> Result<()> {
    require_uuid(id, "Dokument")?;
    let title = clean_name(title, 300, "Titel")?;
    let n = conn.execute(
        "UPDATE documents SET title=?2, updated_at=?3, revision=revision+1 WHERE id=?1 AND deleted_at IS NULL",
        params![id, title, now_iso()],
    )?;
    if n == 0 {
        return Err(CampusError::not_found("Dokument nicht gefunden."));
    }
    Ok(())
}

pub fn move_to(conn: &Connection, id: &str, folder_id: Option<&str>) -> Result<()> {
    require_uuid(id, "Dokument")?;
    check_folder(conn, folder_id)?;
    let n = conn.execute(
        "UPDATE documents SET folder_id=?2, updated_at=?3 WHERE id=?1 AND deleted_at IS NULL",
        params![id, folder_id, now_iso()],
    )?;
    if n == 0 {
        return Err(CampusError::not_found("Dokument nicht gefunden."));
    }
    Ok(())
}

pub fn trash(conn: &Connection, id: &str) -> Result<String> {
    require_uuid(id, "Dokument")?;
    let batch = new_id();
    let n = conn.execute(
        "UPDATE documents SET deleted_at=?2, trash_batch_id=?3 WHERE id=?1 AND deleted_at IS NULL",
        params![id, now_iso(), batch],
    )?;
    if n == 0 {
        return Err(CampusError::not_found("Dokument nicht gefunden."));
    }
    Ok(batch)
}

pub fn mark_opened(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("UPDATE documents SET last_opened_at=?2 WHERE id=?1", params![id, now_iso()])?;
    Ok(())
}

pub fn set_view(conn: &Connection, id: &str, view: &ViewRec) -> Result<()> {
    require_uuid(id, "Dokument")?;
    if !(view.zoom.is_finite() && view.zoom > 0.05 && view.zoom < 20.0 && view.scroll_offset.is_finite()) {
        return Err(CampusError::invalid("Ungültiger Ansichtsstand."));
    }
    conn.execute(
        "INSERT INTO document_views(document_id, page_id, zoom, scroll_offset) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(document_id) DO UPDATE SET page_id=excluded.page_id, zoom=excluded.zoom, scroll_offset=excluded.scroll_offset",
        params![id, view.page_id, view.zoom, view.scroll_offset],
    )?;
    Ok(())
}

pub fn load_pages(conn: &Connection, document_id: &str) -> Result<Vec<PageRec>> {
    let mut stmt = conn.prepare(
        "SELECT id, position, kind, source_id, source_page_index, width_pt, height_pt, rotation, background_json
         FROM pages WHERE document_id=?1 ORDER BY position",
    )?;
    let rows = stmt.query_map([document_id], |r| {
        let bg: Option<String> = r.get(8)?;
        Ok(PageRec {
            id: r.get(0)?,
            position: r.get(1)?,
            kind: r.get(2)?,
            source_id: r.get(3)?,
            source_page_index: r.get(4)?,
            width_pt: r.get(5)?,
            height_pt: r.get(6)?,
            rotation: r.get(7)?,
            background: bg.and_then(|s| serde_json::from_str(&s).ok()),
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn load_annotations_for_page(conn: &Connection, page_id: &str) -> Result<Vec<AnnotationRec>> {
    let mut stmt = conn.prepare(
        "SELECT id, page_id, kind, z_index, payload_version, payload_json FROM annotations WHERE page_id=?1 ORDER BY z_index, id",
    )?;
    let rows = stmt.query_map([page_id], map_annotation)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn map_annotation(r: &rusqlite::Row<'_>) -> rusqlite::Result<AnnotationRec> {
    let payload: String = r.get(5)?;
    Ok(AnnotationRec {
        id: r.get(0)?,
        page_id: r.get(1)?,
        kind: r.get(2)?,
        z_index: r.get(3)?,
        payload_version: r.get(4)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
    })
}

fn map_widget(r: &rusqlite::Row<'_>) -> rusqlite::Result<WidgetRec> {
    let g: String = r.get(5)?;
    Ok(WidgetRec {
        id: r.get(0)?,
        page_id: r.get(1)?,
        group_id: r.get(2)?,
        field_key: r.get(3)?,
        source_widget_key: r.get(4)?,
        geometry: serde_json::from_str(&g).unwrap_or(Value::Null),
    })
}

pub fn load_widgets_for_page(conn: &Connection, page_id: &str) -> Result<Vec<WidgetRec>> {
    let mut stmt = conn.prepare(
        "SELECT id, page_id, group_id, field_key, source_widget_key, geometry_json FROM form_widgets WHERE page_id=?1 ORDER BY id",
    )?;
    let rows = stmt.query_map([page_id], map_widget)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn source_fields(conn: &Connection, source_id: &str) -> Result<Vec<SourceFieldRec>> {
    let mut stmt = conn.prepare(
        "SELECT field_key, field_type, options_json, multiline, max_length FROM pdf_source_fields WHERE source_id=?1 ORDER BY field_key",
    )?;
    let rows = stmt.query_map([source_id], |r| {
        let opts: String = r.get(2)?;
        Ok(SourceFieldRec {
            field_key: r.get(0)?,
            field_type: r.get(1)?,
            options: serde_json::from_str(&opts).unwrap_or_default(),
            multiline: r.get::<_, i64>(3)? == 1,
            max_length: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Vollständiger, konsistenter Stand eines Dokuments zu seiner aktuellen Revision.
pub fn load(conn: &Connection, id: &str) -> Result<DocumentSnapshot> {
    let document = summary(conn, id)?;
    let pages = load_pages(conn, id)?;
    let mut annotations = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.page_id, a.kind, a.z_index, a.payload_version, a.payload_json
             FROM annotations a JOIN pages p ON p.id = a.page_id WHERE p.document_id=?1 ORDER BY p.position, a.z_index, a.id",
        )?;
        let rows = stmt.query_map([id], map_annotation)?;
        for r in rows {
            annotations.push(r?);
        }
    }
    let mut source_ids: Vec<String> = pages.iter().filter_map(|p| p.source_id.clone()).collect();
    let mut form_groups = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, source_id FROM form_groups WHERE document_id=?1 ORDER BY id")?;
        let rows = stmt.query_map([id], |r| Ok(FormGroupRec { id: r.get(0)?, source_id: r.get(1)? }))?;
        for r in rows {
            let g = r?;
            source_ids.push(g.source_id.clone());
            form_groups.push(g);
        }
    }
    source_ids.sort();
    source_ids.dedup();
    let mut sources = Vec::new();
    let mut source_pages = Vec::new();
    for sid in &source_ids {
        let (blob_hash, page_count, original_name, compat): (String, i64, Option<String>, String) = conn.query_row(
            "SELECT blob_hash, page_count, original_name, compatibility_json FROM pdf_sources WHERE id=?1",
            [sid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        sources.push(SourceRec {
            id: sid.clone(),
            blob_hash,
            page_count,
            original_name,
            compatibility: serde_json::from_str(&compat).unwrap_or(Value::Null),
            fields: source_fields(conn, sid)?,
        });
        let used: Vec<i64> =
            pages.iter().filter(|p| p.source_id.as_deref() == Some(sid)).filter_map(|p| p.source_page_index).collect();
        let mut stmt = conn.prepare(
            "SELECT source_id, page_index, crop_x, crop_y, width_pt, height_pt, intrinsic_rotation, user_unit
             FROM pdf_source_pages WHERE source_id=?1 ORDER BY page_index",
        )?;
        let rows = stmt.query_map([sid], |r| {
            Ok(SourcePageRec {
                source_id: r.get(0)?,
                page_index: r.get(1)?,
                crop_x: r.get(2)?,
                crop_y: r.get(3)?,
                width_pt: r.get(4)?,
                height_pt: r.get(5)?,
                intrinsic_rotation: r.get(6)?,
                user_unit: r.get(7)?,
            })
        })?;
        for r in rows {
            let sp = r?;
            if used.contains(&sp.page_index) {
                source_pages.push(sp);
            }
        }
    }
    let mut form_values = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT v.group_id, v.field_key, v.field_type, v.value_json FROM form_values v
             JOIN form_groups g ON g.id = v.group_id WHERE g.document_id=?1 ORDER BY v.group_id, v.field_key",
        )?;
        let rows = stmt.query_map([id], |r| {
            let v: String = r.get(3)?;
            Ok(FormValueRec {
                group_id: r.get(0)?,
                field_key: r.get(1)?,
                field_type: r.get(2)?,
                value: serde_json::from_str(&v).unwrap_or(Value::Null),
            })
        })?;
        for r in rows {
            form_values.push(r?);
        }
    }
    let mut widgets = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT w.id, w.page_id, w.group_id, w.field_key, w.source_widget_key, w.geometry_json
             FROM form_widgets w JOIN pages p ON p.id = w.page_id WHERE p.document_id=?1 ORDER BY p.position, w.id",
        )?;
        let rows = stmt.query_map([id], map_widget)?;
        for r in rows {
            widgets.push(r?);
        }
    }
    let view = conn
        .query_row("SELECT page_id, zoom, scroll_offset FROM document_views WHERE document_id=?1", [id], |r| {
            Ok(ViewRec { page_id: r.get(0)?, zoom: r.get(1)?, scroll_offset: r.get(2)? })
        })
        .optional()?;
    Ok(DocumentSnapshot { document, pages, annotations, sources, source_pages, form_groups, form_values, widgets, view })
}
