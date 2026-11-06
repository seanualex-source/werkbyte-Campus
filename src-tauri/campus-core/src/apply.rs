//! Atomare Dokumentänderungen mit Revisionsprüfung und Idempotenz (Spezifikation §4.4, §6.3).

use crate::documents::{load_annotations_for_page, load_widgets_for_page};
use crate::error::{CampusError, ErrorCode, Result};
use crate::limits::{MAX_OPS_PER_MUTATION, MAX_PAGES_PER_DOCUMENT};
use crate::model::*;
use crate::util::{clean_name, now_iso, require_uuid};
use crate::validate::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;

pub fn apply(conn: &mut Connection, m: &Mutation) -> Result<ApplyResult> {
    if m.request_id.is_empty() || m.request_id.len() > 100 {
        return Err(CampusError::invalid("Ungültige Request-ID."));
    }
    require_uuid(&m.document_id, "Dokument")?;
    if m.payload.len() > MAX_OPS_PER_MUTATION {
        return Err(CampusError::limit("Zu viele Änderungen in einem Speichervorgang."));
    }
    let tx = conn.transaction()?;
    // Idempotenz: dieselbe Anfrage liefert dasselbe Ergebnis, ohne erneut anzuwenden.
    if let Some(stored) = tx
        .query_row("SELECT result_json FROM applied_requests WHERE request_id=?1", [&m.request_id], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
    {
        return Ok(serde_json::from_str(&stored)?);
    }
    let (revision, deleted): (i64, Option<String>) = tx
        .query_row("SELECT revision, deleted_at FROM documents WHERE id=?1", [&m.document_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?
        .ok_or_else(|| CampusError::not_found("Dokument nicht gefunden."))?;
    if deleted.is_some() {
        return Err(CampusError::invalid("Das Dokument liegt im Papierkorb."));
    }
    if revision != m.expected_revision {
        return Err(CampusError::new(
            ErrorCode::RevisionConflict,
            format!("Das Dokument wurde inzwischen geändert (erwartet {}, aktuell {revision}).", m.expected_revision),
        ));
    }
    let new_rev = revision + 1;
    for op in &m.payload {
        apply_op(&tx, &m.document_id, op, new_rev)?;
    }
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM pages WHERE document_id=?1", [&m.document_id], |r| r.get(0))?;
    if count < 1 {
        return Err(CampusError::invalid("Ein Dokument muss mindestens eine Seite behalten."));
    }
    if count as usize > MAX_PAGES_PER_DOCUMENT {
        return Err(CampusError::limit(format!("Ein Dokument darf höchstens {MAX_PAGES_PER_DOCUMENT} Seiten haben.")));
    }
    let committed_at = now_iso();
    tx.execute(
        "UPDATE documents SET revision=?2, updated_at=?3 WHERE id=?1",
        params![m.document_id, new_rev, committed_at],
    )?;
    let result = ApplyResult { revision: new_rev, committed_at };
    tx.execute(
        "INSERT INTO applied_requests(request_id, result_json, created_at) VALUES (?1, ?2, ?3)",
        params![m.request_id, serde_json::to_string(&result)?, now_iso()],
    )?;
    tx.commit()?;
    Ok(result)
}

fn page_doc(tx: &Transaction<'_>, page_id: &str) -> Result<(String, String)> {
    tx.query_row("SELECT document_id, kind FROM pages WHERE id=?1", [page_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| CampusError::not_found("Seite nicht gefunden."))
}

fn require_page_in_doc(tx: &Transaction<'_>, doc: &str, page_id: &str) -> Result<String> {
    require_uuid(page_id, "Seite")?;
    let (d, kind) = page_doc(tx, page_id)?;
    if d != doc {
        return Err(CampusError::invalid("Die Seite gehört nicht zu diesem Dokument."));
    }
    Ok(kind)
}

fn ordered_page_ids(tx: &Transaction<'_>, doc: &str) -> Result<Vec<String>> {
    let mut stmt = tx.prepare("SELECT id FROM pages WHERE document_id=?1 ORDER BY position")?;
    let ids = stmt.query_map([doc], |r| r.get(0))?.collect::<std::result::Result<Vec<String>, _>>()?;
    Ok(ids)
}

/// Positionen transaktional neu vergeben: erst in einen freien negativen Bereich, dann lückenlos 0..n.
pub fn renumber(tx: &Transaction<'_>, doc: &str, ordered: &[String]) -> Result<()> {
    tx.execute("UPDATE pages SET position = -1 - position WHERE document_id=?1 AND position >= 0", [doc])?;
    let mut stmt = tx.prepare("UPDATE pages SET position=?2 WHERE id=?1 AND document_id=?3")?;
    for (i, id) in ordered.iter().enumerate() {
        let n = stmt.execute(params![id, i as i64, doc])?;
        if n != 1 {
            return Err(CampusError::internal("Seitenreihenfolge inkonsistent."));
        }
    }
    let leftover: i64 = tx.query_row("SELECT COUNT(*) FROM pages WHERE document_id=?1 AND position < 0", [doc], |r| r.get(0))?;
    if leftover != 0 {
        return Err(CampusError::internal("Seitenreihenfolge unvollständig."));
    }
    Ok(())
}

fn blob_exists(tx: &Transaction<'_>, hash: &str, kinds: &[&str]) -> Result<bool> {
    let kind: Option<String> = tx.query_row("SELECT kind FROM blobs WHERE hash=?1", [hash], |r| r.get(0)).optional()?;
    Ok(kind.map(|k| kinds.contains(&k.as_str())).unwrap_or(false))
}

pub fn upsert_annotation(tx: &Transaction<'_>, doc: &str, a: &AnnotationRec, rev: i64) -> Result<()> {
    require_uuid(&a.id, "Annotation")?;
    require_page_in_doc(tx, doc, &a.page_id)?;
    let v = validate_annotation(&a.kind, a.payload_version, &a.payload)?;
    for h in &v.blob_refs {
        if !blob_exists(tx, h, &["png", "jpeg"])? {
            return Err(CampusError::new(ErrorCode::FileMissing, "Das Bild ist in der Bibliothek nicht vorhanden."));
        }
    }
    // Eine bestehende ID darf nicht dokumentübergreifend überschrieben werden.
    if let Some(existing_page) =
        tx.query_row("SELECT page_id FROM annotations WHERE id=?1", [&a.id], |r| r.get::<_, String>(0)).optional()?
    {
        let (d, _) = page_doc(tx, &existing_page)?;
        if d != doc {
            return Err(CampusError::invalid("Annotation gehört zu einem anderen Dokument."));
        }
    }
    tx.execute(
        "INSERT INTO annotations(id, page_id, kind, z_index, payload_version, payload_json, revision)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, kind=excluded.kind, z_index=excluded.z_index,
           payload_version=excluded.payload_version, payload_json=excluded.payload_json, revision=excluded.revision",
        params![a.id, a.page_id, a.kind, a.z_index, a.payload_version, v.payload.to_string(), rev],
    )?;
    tx.execute("DELETE FROM asset_refs WHERE annotation_id=?1", [&a.id])?;
    for h in &v.blob_refs {
        tx.execute("INSERT OR IGNORE INTO asset_refs(annotation_id, blob_hash) VALUES (?1, ?2)", params![a.id, h])?;
        tx.execute("UPDATE blobs SET unreferenced_since=NULL WHERE hash=?1", [h])?;
    }
    Ok(())
}

fn field_def(tx: &Transaction<'_>, group_id: &str, field_key: &str) -> Result<(String, Vec<String>, Option<i64>)> {
    let (ftype, opts, maxlen): (String, String, Option<i64>) = tx
        .query_row(
            "SELECT f.field_type, f.options_json, f.max_length FROM form_groups g
             JOIN pdf_source_fields f ON f.source_id = g.source_id WHERE g.id=?1 AND f.field_key=?2",
            params![group_id, field_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| CampusError::not_found("Formularfeld nicht gefunden."))?;
    Ok((ftype, serde_json::from_str(&opts).unwrap_or_default(), maxlen))
}

fn require_group_in_doc(tx: &Transaction<'_>, doc: &str, group_id: &str) -> Result<String> {
    let (d, source): (String, String) = tx
        .query_row("SELECT document_id, source_id FROM form_groups WHERE id=?1", [group_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| CampusError::not_found("Formulargruppe nicht gefunden."))?;
    if d != doc {
        return Err(CampusError::invalid("Formulargruppe gehört zu einem anderen Dokument."));
    }
    Ok(source)
}

pub fn set_form_value(tx: &Transaction<'_>, group_id: &str, field_key: &str, value: &Value) -> Result<()> {
    let (ftype, opts, maxlen) = field_def(tx, group_id, field_key)?;
    let v = validate_form_value(&ftype, &opts, maxlen, value)?;
    tx.execute(
        "INSERT INTO form_values(group_id, field_key, field_type, value_json) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(group_id, field_key) DO UPDATE SET value_json=excluded.value_json",
        params![group_id, field_key, ftype, v.to_string()],
    )?;
    Ok(())
}

fn insert_page(tx: &Transaction<'_>, doc: &str, page: &PageBundle, rev: i64) -> Result<()> {
    require_uuid(&page.id, "Seite")?;
    validate_rotation(page.rotation)?;
    let exists: Option<i64> = tx.query_row("SELECT 1 FROM pages WHERE id=?1", [&page.id], |r| r.get(0)).optional()?;
    if exists.is_some() {
        return Err(CampusError::invalid("Seiten-ID existiert bereits."));
    }
    match page.kind.as_str() {
        "pdf" => {
            let sid = page.source_id.as_deref().ok_or_else(|| CampusError::invalid("PDF-Seite ohne Quelle."))?;
            let idx = page.source_page_index.ok_or_else(|| CampusError::invalid("PDF-Seite ohne Quellindex."))?;
            if page.background.is_some() {
                return Err(CampusError::invalid("PDF-Seiten haben keinen Notizhintergrund."));
            }
            let (w, h): (f64, f64) = tx
                .query_row(
                    "SELECT width_pt, height_pt FROM pdf_source_pages WHERE source_id=?1 AND page_index=?2",
                    params![sid, idx],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| CampusError::not_found("Quellseite nicht gefunden."))?;
            tx.execute(
                "INSERT INTO pages(id, document_id, position, kind, source_id, source_page_index, width_pt, height_pt, rotation)
                 VALUES (?1, ?2, -1000000000, 'pdf', ?3, ?4, ?5, ?6, ?7)",
                params![page.id, doc, sid, idx, w, h, page.rotation],
            )?;
        }
        "note" => {
            if page.source_id.is_some() || page.source_page_index.is_some() {
                return Err(CampusError::invalid("Notizseiten verweisen auf keine Quelle."));
            }
            validate_page_size(page.width_pt, page.height_pt)?;
            let bg = validate_background(page.background.as_ref().ok_or_else(|| CampusError::invalid("Notizseite ohne Hintergrund."))?)?;
            tx.execute(
                "INSERT INTO pages(id, document_id, position, kind, width_pt, height_pt, rotation, background_json)
                 VALUES (?1, ?2, -1000000000, 'note', ?3, ?4, ?5, ?6)",
                params![page.id, doc, page.width_pt, page.height_pt, page.rotation, bg.to_string()],
            )?;
        }
        _ => return Err(CampusError::invalid("Unbekannter Seitentyp.")),
    }
    for a in &page.annotations {
        if a.page_id != page.id {
            return Err(CampusError::invalid("Annotation verweist auf eine andere Seite."));
        }
        upsert_annotation(tx, doc, a, rev)?;
    }
    for w in &page.widgets {
        require_uuid(&w.id, "Formular-Widget")?;
        if w.page_id != page.id {
            return Err(CampusError::invalid("Widget verweist auf eine andere Seite."));
        }
        let gsource = require_group_in_doc(tx, doc, &w.group_id)?;
        if page.source_id.as_deref() != Some(gsource.as_str()) {
            return Err(CampusError::invalid("Widget und Seite stammen aus unterschiedlichen Quellen."));
        }
        field_def(tx, &w.group_id, &w.field_key)?;
        tx.execute(
            "INSERT INTO form_widgets(id, page_id, group_id, field_key, source_widget_key, geometry_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![w.id, w.page_id, w.group_id, w.field_key, w.source_widget_key, w.geometry.to_string()],
        )?;
    }
    Ok(())
}

fn apply_op(tx: &Transaction<'_>, doc: &str, op: &Op, rev: i64) -> Result<()> {
    match op {
        Op::AddPage { page, position } => {
            let mut ids = ordered_page_ids(tx, doc)?;
            insert_page(tx, doc, page, rev)?;
            let pos = (*position).clamp(0, ids.len() as i64) as usize;
            ids.insert(pos, page.id.clone());
            renumber(tx, doc, &ids)?;
        }
        Op::DeletePage { page_id } => {
            require_page_in_doc(tx, doc, page_id)?;
            let mut ids = ordered_page_ids(tx, doc)?;
            if ids.len() <= 1 {
                return Err(CampusError::invalid("Die letzte Seite eines Dokuments kann nicht gelöscht werden."));
            }
            tx.execute("DELETE FROM pages WHERE id=?1", [page_id])?;
            ids.retain(|i| i != page_id);
            renumber(tx, doc, &ids)?;
        }
        Op::MovePage { page_id, to_position } => {
            require_page_in_doc(tx, doc, page_id)?;
            let mut ids = ordered_page_ids(tx, doc)?;
            ids.retain(|i| i != page_id);
            let pos = (*to_position).clamp(0, ids.len() as i64) as usize;
            ids.insert(pos, page_id.clone());
            renumber(tx, doc, &ids)?;
        }
        Op::RotatePage { page_id, rotation } => {
            require_page_in_doc(tx, doc, page_id)?;
            validate_rotation(*rotation)?;
            tx.execute("UPDATE pages SET rotation=?2 WHERE id=?1", params![page_id, rotation])?;
        }
        Op::SetBackground { page_id, background } => {
            let kind = require_page_in_doc(tx, doc, page_id)?;
            if kind != "note" {
                return Err(CampusError::invalid("Nur Notizseiten haben einen Hintergrund."));
            }
            let bg = validate_background(background)?;
            tx.execute("UPDATE pages SET background_json=?2 WHERE id=?1", params![page_id, bg.to_string()])?;
        }
        Op::UpsertAnnotation { annotation } => upsert_annotation(tx, doc, annotation, rev)?,
        Op::DeleteAnnotation { annotation_id } => {
            require_uuid(annotation_id, "Annotation")?;
            let page: Option<String> =
                tx.query_row("SELECT page_id FROM annotations WHERE id=?1", [annotation_id], |r| r.get(0)).optional()?;
            let page = page.ok_or_else(|| CampusError::not_found("Annotation nicht gefunden."))?;
            require_page_in_doc(tx, doc, &page)?;
            tx.execute("DELETE FROM annotations WHERE id=?1", [annotation_id])?;
        }
        Op::CreateFormGroup { group_id, source_id, values } => {
            require_uuid(group_id, "Formulargruppe")?;
            // Idempotent für Wiederholen (Redo): eine bestehende Gruppe desselben Dokuments bleibt.
            let existing: Option<(String, String)> = tx
                .query_row("SELECT document_id, source_id FROM form_groups WHERE id=?1", [group_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            match existing {
                Some((d, s)) if d == doc && &s == source_id => {}
                Some(_) => return Err(CampusError::invalid("Formulargruppen-ID wird bereits verwendet.")),
                None => {
                    tx.execute(
                        "INSERT INTO form_groups(id, document_id, source_id) VALUES (?1, ?2, ?3)",
                        params![group_id, doc, source_id],
                    )?;
                }
            }
            for v in values {
                if v.group_id != *group_id {
                    return Err(CampusError::invalid("Formularwert verweist auf eine andere Gruppe."));
                }
                set_form_value(tx, group_id, &v.field_key, &v.value)?;
            }
        }
        Op::SetFormValue { group_id, field_key, value } => {
            require_group_in_doc(tx, doc, group_id)?;
            set_form_value(tx, group_id, field_key, value)?;
        }
        Op::Rename { title } => {
            let t = clean_name(title, 300, "Titel")?;
            tx.execute("UPDATE documents SET title=?2 WHERE id=?1", params![doc, t])?;
        }
    }
    Ok(())
}

/// Lädt eine Seite als Bundle (z. B. für Tests oder serverseitige Kopien).
pub fn page_bundle(conn: &Connection, page_id: &str) -> Result<PageBundle> {
    let p: PageRec = conn.query_row(
        "SELECT id, position, kind, source_id, source_page_index, width_pt, height_pt, rotation, background_json FROM pages WHERE id=?1",
        [page_id],
        |r| {
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
        },
    )?;
    Ok(PageBundle {
        id: p.id.clone(),
        kind: p.kind,
        source_id: p.source_id,
        source_page_index: p.source_page_index,
        width_pt: p.width_pt,
        height_pt: p.height_pt,
        rotation: p.rotation,
        background: p.background,
        annotations: load_annotations_for_page(conn, &p.id)?,
        widgets: load_widgets_for_page(conn, &p.id)?,
    })
}
