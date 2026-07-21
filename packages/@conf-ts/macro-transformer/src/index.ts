import { dirname, resolve } from 'path';
import { ConfTSError, FormattedNumber } from '@conf-ts/compiler';
import {
  createEvaluationState,
  createSourceProgram,
  resolveProgramOptions,
  type EvaluationOptions,
} from '@conf-ts/compiler/internal';
import MagicString from 'magic-string';
import ts from 'typescript';

import { evaluateMacro, isFatalMacroTransformError } from './macro';
import { MACRO_FUNCTION_NAME_SET } from './macro-names';
import type {
  MacroProjectSnapshot,
  MacroProjectSnapshotOptions,
  MacroTransformInput,
  MacroTransformOptions,
  MacroTransformProjectInput,
  MacroTransformProjectResult,
  MacroTransformResult,
  RawSourceMap,
} from './types';

export {
  encodeStringLiteral,
  rewriteContextExpression,
} from './expression-rewrite';
export type {
  MacroProjectSnapshot,
  MacroProjectSnapshotOptions,
  MacroTransformInput,
  MacroTransformOptions,
  MacroTransformProjectInput,
  MacroTransformProjectResult,
  MacroTransformResult,
  QuoteStyle,
  RawSourceMap,
} from './types';

const MACRO_PACKAGE = '@conf-ts/macro';

interface Replacement {
  start: number;
  end: number;
  source: string;
}

interface NamedMacroBinding {
  declaration: ts.ImportSpecifier;
  importedName: string;
}

interface NamespaceMacroBinding {
  declaration: ts.NamespaceImport;
}

interface MacroBindings {
  named: Map<string, NamedMacroBinding>;
  namespaces: Map<string, NamespaceMacroBinding>;
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
  filename: string,
  sourceMap: boolean,
): { code: string; map: RawSourceMap | null } {
  const editor = new MagicString(source);
  for (const replacement of nonOverlapping(replacements)) {
    editor.overwrite(replacement.start, replacement.end, replacement.source);
  }
  return {
    code: editor.toString(),
    map: sourceMap
      ? (JSON.parse(
          editor
            .generateMap({
              source: filename,
              includeContent: true,
              hires: true,
            })
            .toString(),
        ) as RawSourceMap)
      : null,
  };
}

function moduleNameOfImport(
  declaration: ts.ImportDeclaration,
): string | undefined {
  return ts.isStringLiteral(declaration.moduleSpecifier)
    ? declaration.moduleSpecifier.text
    : undefined;
}

function collectMacroBindings(sourceFile: ts.SourceFile): MacroBindings {
  const bindings: MacroBindings = {
    named: new Map(),
    namespaces: new Map(),
  };
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      moduleNameOfImport(statement) !== MACRO_PACKAGE ||
      !statement.importClause?.namedBindings
    ) {
      continue;
    }
    const namedBindings = statement.importClause.namedBindings;
    if (ts.isNamedImports(namedBindings)) {
      for (const specifier of namedBindings.elements) {
        const importedName =
          specifier.propertyName?.text ?? specifier.name.text;
        if (
          statement.importClause.isTypeOnly ||
          specifier.isTypeOnly ||
          !MACRO_FUNCTION_NAME_SET.has(importedName)
        ) {
          continue;
        }
        bindings.named.set(specifier.name.text, {
          declaration: specifier,
          importedName,
        });
      }
    } else {
      bindings.namespaces.set(namedBindings.name.text, {
        declaration: namedBindings,
      });
    }
  }
  return bindings;
}

function symbolDeclares(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  declaration: ts.Declaration,
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol?.declarations?.includes(declaration) ?? false;
}

function importedMacroName(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindingsByFile: Map<string, MacroBindings>,
): string | undefined {
  const bindings = bindingsByFile.get(sourceFile.fileName);
  if (!bindings) return undefined;

  if (ts.isIdentifier(expression.expression)) {
    const binding = bindings.named.get(expression.expression.text);
    return binding &&
      symbolDeclares(checker, expression.expression, binding.declaration)
      ? binding.importedName
      : undefined;
  }

  if (
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression)
  ) {
    const namespaceIdentifier = expression.expression.expression;
    const binding = bindings.namespaces.get(namespaceIdentifier.text);
    return binding &&
      symbolDeclares(checker, namespaceIdentifier, binding.declaration) &&
      MACRO_FUNCTION_NAME_SET.has(expression.expression.name.text)
      ? expression.expression.name.text
      : undefined;
  }

  return undefined;
}

