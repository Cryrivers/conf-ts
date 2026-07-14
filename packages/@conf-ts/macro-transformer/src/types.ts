import type {
  CompileOptions,
  JsxOutputOptions,
  SourceProject,
} from '@conf-ts/compiler';

export type QuoteStyle = 'single' | 'double';

export interface MacroProjectSnapshot extends SourceProject {
  entryFiles: string[];
  dependencies: string[];
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
  quote?: QuoteStyle;
  preserveKeyOrder?: boolean;
  jsx?: boolean;
  jsxOutput?: JsxOutputOptions;
  sourceMap?: boolean;
}

export interface MacroProjectSnapshotOptions {
  compilerOptions?: Record<string, unknown>;
}

/** Options shared with the constant evaluator without exposing compiler hooks. */
export type MacroEvaluationOptions = CompileOptions & MacroTransformOptions;
