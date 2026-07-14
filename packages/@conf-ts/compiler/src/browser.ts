import ts from 'typescript';
import { stringify as yamlStringify } from 'yaml';

import { createEvaluationState, evaluateDefaultExport } from './compiler';
import { ConfTSError } from './error';
import {
  CompileOptions,
  orderedClone,
  TransformResult,
  validateCompileOptions,
  type InMemoryFiles,
} from './shared';

export type { InMemoryFiles };

function createInMemoryCompilerHost(
  files: InMemoryFiles,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const host: ts.CompilerHost = {
    fileExists: fileName =>
      Object.prototype.hasOwnProperty.call(files, fileName),
    readFile: fileName => files[fileName],
    getSourceFile: (fileName, languageVersion) => {
      const text = files[fileName];
      if (text === undefined) return undefined;
      return ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => 'lib.d.ts',
    getCurrentDirectory: () => '/',
    getCanonicalFileName: fileName => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    writeFile: () => {},
    // Optional methods used by the compiler in some paths
    directoryExists: () => true,
    getDirectories: () => [],
  };
  return host;
}

function resolveInMemoryCompilerOptions(tsconfig?: {
  compilerOptions?: ts.CompilerOptions;
}): ts.CompilerOptions {
  const defaultOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noResolve: true,
    noEmit: true,
    noLib: true,
    allowJs: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.ReactJSX,
  };

  return {
    ...defaultOptions,
    ...(tsconfig?.compilerOptions || {}),
  };
}

/** Build an in-memory `ts.Program` from a virtual file map. */
export function createInMemoryProgram(
  files: InMemoryFiles,
  entryFile: string,
  tsconfig?: { compilerOptions?: ts.CompilerOptions },
): ts.Program {
  const optionsTs = resolveInMemoryCompilerOptions(tsconfig);
  const host = createInMemoryCompilerHost(files, optionsTs);

  const isTsLike = (name: string) => /\.(tsx?|jsx?)$/i.test(name);
  const rootNames = Array.from(
    new Set<string>([...Object.keys(files).filter(isTsLike), entryFile]),
  );

  return ts.createProgram(rootNames, optionsTs, host);
}

function serialize(
  output: object,
  format: 'json' | 'yaml',
  dependencies: string[],
  options?: CompileOptions,
): { output: string; dependencies: string[] } {
  if (format === 'json') {
    const jsonSource = options?.preserveKeyOrder
      ? JSON.stringify(orderedClone(output), null, 2)
      : JSON.stringify(output, null, 2);
    return { output: jsonSource, dependencies };
  } else if (format === 'yaml') {
    const yamlSource = options?.preserveKeyOrder
      ? yamlStringify(orderedClone(output), { indentSeq: false })
      : yamlStringify(output, { indentSeq: false });
    return { output: yamlSource, dependencies };
  } else {
    throw new ConfTSError(`Unsupported format: ${format}`, {
      file: 'unknown',
      line: 1,
      character: 1,
    });
  }
}

export function compileInMemory(
  files: InMemoryFiles,
  entryFile: string,
  format: 'json' | 'yaml',
  macroMode: boolean,
  tsconfig?: { compilerOptions?: ts.CompilerOptions },
  options?: CompileOptions,
) {
  validateCompileOptions(options);
  const macro = options?.macroMode ?? macroMode;
  const program = createInMemoryProgram(files, entryFile, tsconfig);
  const state = createEvaluationState(program, macro, options);
  const output = evaluateDefaultExport(
    program,
    entryFile,
    state,
    macro,
    options,
  );
  const fileNames = Array.from(state.evaluatedFiles);
  return serialize(output, format, fileNames, options);
}

/**
 * In-memory counterpart to `compileTransformed`: `transformed.files` is
 * spread over `files` before building the program, then the ordinary
 * constants-only pass runs.
 */
export function compileInMemoryTransformed(
  files: InMemoryFiles,
  entryFile: string,
  format: 'json' | 'yaml',
  transformed: TransformResult,
  tsconfig?: { compilerOptions?: ts.CompilerOptions },
  options?: CompileOptions,
) {
  validateCompileOptions(options);
  const mergedFiles: InMemoryFiles = { ...files, ...transformed.files };
  const program = createInMemoryProgram(mergedFiles, entryFile, tsconfig);
  const state = createEvaluationState(program, false, options);
  const output = evaluateDefaultExport(
    program,
    entryFile,
    state,
    false,
    options,
  );
  const fileNames = Array.from(
    new Set([...transformed.dependencies, ...state.evaluatedFiles]),
  );
  return serialize(output, format, fileNames, options);
}
