//! Duplizieren, Extrahieren und Zusammenführen mit Kopiersemantik (F12, F13, §5.4).
//! Neue Seiten- und Objekt-IDs; Binärdateien werden gemeinsam referenziert;
//! Formulargruppen werden je Quelldokumentinstanz einmal kopiert.

use crate::documents::{insert_document, load_pages};
use crate::error::{CampusError, Result};
use crate::limits::MAX_PAGES_PER_DOCUMENT;
use crate::model::ComposePart;
use crate::util::{new_id, require_uuid};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

pub fn compose(conn: &mut Connection, title: &str, folder_id: Option<&str>, parts: &[ComposePart]) -> Result<String> {
    if parts.is_empty() {
        return Err(CampusError::invalid("Keine Quelle ausgewählt."));
    }
    let tx = conn.transaction()?;
    let new_doc = insert_document(&tx, folder_id, title)?;
    let mut position = 0i64;
    for (part_index, part) in parts.iter().enumerate() {
        require_uuid(&part.document_id, "Dokument")?;
        let live: Option<i64> = tx
            .query_row("SELECT 1 FROM documents WHERE id=?1 AND deleted_at IS NULL", [&part.document_id], |r| r.get(0))
            .optional()?;
        if live.is_none() {
            return Err(CampusError::not_found("Ein Quelldokument existiert nicht mehr."));
        }
        let all_pages = load_pages(&tx, &part.document_id)?;
        let pages: Vec<_> = match &part.page_ids {
            None => all_pages,
            Some(sel) => {
                if sel.is_empty() {
                    return Err(CampusError::invalid("Leere Seitenauswahl."));
                }
                // Reihenfolge der Auswahl entspricht der Dokumentreihenfolge.
                let picked: Vec<_> = all_pages.into_iter().filter(|p| sel.contains(&p.id)).collect();
                if picked.len() != sel.len() {
                    return Err(CampusError::invalid("Die Auswahl enthält unbekannte Seiten."));
                }
                picked
            }
        };
        // (Teilindex, alte Gruppe) -> neue Gruppe: eigene Zuordnung je Quelldokumentinstanz.
        let mut group_map: HashMap<String, String> = HashMap::new();
        for page in pages {
            if position as usize >= MAX_PAGES_PER_DOCUMENT {
                return Err(CampusError::limit(format!("Das Ergebnis hätte mehr als {MAX_PAGES_PER_DOCUMENT} Seiten.")));
            }
            let new_page = new_id();
            tx.execute(
                "INSERT INTO pages(id, document_id, position, kind, source_id, source_page_index, width_pt, height_pt, rotation, background_json)
                 SELECT ?1, ?2, ?3, kind, source_id, source_page_index, width_pt, height_pt, rotation, background_json FROM pages WHERE id=?4",
                params![new_page, new_doc, position, page.id],
            )?;
            position += 1;
            // Annotationen mit neuen IDs kopieren.
            let mut stmt = tx.prepare("SELECT id FROM annotations WHERE page_id=?1 ORDER BY z_index, id")?;
            let ann_ids: Vec<String> = stmt.query_map([&page.id], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            for old in ann_ids {
                let new_ann = new_id();
                tx.execute(
                    "INSERT INTO annotations(id, page_id, kind, z_index, payload_version, payload_json, revision)
                     SELECT ?1, ?2, kind, z_index, payload_version, payload_json, 0 FROM annotations WHERE id=?3",
                    params![new_ann, new_page, old],
                )?;
                tx.execute(
                    "INSERT INTO asset_refs(annotation_id, blob_hash) SELECT ?1, blob_hash FROM asset_refs WHERE annotation_id=?2",
                    params![new_ann, old],
                )?;
            }
            // Formular-Widgets: Gruppe pro Quelldokumentinstanz einmal kopieren, Kopplung bleibt erhalten.
            let mut stmt = tx.prepare("SELECT id, group_id FROM form_widgets WHERE page_id=?1 ORDER BY id")?;
            let widgets: Vec<(String, String)> =
                stmt.query_map([&page.id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            for (old_widget, old_group) in widgets {
                let key = format!("{part_index}:{old_group}");
                let new_group = match group_map.get(&key) {
                    Some(g) => g.clone(),
                    None => {
                        let g = new_id();
                        tx.execute(
                            "INSERT INTO form_groups(id, document_id, source_id) SELECT ?1, ?2, source_id FROM form_groups WHERE id=?3",
                            params![g, new_doc, old_group],
                        )?;
                        tx.execute(
                            "INSERT INTO form_values(group_id, field_key, field_type, value_json)
                             SELECT ?1, field_key, field_type, value_json FROM form_values WHERE group_id=?2",
                            params![g, old_group],
                        )?;
                        group_map.insert(key, g.clone());
                        g
                    }
                };
                tx.execute(
                    "INSERT INTO form_widgets(id, page_id, group_id, field_key, source_widget_key, geometry_json)
                     SELECT ?1, ?2, ?3, field_key, source_widget_key, geometry_json FROM form_widgets WHERE id=?4",
                    params![new_id(), new_page, new_group, old_widget],
                )?;
            }
        }
    }
    if position == 0 {
        return Err(CampusError::invalid("Das Ergebnis enthält keine Seiten."));
    }
    tx.commit()?;
    Ok(new_doc)
}