function namespaceIsMacroOnly(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  binding: NamespaceMacroBinding,
): boolean {
  let macroOnly = true;
  const visit = (node: ts.Node): void => {
    if (!macroOnly) return;
    if (
      ts.isIdentifier(node) &&
      node !== binding.declaration.name &&
      node.text === binding.declaration.name.text &&
      symbolDeclares(checker, node, binding.declaration)
    ) {
      const propertyAccess = node.parent;
      const call = propertyAccess?.parent;
      if (
        !propertyAccess ||
        !ts.isPropertyAccessExpression(propertyAccess) ||
        propertyAccess.expression !== node ||
        !MACRO_FUNCTION_NAME_SET.has(propertyAccess.name.text) ||
        !call ||
        !ts.isCallExpression(call) ||
        call.expression !== propertyAccess
      ) {
        macroOnly = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return macroOnly;
}

function macroImportReplacements(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  bindings: MacroBindings,
): Replacement[] {
  const replacements: Replacement[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      moduleNameOfImport(statement) === MACRO_PACKAGE &&
      statement.importClause &&
      !statement.importClause.isTypeOnly &&
      statement.importClause.namedBindings
    ) {
      if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
        const binding = bindings.namespaces.get(
          statement.importClause.namedBindings.name.text,
        );
        if (!binding || !namespaceIsMacroOnly(sourceFile, checker, binding)) {
          continue;
        }
        replacements.push({
          start: statement.getStart(sourceFile),
          end: statement.getEnd(),
          source: statement.importClause.name
            ? `import ${statement.importClause.name.text} from ${statement.moduleSpecifier.getText(sourceFile)};`
            : '',
        });
        continue;
      }
      const remaining = statement.importClause.namedBindings.elements.filter(
        specifier => {
          const importedName =
            specifier.propertyName?.text ?? specifier.name.text;
          return (
            specifier.isTypeOnly || !MACRO_FUNCTION_NAME_SET.has(importedName)
          );
        },
      );
      if (
        remaining.length ===
        statement.importClause.namedBindings.elements.length
      ) {
        continue;
      }
      const defaultBinding = statement.importClause.name?.text;
      if (remaining.length === 0 && !defaultBinding) {
        replacements.push({
          start: statement.getStart(sourceFile),
          end: statement.getEnd(),
          source: '',
        });
        continue;
      }
      const clauses = [
        ...(defaultBinding ? [defaultBinding] : []),
        ...(remaining.length > 0
          ? [
              `{ ${remaining.map(item => item.getText(sourceFile)).join(', ')} }`,
            ]
          : []),
      ];
      replacements.push({
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
        source: `import ${clauses.join(', ')} from ${statement.moduleSpecifier.getText(sourceFile)};`,
      });
    }
  }
  return replacements;
}

function nodeEnvironment(
  explicit: Record<string, string> | undefined,
  inheritProcessEnv = true,
): Record<string, string> | undefined {
  const processEnvironment =
    !inheritProcessEnv || typeof process === 'undefined'
      ? undefined
      : Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
  if (!processEnvironment && !explicit) return undefined;
  return { ...processEnvironment, ...explicit };
}

interface ProjectAnalysis {
  evaluationOptions: EvaluationOptions & MacroTransformOptions;
  state: ReturnType<typeof createEvaluationState>;
  bindingsByFile: Map<string, MacroBindings>;
}

function createProjectAnalysis(
  program: ts.Program,
  options?: MacroTransformOptions,
): ProjectAnalysis {
  const evaluationOptions: EvaluationOptions & MacroTransformOptions = {
    ...options,
    env: nodeEnvironment(options?.env, options?.inheritProcessEnv !== false),
  };
  const state = createEvaluationState(program, evaluationOptions);
  const bindingsByFile = new Map<string, MacroBindings>();
  for (const currentSourceFile of program.getSourceFiles()) {
    if (currentSourceFile.isDeclarationFile) continue;
    const bindings = collectMacroBindings(currentSourceFile);
    bindingsByFile.set(currentSourceFile.fileName, bindings);
    state.importBindingsMap[currentSourceFile.fileName] = new Set([
      ...bindings.named.keys(),
      ...Array.from(bindings.named.values(), binding => binding.importedName),
      ...bindings.namespaces.keys(),
      ...(bindings.namespaces.size > 0 ? MACRO_FUNCTION_NAME_SET : []),
    ]);
  }

  evaluationOptions.evaluateCallExpression = (
    expression,
    currentSourceFile,
    typeChecker,
    enumMap,
    importBindingsMap,
    evaluatedFiles,
    context,
    currentOptions,
  ) => {
    const macroName = importedMacroName(
      expression,
      currentSourceFile,
      typeChecker,
      bindingsByFile,
    );
    return evaluateMacro(
      expression,
      currentSourceFile,
      typeChecker,
      enumMap,
      importBindingsMap,
      evaluatedFiles,
      context,
      currentOptions,
      macroName,
    );
  };

  return { evaluationOptions, state, bindingsByFile };
}

function hasMacroBindings(bindings: MacroBindings | undefined): boolean {
  return Boolean(bindings?.named.size || bindings?.namespaces.size);
}

function warnSkippedMacro(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  error: unknown,
): void {
  const detail =
    error instanceof ConfTSError
      ? error.toString()
      : `${error instanceof Error ? error.message : String(error)}\n    at ${
          sourceFile.fileName
        }`;
  console.warn(
    `[@conf-ts/macro-transformer] Skipped a macro call that could not be statically transformed; it will likely fail at a later compile step instead:\n    ${detail}\n    in: ${node.getText(sourceFile)}`,
  );
}

function transformAnalyzedSource(
  sourceFile: ts.SourceFile,
  source: string,
  analysis: ProjectAnalysis,
  options?: MacroTransformOptions,
): MacroTransformResult {
  const { bindingsByFile, evaluationOptions, state } = analysis;
  state.evaluatedFiles.clear();

  const sourceBindings = bindingsByFile.get(sourceFile.fileName) ?? {
    named: new Map(),
    namespaces: new Map(),
  };
  const replacements: Replacement[] = [];
  let skippedMacro = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const macroName = importedMacroName(
        node,
        sourceFile,
        state.typeChecker,
        bindingsByFile,
      );
      if (macroName) {
        try {
          const value = evaluateMacro(
            node,
            sourceFile,
            state.typeChecker,
            state.enumMap,
            state.importBindingsMap,
            state.evaluatedFiles,
            undefined,
            evaluationOptions,
            macroName,
          );
          replacements.push({
            start: node.getStart(sourceFile),
            end: node.getEnd(),
            source: valueToSource(value),
          });
        } catch (error) {
          if (isFatalMacroTransformError(error)) throw error;
          // A source transformer must be safe to run over files containing
          // macros it cannot statically evaluate. Keep the entire call
          // subtree untouched and retain the macro import below. Warn here
          // (with the exact call site) since a skipped macro otherwise fails
          // silently until some unrelated later stage trips over the
          // untransformed call, at which point the error location no longer
          // points at the real cause.
          skippedMacro = true;
          warnSkippedMacro(node, sourceFile, error);
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  if (!skippedMacro) {
    replacements.push(
      ...macroImportReplacements(sourceFile, state.typeChecker, sourceBindings),
    );
  }

  const dependencies = Array.from(
    new Set([sourceFile.fileName, ...state.evaluatedFiles]),
  );
  return {
    ...applyReplacements(
      source,
      replacements,
      sourceFile.fileName,
      options?.sourceMap === true,
    ),
    dependencies,
  };
}

function referencedModuleNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      names.push(statement.moduleSpecifier.text);
    }
  }
  return names;
}

