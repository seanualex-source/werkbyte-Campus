//! Datentypen der IPC-Grenze. Feldnamen werden als camelCase serialisiert.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderRec {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub id: String,
    pub folder_id: Option<String>,
    pub title: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
    pub page_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageRec {
    pub id: String,
    pub position: i64,
    pub kind: String,
    pub source_id: Option<String>,
    pub source_page_index: Option<i64>,
    pub width_pt: f64,
    pub height_pt: f64,
    pub rotation: i64,
    pub background: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourcePageRec {
    pub source_id: String,
    pub page_index: i64,
    pub crop_x: f64,
    pub crop_y: f64,
    pub width_pt: f64,
    pub height_pt: f64,
    pub intrinsic_rotation: i64,
    pub user_unit: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFieldRec {
    pub field_key: String,
    pub field_type: String,
    pub options: Vec<String>,
    pub multiline: bool,
    pub max_length: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRec {
    pub id: String,
    pub blob_hash: String,
    pub page_count: i64,
    pub original_name: Option<String>,
    pub compatibility: Value,
    pub fields: Vec<SourceFieldRec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRec {
    pub id: String,
    pub page_id: String,
    pub kind: String,
    pub z_index: i64,
    pub payload_version: i64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormGroupRec {
    pub id: String,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormValueRec {
    pub group_id: String,
    pub field_key: String,
    pub field_type: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WidgetRec {
    pub id: String,
    pub page_id: String,
    pub group_id: String,
    pub field_key: String,
    pub source_widget_key: String,
    pub geometry: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewRec {
    pub page_id: Option<String>,
    pub zoom: f64,
    pub scroll_offset: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub document: DocumentSummary,
    pub pages: Vec<PageRec>,
    pub annotations: Vec<AnnotationRec>,
    pub sources: Vec<SourceRec>,
    pub source_pages: Vec<SourcePageRec>,
    pub form_groups: Vec<FormGroupRec>,
    pub form_values: Vec<FormValueRec>,
    pub widgets: Vec<WidgetRec>,
    pub view: Option<ViewRec>,
}

/// Seite samt abhängigen Objekten; wird für Einfügen und Wiederherstellen (Undo) verwendet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageBundle {
    pub id: String,
    pub kind: String,
    pub source_id: Option<String>,
    pub source_page_index: Option<i64>,
    pub width_pt: f64,
    pub height_pt: f64,
    #[serde(default)]
    pub rotation: i64,
    pub background: Option<Value>,
    #[serde(default)]
    pub annotations: Vec<AnnotationRec>,
    #[serde(default)]
    pub widgets: Vec<WidgetRec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    AddPage { page: PageBundle, position: i64 },
    DeletePage { page_id: String },
    MovePage { page_id: String, to_position: i64 },
    RotatePage { page_id: String, rotation: i64 },
    SetBackground { page_id: String, background: Value },
    UpsertAnnotation { annotation: AnnotationRec },
    DeleteAnnotation { annotation_id: String },
    CreateFormGroup { group_id: String, source_id: String, values: Vec<FormValueRec> },
    SetFormValue { group_id: String, field_key: String, value: Value },
    Rename { title: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    pub request_id: String,
    pub document_id: String,
    pub expected_revision: i64,
    pub payload: Vec<Op>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub revision: i64,
    pub committed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposePart {
    pub document_id: String,
    pub page_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub batch_id: String,
    pub deleted_at: String,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub folder_count: i64,
    pub document_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashSummary {
    pub batch_count: i64,
    pub folder_count: i64,
    pub document_count: i64,
    pub freed_bytes_estimate: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotePaper {
    pub orientation: String,
    pub background: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub library_id: String,
    pub root: String,
    pub schema_version: i64,
    pub migrated: Vec<i64>,
    pub recovered_staging_files: usize,
}
