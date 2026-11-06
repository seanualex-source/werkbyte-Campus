-- werkbyte Campus · Migration 001 · Grundschema
-- Alle Zeitstempel: UTC, ISO 8601. Alle IDs: UUID (Text). Fremdschlüssel werden pro Verbindung aktiviert.

CREATE TABLE library_meta (
  id             TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  created_at     TEXT NOT NULL,
  singleton      INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1)
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
);

CREATE TABLE folders (
  id             TEXT PRIMARY KEY,
  parent_id      TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  trash_batch_id TEXT,
  orphaned       INTEGER NOT NULL DEFAULT 0 CHECK (orphaned IN (0, 1)),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK ((deleted_at IS NULL) = (trash_batch_id IS NULL))
);
CREATE INDEX idx_folders_parent ON folders(parent_id);
CREATE INDEX idx_folders_trash ON folders(trash_batch_id);

CREATE TABLE documents (
  id             TEXT PRIMARY KEY,
  folder_id      TEXT REFERENCES folders(id) ON DELETE CASCADE,
  title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  revision       INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_opened_at TEXT,
  deleted_at     TEXT,
  trash_batch_id TEXT,
  orphaned       INTEGER NOT NULL DEFAULT 0 CHECK (orphaned IN (0, 1)),
  CHECK ((deleted_at IS NULL) = (trash_batch_id IS NULL))
);
CREATE INDEX idx_documents_folder ON documents(folder_id);
CREATE INDEX idx_documents_trash ON documents(trash_batch_id);

CREATE TABLE blobs (
  hash               TEXT PRIMARY KEY CHECK (length(hash) = 64),
  kind               TEXT NOT NULL CHECK (kind IN ('pdf', 'png', 'jpeg', 'font')),
  size_bytes         INTEGER NOT NULL CHECK (size_bytes >= 0),
  relative_path      TEXT NOT NULL UNIQUE,
  created_at         TEXT NOT NULL,
  unreferenced_since TEXT
);

CREATE TABLE pdf_sources (
  id                 TEXT PRIMARY KEY,
  blob_hash          TEXT NOT NULL REFERENCES blobs(hash),
  page_count         INTEGER NOT NULL CHECK (page_count > 0),
  original_name      TEXT,
  compatibility_json TEXT NOT NULL CHECK (json_valid(compatibility_json)),
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_pdf_sources_blob ON pdf_sources(blob_hash);

-- Quellseiten-Descriptor: Geometrie der unveränderten Quellseite.
-- crop_x/crop_y: Ursprung der sichtbaren CropBox im PDF-Nutzerraum; width/height in pt inkl. UserUnit.
CREATE TABLE pdf_source_pages (
  source_id          TEXT NOT NULL REFERENCES pdf_sources(id) ON DELETE CASCADE,
  page_index         INTEGER NOT NULL CHECK (page_index >= 0),
  crop_x             REAL NOT NULL,
  crop_y             REAL NOT NULL,
  width_pt           REAL NOT NULL CHECK (width_pt > 0 AND width_pt <= 14400),
  height_pt          REAL NOT NULL CHECK (height_pt > 0 AND height_pt <= 14400),
  intrinsic_rotation INTEGER NOT NULL CHECK (intrinsic_rotation IN (0, 90, 180, 270)),
  user_unit          REAL NOT NULL DEFAULT 1 CHECK (user_unit > 0),
  PRIMARY KEY (source_id, page_index)
);

-- Formularfelder einer Quelldatei (Definition, nicht Wert).
CREATE TABLE pdf_source_fields (
  source_id    TEXT NOT NULL REFERENCES pdf_sources(id) ON DELETE CASCADE,
  field_key    TEXT NOT NULL CHECK (length(field_key) BETWEEN 1 AND 1000),
  field_type   TEXT NOT NULL CHECK (field_type IN ('text', 'checkbox', 'radio', 'dropdown')),
  options_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options_json)),
  multiline    INTEGER NOT NULL DEFAULT 0 CHECK (multiline IN (0, 1)),
  max_length   INTEGER,
  PRIMARY KEY (source_id, field_key)
);

CREATE TABLE pages (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('pdf', 'note')),
  source_id         TEXT REFERENCES pdf_sources(id),
  source_page_index INTEGER,
  width_pt          REAL NOT NULL CHECK (width_pt > 0 AND width_pt <= 14400),
  height_pt         REAL NOT NULL CHECK (height_pt > 0 AND height_pt <= 14400),
  rotation          INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270)),
  background_json   TEXT CHECK (background_json IS NULL OR json_valid(background_json)),
  CHECK (
    (kind = 'pdf' AND source_id IS NOT NULL AND source_page_index IS NOT NULL AND source_page_index >= 0 AND background_json IS NULL)
    OR
    (kind = 'note' AND source_id IS NULL AND source_page_index IS NULL AND background_json IS NOT NULL)
  ),
  UNIQUE (document_id, position)
);
CREATE INDEX idx_pages_source ON pages(source_id);

CREATE TABLE annotations (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('text', 'image', 'ink', 'highlight')),
  z_index         INTEGER NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version >= 1),
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  revision        INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE INDEX idx_annotations_page ON annotations(page_id);

CREATE TABLE form_groups (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL REFERENCES pdf_sources(id)
);
CREATE INDEX idx_form_groups_document ON form_groups(document_id);
CREATE INDEX idx_form_groups_source ON form_groups(source_id);

CREATE TABLE form_values (
  group_id   TEXT NOT NULL REFERENCES form_groups(id) ON DELETE CASCADE,
  field_key  TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'checkbox', 'radio', 'dropdown')),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  PRIMARY KEY (group_id, field_key)
);

CREATE TABLE form_widgets (
  id                TEXT PRIMARY KEY,
  page_id           TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  group_id          TEXT NOT NULL REFERENCES form_groups(id) ON DELETE CASCADE,
  field_key         TEXT NOT NULL,
  source_widget_key TEXT NOT NULL,
  geometry_json     TEXT NOT NULL CHECK (json_valid(geometry_json))
);
CREATE INDEX idx_form_widgets_page ON form_widgets(page_id);
CREATE INDEX idx_form_widgets_group ON form_widgets(group_id);

CREATE TABLE asset_refs (
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  blob_hash     TEXT NOT NULL REFERENCES blobs(hash),
  PRIMARY KEY (annotation_id, blob_hash)
);
CREATE INDEX idx_asset_refs_blob ON asset_refs(blob_hash);

CREATE TABLE document_views (
  document_id   TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  page_id       TEXT,
  zoom          REAL NOT NULL CHECK (zoom > 0),
  scroll_offset REAL NOT NULL DEFAULT 0
);

CREATE TABLE applied_requests (
  request_id  TEXT PRIMARY KEY,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at  TEXT NOT NULL
);

CREATE TABLE backup_runs (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  kind          TEXT NOT NULL CHECK (kind IN ('manual', 'auto', 'migration')),
  manifest_hash TEXT,
  target_label  TEXT,
  file_name     TEXT,
  message       TEXT
);

-- schema_migrations wird vom Migrationsrunner vor Migration 001 angelegt.
