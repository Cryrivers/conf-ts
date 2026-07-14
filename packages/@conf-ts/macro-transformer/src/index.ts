import {
  compileInMemoryTransformed,
  compileTransformed,
  createEvaluationState,
  createFileProgram,
  createInMemoryProgram,
  evaluateDefaultExport,
  FormattedNumber,
  type CompileOptions,
  type InMemoryFiles,
  type InternalEvaluationOptions,
  type TransformResult,
} from '@conf-ts/compiler';
import ts from 'typescript';

import { evaluateMacro } from './macro';

export {
  encodeStringLiteral,
  rewriteContextExpression,
} from './expression-rewrite';

export interface MacroTransformOptions extends CompileOptions {}

interface Replacement {
  start: number;
  end: number;
  source: string;
}

function valueToSource(value: any, seen: Set<any> = new Set()): string {
  if (value instanceof FormattedNumber) return value.text;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '(0 / 0)';
    if (value === Infinity) return '(1 / 0)';
    if (value === -Infinity) return '(-1 / 0)';
    if (Object.is(value, -0)) return '-0';
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Cannot transform cyclic arrays');
    seen.add(value);
    const result = `[${value.map(item => valueToSource(item, seen)).join(', ')}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Cannot transform cyclic objects');
    seen.add(value);
    const entries = Object.keys(value).map(
      key => `${JSON.stringify(key)}: ${valueToSource(value[key], seen)}`,
    );
    seen.delete(value);
    return `{ ${entries.join(', ')} }`;
  }
  throw new TypeError(`Cannot transform macro value of type ${typeof value}`);
}

function nonOverlapping(replacements: Replacement[]): Replacement[] {
  const sorted = [...replacements].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const result: Replacement[] = [];
  for (const replacement of sorted) {
    const parent = result[result.length - 1];
    if (
      parent &&
      replacement.start >= parent.start &&
      replacement.end <= parent.end
    ) {
      continue;
    }
    result.push(replacement);
  }
  return result;
}

function applyReplacements(
  source: string,
  replacements: Replacement[],
): string {
  let output = source;
  for (const replacement of nonOverlapping(replacements).sort(
    (left, right) => right.start - left.start,
  )) {
    output =
      output.slice(0, replacement.start) +
      replacement.source +
      output.slice(replacement.end);
  }
  return output;
}

function transformProgram(
  program: ts.Program,
  entryFile: string,
  options?: MacroTransformOptions,
): TransformResult {
  const replacements = new Map<string, Map<string, Replacement>>();
  let macroDepth = 0;

  const evaluationOptions: InternalEvaluationOptions = {
    ...options,
    macroMode: true,
  };
  evaluationOptions.evaluateCallExpression = (
    expression,
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    evaluatedFiles,
    context,
    currentOptions,
  ) => {
    macroDepth++;
    let value: any;
    try {
      value = evaluateMacro(
        expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        evaluatedFiles,
        context,
        currentOptions,
      );
    } finally {
      macroDepth--;
    }
    if (macroDepth === 0) {
      const start = expression.getStart(sourceFile);
      const end = expression.getEnd();
      const byFile = replacements.get(sourceFile.fileName) ?? new Map();
      byFile.set(`${start}:${end}`, {
        start,
        end,
        source: valueToSource(value),
      });
      replacements.set(sourceFile.fileName, byFile);
    }
    return value;
  };

  const state = createEvaluationState(program, true, evaluationOptions);
  evaluateDefaultExport(program, entryFile, state, true, evaluationOptions);

  const files: Record<string, string> = {};
  for (const [fileName, byRange] of replacements) {
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile) {
      files[fileName] = applyReplacements(sourceFile.text, [
        ...byRange.values(),
      ]);
    }
  }

  return {
    files,
    dependencies: Array.from(state.evaluatedFiles),
  };
}

/** Pre-evaluate macros in a filesystem project using the TypeScript API. */
export function transformMacros(
  inputFile: string,
  options?: MacroTransformOptions,
): TransformResult {
  const { program, tsConfigPath } = createFileProgram(inputFile);
  const result = transformProgram(program, inputFile, options);
  return {
    ...result,
    dependencies: Array.from(new Set([tsConfigPath, ...result.dependencies])),
  };
}

/** Pre-evaluate macros in an in-memory TypeScript project. */
export function transformMacrosInMemory(
  files: InMemoryFiles,
  entryFile: string,
  tsconfig?: { compilerOptions?: ts.CompilerOptions },
  options?: MacroTransformOptions,
): TransformResult {
  return transformProgram(
    createInMemoryProgram(files, entryFile, tsconfig),
    entryFile,
    options,
  );
}

/** Convenience composition for callers that want the transformer/compiler pair. */
export function compile(
  inputFile: string,
  format: 'json' | 'yaml',
  options?: MacroTransformOptions,
) {
  return compileTransformed(
    inputFile,
    format,
    transformMacros(inputFile, options),
    options,
  );
}

export function compileInMemory(
  files: InMemoryFiles,
  entryFile: string,
  format: 'json' | 'yaml',
  tsconfig?: { compilerOptions?: ts.CompilerOptions },
  options?: MacroTransformOptions,
) {
  const transformed = transformMacrosInMemory(
    files,
    entryFile,
    tsconfig,
    options,
  );
  return compileInMemoryTransformed(
    files,
    entryFile,
    format,
    transformed,
    tsconfig,
    options,
  );
}

export { transformMacros as transform };
export { transformMacrosInMemory as transformInMemory };
