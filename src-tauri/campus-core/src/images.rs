//! Bildimport (F07): nur PNG/JPEG, Größen- und Pixellimits, EXIF-Ausrichtung normalisieren.

use crate::error::{CampusError, Result};
use crate::limits::{MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS};
use crate::objects::{ensure_blob_row, publish, sniff_kind, stage_from_bytes, BlobKind};
use image::{DynamicImage, ImageDecoder, ImageReader};
use rusqlite::Connection;
use serde::Serialize;
use std::io::Cursor;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub hash: String,
    pub kind: String,
    pub width_px: u32,
    pub height_px: u32,
}

pub fn import_image_bytes(conn: &Connection, root: &Path, data: Vec<u8>, name: &str) -> Result<ImportedImage> {
    if data.len() as u64 > MAX_IMAGE_BYTES {
        return Err(CampusError::limit(format!("Bilder dürfen höchstens {} MiB groß sein.", MAX_IMAGE_BYTES / 1024 / 1024)));
    }
    let kind = match sniff_kind(&data) {
        Some(BlobKind::Png) => BlobKind::Png,
        Some(BlobKind::Jpeg) => BlobKind::Jpeg,
        _ => return Err(CampusError::invalid("Nur PNG- und JPEG-Bilder werden unterstützt.")),
    };
    let reader = ImageReader::new(Cursor::new(&data)).with_guessed_format()?;
    let (w, h) = reader.into_dimensions().map_err(|e| CampusError::invalid(format!("Bild unlesbar: {e}")))?;
    if (w as u64) * (h as u64) > MAX_IMAGE_PIXELS {
        return Err(CampusError::limit("Das Bild hat mehr als 40 Megapixel. Bitte vorher verkleinern."));
    }
    let mut out_bytes = data;
    let (mut out_w, mut out_h) = (w, h);
    if kind == BlobKind::Jpeg {
        // EXIF-Ausrichtung anwenden, damit Vorschau und Export nicht davon abhängen.
        let mut decoder = ImageReader::new(Cursor::new(&out_bytes))
            .with_guessed_format()?
            .into_decoder()
            .map_err(|e| CampusError::invalid(format!("Bild unlesbar: {e}")))?;
        let orientation = decoder.orientation().map_err(|e| CampusError::invalid(format!("EXIF unlesbar: {e}")))?;
        if orientation != image::metadata::Orientation::NoTransforms {
            let mut img = DynamicImage::from_decoder(decoder).map_err(|e| CampusError::invalid(format!("Bild unlesbar: {e}")))?;
            img.apply_orientation(orientation);
            out_w = img.width();
            out_h = img.height();
            let mut buf = Vec::new();
            let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 92);
            img.to_rgb8().write_with_encoder(enc).map_err(|e| CampusError::internal(format!("Bild konnte nicht normalisiert werden: {e}")))?;
            out_bytes = buf;
        }
    }
    let staged = stage_from_bytes(root, &out_bytes, name, kind)?;
    let rel = publish(root, &staged)?;
    ensure_blob_row(conn, &staged.hash, kind, staged.size, &rel)?;
    Ok(ImportedImage { hash: staged.hash, kind: kind.as_str().into(), width_px: out_w, height_px: out_h })
}

impl From<image::ImageError> for CampusError {
    fn from(e: image::ImageError) -> Self {
        CampusError::invalid(format!("Bild unlesbar: {e}"))
    }
}
