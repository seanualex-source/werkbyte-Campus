//! Einheitliche Fehler mit stabilen Codes (Spezifikation §4.4).

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    RevisionConflict,
    DiskFull,
    AccessDenied,
    FileMissing,
    PdfUnsupported,
    PdfCorrupt,
    LimitExceeded,
    BackupInvalid,
    SchemaTooNew,
    Cancelled,
    // Ergänzende Codes für Validierung und Zustände, die nicht in der Pflichtliste stehen.
    Invalid,
    NotFound,
    LibraryLocked,
    Internal,
}

impl ErrorCode {
    pub fn default_retryable(self) -> bool {
        matches!(self, ErrorCode::DiskFull | ErrorCode::AccessDenied | ErrorCode::Internal)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampusError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl CampusError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), retryable: code.default_retryable() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }
    pub fn limit(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::LimitExceeded, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

impl fmt::Display for CampusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for CampusError {}

impl From<rusqlite::Error> for CampusError {
    fn from(err: rusqlite::Error) -> Self {
        use rusqlite::ffi::ErrorCode as Sq;
        if let rusqlite::Error::SqliteFailure(e, msg) = &err {
            let detail = msg.clone().unwrap_or_default();
            return match e.code {
                Sq::DiskFull => CampusError::new(ErrorCode::DiskFull, "Der Datenträger ist voll. Die Änderung wurde nicht gespeichert."),
                Sq::DatabaseBusy | Sq::DatabaseLocked => {
                    CampusError::new(ErrorCode::Internal, "Die Datenbank ist kurzzeitig belegt.").with_retryable(true)
                }
                Sq::ReadOnly | Sq::PermissionDenied | Sq::CannotOpen => {
                    CampusError::new(ErrorCode::AccessDenied, format!("Kein Schreibzugriff auf die Bibliothek ({detail})."))
                }
                Sq::ConstraintViolation => CampusError::invalid(format!("Datenregel verletzt: {detail}")),
                Sq::DatabaseCorrupt | Sq::NotADatabase => {
                    CampusError::new(ErrorCode::Internal, "Die Bibliotheksdatenbank ist beschädigt.").with_retryable(false)
                }
                _ => CampusError::internal(format!("Datenbankfehler: {err}")),
            };
        }
        match err {
            rusqlite::Error::QueryReturnedNoRows => CampusError::not_found("Eintrag nicht gefunden."),
            other => CampusError::internal(format!("Datenbankfehler: {other}")),
        }
    }
}

impl From<std::io::Error> for CampusError {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind as K;
        match err.kind() {
            K::StorageFull => CampusError::new(ErrorCode::DiskFull, "Der Datenträger ist voll."),
            K::PermissionDenied => CampusError::new(ErrorCode::AccessDenied, format!("Zugriff verweigert: {err}")),
            K::NotFound => CampusError::new(ErrorCode::FileMissing, format!("Datei nicht gefunden: {err}")),
            _ => {
                // ENOSPC (28) bzw. ERROR_DISK_FULL (112) / ERROR_HANDLE_DISK_FULL (39) defensiv abfangen.
                match err.raw_os_error() {
                    Some(28) | Some(112) | Some(39) => CampusError::new(ErrorCode::DiskFull, "Der Datenträger ist voll."),
                    Some(32) | Some(33) => CampusError::new(ErrorCode::AccessDenied, "Die Datei ist von einem anderen Programm gesperrt."),
                    _ => CampusError::internal(format!("Dateifehler: {err}")),
                }
            }
        }
    }
}

impl From<serde_json::Error> for CampusError {
    fn from(err: serde_json::Error) -> Self {
        CampusError::invalid(format!("Ungültige Daten: {err}"))
    }
}

impl From<zip::result::ZipError> for CampusError {
    fn from(err: zip::result::ZipError) -> Self {
        match err {
            zip::result::ZipError::Io(io) => io.into(),
            other => CampusError::new(ErrorCode::BackupInvalid, format!("Sicherungsarchiv unlesbar: {other}")),
        }
    }
}

pub type Result<T> = std::result::Result<T, CampusError>;
