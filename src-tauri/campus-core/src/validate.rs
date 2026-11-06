//! Versionierte Schemas für Annotation-Payloads und Notizhintergründe (Spezifikation §5.3).
//! Unbekannte Felder werden abgelehnt; Payloads werden normalisiert gespeichert.

use crate::error::{CampusError, Result};
use crate::limits::*;
use crate::util::{finite, is_sha256_hex};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FONT_IDS: &[&str] = &["bundled-font-regular-v1"];
const COORD_LIMIT: f64 = 100_000.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextPayload {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub font_asset_id: String,
    pub font_size: f64,
    pub line_height: f64,
    pub color: String,
    pub align: String,
    #[serde(default)]
    pub orient: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImagePayload {
    pub blob_hash: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub opacity: f64,
    #[serde(default)]
    pub orient: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkPoint {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkPayload {
    pub points: Vec<InkPoint>,
    pub base_width: f64,
    pub color: String,
    pub opacity: f64,
    pub smoothing_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteBackground {
    #[serde(rename = "type")]
    pub kind: String,
    pub spacing_pt: f64,
    pub color: String,
    pub line_width_pt: f64,
}

pub fn check_color(c: &str) -> Result<()> {
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(CampusError::invalid("Farbe muss im Format #RRGGBB angegeben werden."))
    }
}

fn check_coord(v: f64, what: &str) -> Result<()> {
    finite(v, what)?;
    if v.abs() > COORD_LIMIT {
        return Err(CampusError::invalid(format!("{what} liegt außerhalb des zulässigen Bereichs.")));
    }
    Ok(())
}

fn check_range(v: f64, lo: f64, hi: f64, what: &str) -> Result<()> {
    finite(v, what)?;
    if v < lo || v > hi {
        return Err(CampusError::invalid(format!("{what} muss zwischen {lo} und {hi} liegen.")));
    }
    Ok(())
}

fn check_orient(o: i64) -> Result<()> {
    if matches!(o, 0 | 90 | 180 | 270) {
        Ok(())
    } else {
        Err(CampusError::invalid("Ausrichtung muss 0, 90, 180 oder 270 sein."))
    }
}

pub struct ValidatedAnnotation {
    pub payload: Value,
    pub blob_refs: Vec<String>,
}

pub fn validate_annotation(kind: &str, payload_version: i64, payload: &Value) -> Result<ValidatedAnnotation> {
    if payload_version != 1 {
        return Err(CampusError::invalid(format!("Payload-Version {payload_version} wird nicht unterstützt.")));
    }
    match kind {
        "text" => {
            let p: TextPayload = serde_json::from_value(payload.clone())?;
            for (v, w) in [(p.x, "x"), (p.y, "y")] {
                check_coord(v, w)?;
            }
            check_range(p.width, 1.0, MAX_PAGE_SIZE_PT, "Breite")?;
            check_range(p.height, 1.0, MAX_PAGE_SIZE_PT * 4.0, "Höhe")?;
            if p.text.chars().count() > MAX_TEXT_CHARS {
                return Err(CampusError::limit(format!("Text ist länger als {MAX_TEXT_CHARS} Zeichen.")));
            }
            if !FONT_IDS.contains(&p.font_asset_id.as_str()) {
                return Err(CampusError::invalid("Unbekannte Schrift."));
            }
            check_range(p.font_size, 4.0, 200.0, "Schriftgröße")?;
            check_range(p.line_height, 0.8, 3.0, "Zeilenhöhe")?;
            check_color(&p.color)?;
            if !matches!(p.align.as_str(), "left" | "center" | "right") {
                return Err(CampusError::invalid("Ausrichtung muss left, center oder right sein."));
            }
            check_orient(p.orient)?;
            Ok(ValidatedAnnotation { payload: serde_json::to_value(p)?, blob_refs: vec![] })
        }
        "image" => {
            let p: ImagePayload = serde_json::from_value(payload.clone())?;
            if !is_sha256_hex(&p.blob_hash) {
                return Err(CampusError::invalid("Ungültige Bildreferenz."));
            }
            check_coord(p.x, "x")?;
            check_coord(p.y, "y")?;
            check_range(p.width, 1.0, MAX_PAGE_SIZE_PT, "Breite")?;
            check_range(p.height, 1.0, MAX_PAGE_SIZE_PT, "Höhe")?;
            check_range(p.opacity, 0.0, 1.0, "Deckkraft")?;
            check_orient(p.orient)?;
            let hash = p.blob_hash.clone();
            Ok(ValidatedAnnotation { payload: serde_json::to_value(p)?, blob_refs: vec![hash] })
        }
        "ink" | "highlight" => {
            let p: InkPayload = serde_json::from_value(payload.clone())?;
            if p.points.is_empty() {
                return Err(CampusError::invalid("Ein Strich braucht mindestens einen Punkt."));
            }
            if p.points.len() > MAX_INK_POINTS {
                return Err(CampusError::limit(format!("Ein Strich darf höchstens {MAX_INK_POINTS} Punkte haben.")));
            }
            for pt in &p.points {
                check_coord(pt.x, "x")?;
                check_coord(pt.y, "y")?;
                check_range(pt.pressure, 0.0, 1.0, "Druck")?;
            }
            check_range(p.base_width, 0.1, 100.0, "Strichbreite")?;
            check_color(&p.color)?;
            check_range(p.opacity, 0.05, 1.0, "Deckkraft")?;
            if p.smoothing_version != 1 {
                return Err(CampusError::invalid("Unbekannte Glättungsversion."));
            }
            Ok(ValidatedAnnotation { payload: serde_json::to_value(p)?, blob_refs: vec![] })
        }
        other => Err(CampusError::invalid(format!("Unbekannter Annotationstyp „{other}“."))),
    }
}

pub fn validate_background(v: &Value) -> Result<Value> {
    let bg: NoteBackground = serde_json::from_value(v.clone())?;
    if !matches!(bg.kind.as_str(), "blank" | "ruled" | "grid") {
        return Err(CampusError::invalid("Hintergrund muss blank, ruled oder grid sein."));
    }
    check_range(bg.spacing_pt, 4.0, 144.0, "Linienabstand")?;
    check_color(&bg.color)?;
    check_range(bg.line_width_pt, 0.1, 5.0, "Linienstärke")?;
    Ok(serde_json::to_value(bg)?)
}

pub fn validate_page_size(w: f64, h: f64) -> Result<()> {
    check_range(w, 1.0, MAX_PAGE_SIZE_PT, "Seitenbreite")?;
    check_range(h, 1.0, MAX_PAGE_SIZE_PT, "Seitenhöhe")?;
    Ok(())
}

pub fn validate_rotation(r: i64) -> Result<()> {
    check_orient(r).map_err(|_| CampusError::invalid("Drehung muss 0, 90, 180 oder 270 sein."))
}

/// Prüft einen Formularwert gegen die Felddefinition.
pub fn validate_form_value(field_type: &str, options: &[String], max_length: Option<i64>, v: &Value) -> Result<Value> {
    match field_type {
        "text" => {
            let s = v.as_str().ok_or_else(|| CampusError::invalid("Textfeld erwartet Text."))?;
            let limit = max_length.map(|m| m.max(0) as usize).unwrap_or(MAX_FORM_TEXT_CHARS).min(MAX_FORM_TEXT_CHARS);
            if s.chars().count() > limit {
                return Err(CampusError::limit(format!("Der Feldinhalt ist länger als {limit} Zeichen.")));
            }
            Ok(Value::String(s.to_string()))
        }
        "checkbox" => {
            let b = v.as_bool().ok_or_else(|| CampusError::invalid("Checkbox erwartet wahr oder falsch."))?;
            Ok(Value::Bool(b))
        }
        "radio" | "dropdown" => {
            if v.is_null() {
                return Ok(Value::Null);
            }
            let s = v.as_str().ok_or_else(|| CampusError::invalid("Auswahlfeld erwartet eine Option."))?;
            if !options.iter().any(|o| o == s) {
                return Err(CampusError::invalid("Die gewählte Option existiert nicht."));
            }
            Ok(Value::String(s.to_string()))
        }
        _ => Err(CampusError::invalid("Unbekannter Feldtyp.")),
    }
}
