//! werkbyte Campus · Kernbibliothek
//!
//! Enthält Fachlogik, Persistenz und Backup ohne Abhängigkeit von Tauri, damit alle
//! datenkritischen Pfade mit `cargo test` gegen echte SQLite-Dateien geprüft werden können.

pub mod apply;
pub mod backup;
pub mod compose;
pub mod db;
pub mod documents;
pub mod error;
pub mod folders;
pub mod gc;
pub mod images;
pub mod importer;
pub mod library;
pub mod limits;
pub mod model;
pub mod objects;
pub mod trash;
pub mod util;
pub mod validate;

pub use error::{CampusError, ErrorCode, Result};
