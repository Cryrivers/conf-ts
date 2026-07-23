export type DiffClassification = 'semantic' | 'source-only' | 'unknown';
export type DiffChangeKind =
  | 'add'
  | 'remove'
  | 'modify'
  | 'rename'
  | 'move'
  | 'reorder'
  | 'type'
  | 'comment'
  | 'refactor';

export interface SourceProject {
  filename: string;
  code: string;
  files?: Record<string, string>;
  resolutions?: Record<string, Record<string, string>>;
  compilerOptions?: Record<string, unknown>;
  dependencies?: string[];
  referencedModules?: Record<string, string[]>;
}

export type DiffSource =
  | { kind: 'file'; path: string; label?: string }
  | {
      kind: 'source';
      filename: string;
      code: string;
      project?: Omit<SourceProject, 'filename' | 'code'>;
      label?: string;
    }
  | {
      kind: 'git';
      path: string;
      ref: string;
      repo?: string;
      label?: string;
    };

export interface DiffPolicy {
  match: string;
  failOn: 'none' | 'semantic' | 'any';
}

export interface DiffOptions {
  macro?: {
    mode?: 'auto' | 'never' | 'always';
    env?: Record<string, string>;
  };
  arrayKeys?: Record<string, string>;
  ignore?: string[];
  redact?: string[];
  includeSource?: boolean;
  maxMatchWork?: number;
  policies?: DiffPolicy[];
}

export interface SourceLocation {
  file: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface ValuePreview {
  valueType: string;
  preview: unknown;
  redacted: boolean;
}

export interface DiffChange {
  id: string;
  classification: DiffClassification;
  kind: DiffChangeKind;
  pathBefore?: string;
  pathAfter?: string;
  before?: ValuePreview;
  after?: ValuePreview;
  spans: {
    before?: SourceLocation;
    after?: SourceLocation;
  };
  originChain: SourceLocation[];
  relatedChangeIds: string[];
  ignored: boolean;
  sensitive: boolean;
  matchReason?: string;
}

export interface StructureNode {
  id: string;
  path: string;
  label: string;
  kind: string;
  semanticHash: string;
  sourceHash: string;
  span: SourceLocation;
  valuePreview?: unknown;
  children: StructureNode[];
}

export interface DiffDiagnostic {
  side: 'left' | 'right' | 'both';
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  location?: SourceLocation;
}

export interface DiffReport {
  schemaVersion: 1;
  comparison: {
    left: { label: string; filename: string; ref?: string };
    right: { label: string; filename: string; ref?: string };
    optionsDigest: string;
  };
  summary: {
    total: number;
    semantic: number;
    sourceOnly: number;
    unknown: number;
    added: number;
    removed: number;
    modified: number;
    moved: number;
    renamed: number;
    ignored?: number;
    evaluationStatus: 'complete' | 'unavailable' | 'partial';
  };
  changes: DiffChange[];
  structure: {
    before?: StructureNode;
    after?: StructureNode;
  };
  files: Array<{
    pathBefore?: string;
    pathAfter?: string;
    beforeSource?: string;
    afterSource?: string;
    beforeExpandedSource?: string;
    afterExpandedSource?: string;
  }>;
  dependencyGraph: {
    nodes: Array<{
      id: string;
      path: string;
      before: boolean;
      after: boolean;
    }>;
    edges: Array<{
      from: string;
      to: string;
      specifier: string;
      side: 'left' | 'right' | 'both';
    }>;
  };
  evaluation: {
    status: 'complete' | 'unavailable' | 'partial';
    before?: unknown;
    after?: unknown;
    leftError?: string;
    rightError?: string;
    sensitive: boolean;
  };
  diagnostics: DiffDiagnostic[];
}

export interface HtmlReportOptions {
  title?: string;
  initialView?: 'structure' | 'source' | 'value' | 'dependencies';
  theme?: 'auto' | 'light' | 'dark';
}
