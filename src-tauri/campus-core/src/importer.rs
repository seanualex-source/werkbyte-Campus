//! Importabschluss: Objekt veröffentlichen, dann Metadaten in einer Transaktion eintragen (§6.2).
//! Die PDF-Analyse (Seitengeometrie, Formulare, Kompatibilität) erfolgt im Frontend
//! ausschließlich auf der Staging-Kopie; das Backend prüft die gelieferten Werte.

use crate::documents::insert_document;
use crate::error::{CampusError, Result};
use crate::limits::MAX_PAGES_PER_SOURCE;
use crate::objects::{ensure_blob_row, publish, BlobKind, StagedFile};
use crate::util::{finite, new_id, now_iso};
use crate::validate::{validate_form_value, validate_page_size, validate_rotation};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisPage {
    pub index: i64,
    pub crop_x: f64,
    pub crop_y: f64,
    pub width_pt: f64,
    pub height_pt: f64,
    pub intrinsic_rotation: i64,
    #[serde(default = "one")]
    pub user_unit: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisWidget {
    pub page_index: i64,
    pub widget_key: String,
    /// Native Seitenkoordinaten (pt, Ursprung oben links der ungedrehten CropBox).
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub on_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisField {
    pub key: String,
    pub field_type: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub multiline: bool,
    pub max_length: Option<i64>,
    pub value: Value,
    pub widgets: Vec<AnalysisWidget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAnalysis {
    pub title: String,
    pub folder_id: Option<String>,
    pub page_count: i64,
    pub pages: Vec<AnalysisPage>,
    #[serde(default)]
    pub fields: Vec<AnalysisField>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub pdf_version: Option<String>,
}

fn validate(a: &ImportAnalysis) -> Result<()> {
    if a.page_count < 1 || a.page_count as usize > MAX_PAGES_PER_SOURCE {
        return Err(CampusError::limit(format!(
            "PDF-Dateien dürfen zunächst höchstens {MAX_PAGES_PER_SOURCE} Seiten haben."
        )));
    }
    if a.pages.len() as i64 != a.page_count {
        return Err(CampusError::invalid("Seitenanalyse unvollständig."));
    }
    for (i, p) in a.pages.iter().enumerate() {
        if p.index != i as i64 {
            return Err(CampusError::invalid("Seitenanalyse ungeordnet."));
        }
        finite(p.crop_x, "CropBox x")?;
        finite(p.crop_y, "CropBox y")?;
        validate_page_size(p.width_pt, p.height_pt)?;
        validate_rotation(p.intrinsic_rotation)?;
        if !(p.user_unit.is_finite() && p.user_unit > 0.0 && p.user_unit <= 75_000.0) {
            return Err(CampusError::invalid("Ungültige UserUnit."));
        }
    }
    let mut keys = std::collections::HashSet::new();
    for f in &a.fields {
        if f.key.is_empty() || f.key.len() > 1000 || !keys.insert(f.key.clone()) {
            return Err(CampusError::invalid("Ungültiger oder doppelter Formularfeldname."));
        }
        if !matches!(f.field_type.as_str(), "text" | "checkbox" | "radio" | "dropdown") {
            return Err(CampusError::invalid("Nicht unterstützter Formularfeldtyp."));
        }
        for w in &f.widgets {
            if w.page_index < 0 || w.page_index >= a.page_count {
                return Err(CampusError::invalid("Formular-Widget verweist auf eine unbekannte Seite."));
            }
            for v in [w.x, w.y, w.width, w.height] {
                finite(v, "Widget-Geometrie")?;
            }
        }
    }
    Ok(())
}

/// Führt den Import zu Ende: veröffentlicht die Datei unter ihrem Hash und legt Quelle,
/// Dokument, Seiten und Formularkontext in einer Transaktion an.
pub fn commit(conn: &mut Connection, root: &std::path::Path, staged: &StagedFile, a: &ImportAnalysis) -> Result<String> {
    if staged.kind != BlobKind::Pdf {
        return Err(CampusError::invalid("Nur PDF-Dateien können als Dokument importiert werden."));
    }
    validate(a)?;
    let rel = publish(root, staged)?;
    let tx = conn.transaction()?;
    ensure_blob_row(&tx, &staged.hash, BlobKind::Pdf, staged.size, &rel)?;
    let source_id = new_id();
    let compat = serde_json::json!({
        "warnings": a.warnings,
        "hasForms": !a.fields.is_empty(),
        "pdfVersion": a.pdf_version,
        "analysedAt": now_iso(),
    });
    tx.execute(
        "INSERT INTO pdf_sources(id, blob_hash, page_count, original_name, compatibility_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![source_id, staged.hash, a.page_count, staged.original_name, compat.to_string(), now_iso()],
    )?;
    for p in &a.pages {
        tx.execute(
            "INSERT INTO pdf_source_pages(source_id, page_index, crop_x, crop_y, width_pt, height_pt, intrinsic_rotation, user_unit)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![source_id, p.index, p.crop_x, p.crop_y, p.width_pt, p.height_pt, p.intrinsic_rotation, p.user_unit],
        )?;
    }
    for f in &a.fields {
        tx.execute(
            "INSERT INTO pdf_source_fields(source_id, field_key, field_type, options_json, multiline, max_length) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![source_id, f.key, f.field_type, serde_json::to_string(&f.options)?, f.multiline as i64, f.max_length],
        )?;
    }
    let doc = insert_document(&tx, a.folder_id.as_deref(), &a.title)?;
    let mut page_ids = Vec::with_capacity(a.pages.len());
    for p in &a.pages {
        let pid = new_id();
        tx.execute(
            "INSERT INTO pages(id, document_id, position, kind, source_id, source_page_index, width_pt, height_pt, rotation)
             VALUES (?1, ?2, ?3, 'pdf', ?4, ?5, ?6, ?7, 0)",
            params![pid, doc, p.index, source_id, p.index, p.width_pt, p.height_pt],
        )?;
        page_ids.push(pid);
    }
    if !a.fields.is_empty() {
        let group = new_id();
        tx.execute("INSERT INTO form_groups(id, document_id, source_id) VALUES (?1, ?2, ?3)", params![group, doc, source_id])?;
        for f in &a.fields {
            let value = validate_form_value(&f.field_type, &f.options, f.max_length, &f.value).unwrap_or(match f.field_type.as_str() {
                "text" => Value::String(String::new()),
                "checkbox" => Value::Bool(false),
                _ => Value::Null,
            });
            tx.execute(
                "INSERT INTO form_values(group_id, field_key, field_type, value_json) VALUES (?1, ?2, ?3, ?4)",
                params![group, f.key, f.field_type, value.to_string()],
            )?;
            for w in &f.widgets {
                let geometry = serde_json::json!({ "x": w.x, "y": w.y, "width": w.width, "height": w.height, "onValue": w.on_value });
                tx.execute(
                    "INSERT INTO form_widgets(id, page_id, group_id, field_key, source_widget_key, geometry_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![new_id(), page_ids[w.page_index as usize], group, f.key, w.widget_key, geometry.to_string()],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(doc)
}