function referencedModuleNamesFromText(
  fileName: string,
  source: string,
): string[] {
  return referencedModuleNames(
    ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true),
  );
}

function sameStrings(left: string[] | undefined, right: string[]): boolean {
  return (
    left?.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizedOverrides(
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(overrides ?? {}).map(([fileName, source]) => [
      resolve(fileName),
      source,
    ]),
  );
}

function reuseSnapshotWithOverrides(
  options: MacroProjectSnapshotOptions | undefined,
  overrides: Record<string, string>,
): MacroProjectSnapshot | undefined {
  const previous = options?.previous;
  if (!previous?.referencedModules) return undefined;
  for (const [fileName, source] of Object.entries(overrides)) {
    if (!(fileName in previous.files)) return undefined;
    if (
      !sameStrings(
        previous.referencedModules[fileName],
        referencedModuleNamesFromText(fileName, source),
      )
    ) {
      return undefined;
    }
  }
  return {
    ...previous,
    files: { ...previous.files, ...overrides },
    compilerOptions: {
      ...previous.compilerOptions,
      ...options?.compilerOptions,
    },
  };
}

/**
 * Capture the filesystem-backed TypeScript graph as JSON-friendly source and
 * resolution tables. The returned snapshot can be passed to either transformer
 * implementation without granting it filesystem access.
 */
export function createMacroProjectSnapshot(
  entryFiles: string[],
  options?: MacroProjectSnapshotOptions,
): MacroProjectSnapshot {
  if (entryFiles.length === 0) {
    throw new TypeError('createMacroProjectSnapshot requires an entry file');
  }
  const normalizedEntries = entryFiles.map(fileName => resolve(fileName));
  const overrides = normalizedOverrides(options?.overrides);
  const reused = reuseSnapshotWithOverrides(options, overrides);
  if (reused) return reused;

  const files: Record<string, string> = {};
  const resolutions: Record<string, Record<string, string>> = {};
  const referencedModules: Record<string, string[]> = {};
  const dependencies = new Set<string>();
  const missingDependencies = new Set<string>();
  let compilerOptions: ts.CompilerOptions | undefined;

  const groups = new Map<string, { entries: string[] }>();
  for (const entryFile of normalizedEntries) {
    // Finding the nearest config is cheap compared with parsing it. Context
    // modules can contribute hundreds of sibling entries under the same
    // tsconfig, so defer resolveProgramOptions until the group is scanned.
    // This keeps a multi-entry snapshot to one config parse per project.
    // Fall through to resolveProgramOptions only to preserve its public error
    // and source location when no config exists.
    const tsConfigPath =
      ts.findConfigFile(entryFile, ts.sys.fileExists) ??
      resolveProgramOptions(entryFile).tsConfigPath;
    const group = groups.get(tsConfigPath);
    if (group) group.entries.push(entryFile);
    else {
      groups.set(tsConfigPath, {
        entries: [entryFile],
      });
    }
  }

  for (const [tsConfigPath, group] of groups) {
    const resolved = resolveProgramOptions(group.entries[0]);
    const groupOptions = resolved.compilerOptions;
    dependencies.add(tsConfigPath);
    compilerOptions ??= groupOptions;
    const scanOptions: ts.CompilerOptions = {
      ...groupOptions,
      noLib: true,
      types: [],
    };
    const host = ts.createCompilerHost(scanOptions, true);
    const originalFileExists = host.fileExists.bind(host);
    const originalReadFile = host.readFile.bind(host);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.fileExists = fileName => {
      const exists =
        Object.prototype.hasOwnProperty.call(overrides, fileName) ||
        originalFileExists(fileName);
      if (exists) {
        dependencies.add(fileName);
        missingDependencies.delete(fileName);
      } else {
        missingDependencies.add(fileName);
      }
      return exists;
    };
    host.readFile = fileName =>
      overrides[fileName] ?? originalReadFile(fileName);
    host.getSourceFile = (fileName, languageVersion, ...rest) => {
      const override = overrides[fileName];
      return override === undefined
        ? originalGetSourceFile(fileName, languageVersion, ...rest)
        : ts.createSourceFile(fileName, override, languageVersion, true);
    };
    const program = ts.createProgram(group.entries, scanOptions, host);
    const resolutionHost: ts.ModuleResolutionHost = {
      fileExists: host.fileExists,
      readFile: host.readFile,
      directoryExists: host.directoryExists?.bind(host),
      getCurrentDirectory: host.getCurrentDirectory.bind(host),
      getDirectories: host.getDirectories?.bind(host),
      realpath: host.realpath?.bind(host),
      useCaseSensitiveFileNames: host.useCaseSensitiveFileNames(),
    };
    const moduleResolutionCache = ts.createModuleResolutionCache(
      dirname(tsConfigPath),
      fileName => fileName,
      groupOptions,
    );
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      files[sourceFile.fileName] = sourceFile.text;
      dependencies.add(sourceFile.fileName);
      const moduleNames = referencedModuleNames(sourceFile);
      referencedModules[sourceFile.fileName] = moduleNames;
      for (const moduleName of moduleNames) {
        const resolvedModule = ts.resolveModuleName(
          moduleName,
          sourceFile.fileName,
          groupOptions,
          resolutionHost,
          moduleResolutionCache,
        ).resolvedModule;
        if (resolvedModule && !resolvedModule.isExternalLibraryImport) {
          (resolutions[sourceFile.fileName] ??= {})[moduleName] =
            resolvedModule.resolvedFileName;
        }
      }
    }
  }

  return {
    files,
    resolutions,
    compilerOptions: {
      ...(compilerOptions as Record<string, unknown> | undefined),
      ...options?.compilerOptions,
    },
    entryFiles: normalizedEntries,
    dependencies: Array.from(dependencies),
    referencedModules,
    missingDependencies: Array.from(missingDependencies),
  };
}

