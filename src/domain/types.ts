// Datentypen der IPC-Grenze; spiegeln campus-core/src/model.rs (camelCase).

export type Rotation = 0 | 90 | 180 | 270;

export interface FolderRec {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  folderId: string | null;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  pageCount: number;
}

export interface NoteBackground {
  type: 'blank' | 'ruled' | 'grid';
  spacingPt: number;
  color: string;
  lineWidthPt: number;
}

export interface PageRec {
  id: string;
  position: number;
  kind: 'pdf' | 'note';
  sourceId: string | null;
  sourcePageIndex: number | null;
  widthPt: number;
  heightPt: number;
  rotation: Rotation;
  background: NoteBackground | null;
}

export interface SourcePageRec {
  sourceId: string;
  pageIndex: number;
  cropX: number;
  cropY: number;
  widthPt: number;
  heightPt: number;
  intrinsicRotation: Rotation;
  userUnit: number;
}

export type FieldType = 'text' | 'checkbox' | 'radio' | 'dropdown';

export interface SourceFieldRec {
  fieldKey: string;
  fieldType: FieldType;
  options: string[];
  multiline: boolean;
  maxLength: number | null;
}

export interface SourceRec {
  id: string;
  blobHash: string;
  pageCount: number;
  originalName: string | null;
  compatibility: { warnings?: string[]; hasForms?: boolean; pdfVersion?: string | null } | null;
  fields: SourceFieldRec[];
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextPayload {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontAssetId: string;
  fontSize: number;
  lineHeight: number;
  color: string;
  align: TextAlign;
  orient: Rotation;
}

export interface ImagePayload {
  blobHash: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  orient: Rotation;
}

export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface InkPayload {
  points: InkPoint[];
  baseWidth: number;
  color: string;
  opacity: number;
  smoothingVersion: 1;
}

interface AnnotationBase {
  id: string;
  pageId: string;
  zIndex: number;
  payloadVersion: 1;
}

export type TextAnnotation = AnnotationBase & { kind: 'text'; payload: TextPayload };
export type ImageAnnotation = AnnotationBase & { kind: 'image'; payload: ImagePayload };
export type InkAnnotation = AnnotationBase & { kind: 'ink' | 'highlight'; payload: InkPayload };
export type Annotation = TextAnnotation | ImageAnnotation | InkAnnotation;

export interface FormGroupRec {
  id: string;
  sourceId: string;
}

export type FormValue = string | boolean | null;

export interface FormValueRec {
  groupId: string;
  fieldKey: string;
  fieldType: FieldType;
  value: FormValue;
}

export interface WidgetGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  onValue: string | null;
}

export interface WidgetRec {
  id: string;
  pageId: string;
  groupId: string;
  fieldKey: string;
  sourceWidgetKey: string;
  geometry: WidgetGeometry;
}

export interface ViewRec {
  pageId: string | null;
  zoom: number;
  scrollOffset: number;
}

export interface DocumentSnapshot {
  document: DocumentSummary;
  pages: PageRec[];
  annotations: Annotation[];
  sources: SourceRec[];
  sourcePages: SourcePageRec[];
  formGroups: FormGroupRec[];
  formValues: FormValueRec[];
  widgets: WidgetRec[];
  view: ViewRec | null;
}

export interface PageBundle {
  id: string;
  kind: 'pdf' | 'note';
  sourceId: string | null;
  sourcePageIndex: number | null;
  widthPt: number;
  heightPt: number;
  rotation: Rotation;
  background: NoteBackground | null;
  annotations: Annotation[];
  widgets: WidgetRec[];
}

export type Op =
  | { op: 'addPage'; page: PageBundle; position: number }
  | { op: 'deletePage'; pageId: string }
  | { op: 'movePage'; pageId: string; toPosition: number }
  | { op: 'rotatePage'; pageId: string; rotation: Rotation }
  | { op: 'setBackground'; pageId: string; background: NoteBackground }
  | { op: 'upsertAnnotation'; annotation: Annotation }
  | { op: 'deleteAnnotation'; annotationId: string }
  | { op: 'createFormGroup'; groupId: string; sourceId: string; values: FormValueRec[] }
  | { op: 'setFormValue'; groupId: string; fieldKey: string; value: FormValue }
  | { op: 'rename'; title: string };

export interface Mutation {
  requestId: string;
  documentId: string;
  expectedRevision: number;
  payload: Op[];
}

export interface ApplyResult {
  revision: number;
  committedAt: string;
}

export interface ComposePart {
  documentId: string;
  pageIds: string[] | null;
}

export interface TrashItem {
  batchId: string;
  deletedAt: string;
  kind: 'folder' | 'document';
  id: string;
  name: string;
  folderCount: number;
  documentCount: number;
}

export interface TrashSummary {
  batchCount: number;
  folderCount: number;
  documentCount: number;
  freedBytesEstimate: number;
}

export interface LibraryInfo {
  libraryId: string;
  root: string;
  schemaVersion: number;
  migrated: number[];
  recoveredStagingFiles: number;
}

export type ErrorCode =
  | 'REVISION_CONFLICT'
  | 'DISK_FULL'
  | 'ACCESS_DENIED'
  | 'FILE_MISSING'
  | 'PDF_UNSUPPORTED'
  | 'PDF_CORRUPT'
  | 'LIMIT_EXCEEDED'
  | 'BACKUP_INVALID'
  | 'SCHEMA_TOO_NEW'
  | 'CANCELLED'
  | 'INVALID'
  | 'NOT_FOUND'
  | 'LIBRARY_LOCKED'
  | 'INTERNAL'
  | 'GLYPH_MISSING';

export interface StagedInfo {
  stagingId: string;
  name: string;
  size: number;
  hash: string;
}

export interface StageReport {
  staged: StagedInfo[];
  failed: { name: string; error: { code: ErrorCode; message: string; retryable: boolean } }[];
}

export interface ImportAnalysis {
  title: string;
  folderId: string | null;
  pageCount: number;
  pages: {
    index: number;
    cropX: number;
    cropY: number;
    widthPt: number;
    heightPt: number;
    intrinsicRotation: Rotation;
    userUnit: number;
  }[];
  fields: {
    key: string;
    fieldType: FieldType;
    options: string[];
    multiline: boolean;
    maxLength: number | null;
    value: FormValue;
    widgets: { pageIndex: number; widgetKey: string; x: number; y: number; width: number; height: number; onValue: string | null }[];
  }[];
  warnings: string[];
  pdfVersion: string | null;
}

export interface ImportedImage {
  hash: string;
  kind: 'png' | 'jpeg';
  widthPx: number;
  heightPx: number;
}

export interface BackupFileInfo {
  path: string;
  fileName: string;
  kind: string;
  stamp: string;
  sizeBytes: number;
}

export interface BackupRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'failed';
  kind: string;
  fileName: string | null;
  message: string | null;
}

export interface BackupStatus {
  target: string | null;
  targetReachable: boolean;
  running: boolean;
  lastSuccess: BackupRun | null;
  lastRun: BackupRun | null;
  backups: BackupFileInfo[];
  sameDriveWarning: boolean;
  libraryRoot: string;
}

export interface BackupResult {
  path: string;
  fileName: string;
  manifestHash: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

export interface VerifiedBackup {
  path: string;
  libraryId: string;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  kind: string;
  fileCount: number;
  totalBytes: number;
  documentCount: number;
}

export const FONT_ID = 'bundled-font-regular-v1';
export const A4 = { w: 595.2756, h: 841.8898 };
