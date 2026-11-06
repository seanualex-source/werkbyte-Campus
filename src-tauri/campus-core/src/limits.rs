//! Zentral konfigurierte Ressourcenlimits (Spezifikation §10). Werte sind Abnahmeziele,
//! keine Messwerte; Phase 0 darf sie dokumentiert anpassen.

pub const MAX_FOLDER_DEPTH: usize = 32;
pub const MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;
pub const MAX_PAGES_PER_SOURCE: usize = 1000;
pub const MAX_PAGES_PER_DOCUMENT: usize = 2000;
pub const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_IMAGE_PIXELS: u64 = 40_000_000;
pub const MAX_PAGE_SIZE_PT: f64 = 14_400.0;
pub const MAX_TEXT_CHARS: usize = 20_000;
pub const MAX_INK_POINTS: usize = 20_000;
pub const MAX_OPS_PER_MUTATION: usize = 5_000;
pub const MAX_FORM_TEXT_CHARS: usize = 10_000;
/// Sicherheitsfrist, bevor nicht mehr referenzierte Objektdateien gelöscht werden.
pub const GC_GRACE_DAYS: i64 = 7;
/// Aufbewahrung von Idempotenzschlüsseln.
pub const APPLIED_REQUEST_RETENTION_DAYS: i64 = 7;
/// Backup-Archive: Obergrenzen gegen Zip-Bomben.
pub const MAX_BACKUP_ENTRIES: usize = 200_000;
pub const MAX_BACKUP_TOTAL_BYTES: u64 = 512 * 1024 * 1024 * 1024;
pub const MAX_BACKUP_COMPRESSION_RATIO: u64 = 200;