function validateOptions(
  options: MacroTransformOptions | undefined,
  filename: string,
): void {
  if (
    options?.quote !== undefined &&
    options.quote !== 'single' &&
    options.quote !== 'double'
  ) {
    throw new ConfTSError(
      "Invalid option: quote must be 'single' or 'double'",
      { file: filename, line: 1, character: 1 },
    );
  }
}

/** Transform a project with one shared TypeScript analysis pass. */
export function transformProject(
  input: MacroTransformProjectInput,
  options?: MacroTransformOptions,
): MacroTransformProjectResult {
  const targetFiles = Array.from(
    new Set(input.files ?? Object.keys(input.project.files)),
  );
  validateOptions(
    options,
    targetFiles[0] ?? input.project.entryFiles?.[0] ?? '',
  );
  for (const fileName of targetFiles) {
    if (!Object.prototype.hasOwnProperty.call(input.project.files, fileName)) {
      throw new Error(`Source file is missing from macro project: ${fileName}`);
    }
  }
  const candidates = targetFiles.filter(fileName => {
    const source = input.project.files[fileName];
    return source.includes(MACRO_PACKAGE) || source.includes('\\');
  });
  if (candidates.length === 0) {
    return { transformed: {}, dependencies: [] };
  }

  const seedFile = candidates[0];
  const program = createSourceProgram({
    filename: seedFile,
    code: input.project.files[seedFile],
    project: input.project,
  });
  const analysis = createProjectAnalysis(program, options);
  const transformed: Record<string, MacroTransformResult> = {};
  const dependencies = new Set<string>();
  for (const fileName of candidates) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
      throw new Error(`Source file is missing from macro project: ${fileName}`);
    }
    if (!hasMacroBindings(analysis.bindingsByFile.get(fileName))) continue;
    const result = transformAnalyzedSource(
      sourceFile,
      input.project.files[fileName],
      analysis,
      options,
    );
    transformed[fileName] = result;
    for (const dependency of result.dependencies) dependencies.add(dependency);
  }
  return { transformed, dependencies: Array.from(dependencies) };
}

