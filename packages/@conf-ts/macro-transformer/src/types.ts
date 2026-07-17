import type { CompileOptions, SourceProject } from '@conf-ts/compiler';

export type QuoteStyle = 'single' | 'double';

export interface MacroProjectSnapshot extends SourceProject {
  entryFiles: string[];
  dependencies: string[];
  /** Static import/export specifiers by source file. */
  referencedModules?: Record<string, string[]>;
  /** Resolution candidates which did not exist when the snapshot was made. */
  missingDependencies?: string[];
}

export interface MacroTransformInput {
  filename: string;
  code: string;
  project?: MacroProjectSnapshot;
}

export interface RawSourceMap {
  version: 3;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: Array<string | null>;
  names: string[];
  mappings: string;
}

export interface MacroTransformResult {
  code: string;
  map: RawSourceMap | null;
  dependencies: string[];
}

export interface MacroTransformOptions {
  env?: Record<string, string>;
  /** Merge `process.env` into `env`. Defaults to true. */
  inheritProcessEnv?: boolean;
  quote?: QuoteStyle;
  preserveKeyOrder?: boolean;
  sourceMap?: boolean;
}

export interface MacroProjectSnapshotOptions {
  compilerOptions?: Record<string, unknown>;
  /** Reuse this snapshot when every overridden file keeps the same references. */
  previous?: MacroProjectSnapshot;
  /** In-memory source updates, used by watch builds. */
  overrides?: Record<string, string>;
}

export interface MacroTransformProjectInput {
  project: MacroProjectSnapshot;
  /** Transform these files only. Omit to transform every macro source. */
  files?: string[];
}

export interface MacroTransformProjectResult {
  /** Sparse results: files without effective macro bindings are omitted. */
  transformed: Record<string, MacroTransformResult>;
  /** Deduplicated union of every transformed file's precise dependencies. */
  dependencies: string[];
}

/** Options shared with the constant evaluator without exposing compiler hooks. */
export type MacroEvaluationOptions = CompileOptions & MacroTransformOptions;
