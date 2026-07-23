import ts from 'typescript';

import { createEvaluationState, evaluateDefaultExport } from './compiler';
import { CompileOptions, serializeOutput, type InMemoryFiles } from './shared';

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

  const isTsLike = (name: string) => /\.(ts|js)$/i.test(name);
  const rootNames = Array.from(
    new Set<string>([...Object.keys(files).filter(isTsLike), entryFile]),
  );

  return ts.createProgram(rootNames, optionsTs, host);
}

export function compileInMemory(
  files: InMemoryFiles,
  entryFile: string,
  format: 'json' | 'yaml',
  tsconfig?: { compilerOptions?: ts.CompilerOptions },
  options?: CompileOptions,
) {
  const program = createInMemoryProgram(files, entryFile, tsconfig);
  const state = createEvaluationState(program, options);
  const output = evaluateDefaultExport(program, entryFile, state, options);
  const fileNames = Array.from(state.evaluatedFiles);
  return serializeOutput(output, format, fileNames, options);
}