/** Transform one module into ordinary, already-evaluated TypeScript source. */
export function transform(
  input: MacroTransformInput,
  options?: MacroTransformOptions,
): MacroTransformResult {
  validateOptions(options, input.filename);
  const project = input.project ?? createMacroProjectSnapshot([input.filename]);
  const projectWithInput: MacroProjectSnapshot = {
    ...project,
    files: { ...project.files, [input.filename]: input.code },
  };
  const result = transformProject(
    { project: projectWithInput, files: [input.filename] },
    options,
  ).transformed[input.filename];
  const transformed =
    result ??
    ({
      ...applyReplacements(
        input.code,
        [],
        input.filename,
        options?.sourceMap === true,
      ),
      dependencies: [input.filename],
    } satisfies MacroTransformResult);
  return {
    ...transformed,
    dependencies: Array.from(
      new Set([...(project.dependencies ?? []), ...transformed.dependencies]),
    ),
  };
}

/**
 * Create a configured source-in/source-out transformer. This intentionally is
 * not a TypeScript AST `TransformerFactory`: dependency metadata and project
 * snapshots are part of the macro transform contract.
 */
export function createTypeScriptMacroTransformer(
  options?: MacroTransformOptions,
): (input: MacroTransformInput) => MacroTransformResult {
  return input => transform(input, options);
}
