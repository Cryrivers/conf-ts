import { dirname, sep } from 'path';
import ts from 'typescript';
import { stringify as yamlStringify } from 'yaml';

import { ConfTSError } from './error';
import { evaluate } from './eval';
import type { EvaluationState } from './internal-types';
import {
  CompileOptions,
  FormattedNumber,
  jsonStringify,
  orderedClone,
  type CompileInput,
  type SourceCompileInput,
} from './shared';

function resolveProgramOptions(inputFile: string): {
  tsConfigPath: string;
  compilerOptions: ts.CompilerOptions;
} {
  const tsConfigPath = ts.findConfigFile(inputFile, ts.sys.fileExists);

  if (!tsConfigPath) {
    throw new ConfTSError('Could not find a tsconfig.json file.', {
      file: inputFile,
      line: 1,
      character: 1,
    });
  }

  const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new ConfTSError(
      `Failed to read tsconfig.json: ${ts.flattenDiagnosticMessageText(
        configFile.error.messageText,
        '\n',
      )}`,
      {
        file: configFile.error.file?.fileName ?? tsConfigPath,
        ...(configFile.error.file && configFile.error.start !== undefined
          ? ts.getLineAndCharacterOfPosition(
              configFile.error.file,
              configFile.error.start,
            )
          : { line: 1, character: 1 }),
      },
    );
  }

  const compilerOptions = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    tsConfigPath.substring(0, tsConfigPath.lastIndexOf(sep)),
  );
  if (compilerOptions.errors && compilerOptions.errors.length > 0) {
    const first = compilerOptions.errors[0];
    throw new ConfTSError(
      `Invalid tsconfig.json: ${ts.flattenDiagnosticMessageText(
        first.messageText,
        '\n',
      )}`,
      {
        file: first.file?.fileName ?? tsConfigPath,
        ...(first.file && first.start !== undefined
          ? ts.getLineAndCharacterOfPosition(first.file, first.start)
          : { line: 1, character: 1 }),
      },
    );
  }

  return { tsConfigPath, compilerOptions: compilerOptions.options };
}

/** Build a `ts.Program` for a config entry file from its nearest tsconfig.json. */
export function createFileProgram(inputFile: string): {
  program: ts.Program;
  tsConfigPath: string;
} {
  const { tsConfigPath, compilerOptions } = resolveProgramOptions(inputFile);
  const program = ts.createProgram([inputFile], compilerOptions);
  return { program, tsConfigPath };
}

/** Build a `ts.Program` whose sources are the originals with `overrides` spliced in by filename. */
function createFileProgramWithOverrides(
  inputFile: string,
  overrides: Record<string, string>,
): { program: ts.Program; tsConfigPath: string } {
  const { tsConfigPath, compilerOptions } = resolveProgramOptions(inputFile);
  const host = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const overrideText = overrides[fileName];
    if (overrideText !== undefined) {
      return ts.createSourceFile(fileName, overrideText, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, ...rest);
  };
  host.readFile = fileName => {
    const overrideText = overrides[fileName];
    if (overrideText !== undefined) {
      return overrideText;
    }
    return originalReadFile(fileName);
  };
  const program = ts.createProgram([inputFile], compilerOptions, host);
  return { program, tsConfigPath };
}

function projectCompilerOptions(input: SourceCompileInput): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    noLib: true,
    allowJs: true,
    resolveJsonModule: true,
    ...(input.project?.compilerOptions as ts.CompilerOptions | undefined),
  };
}

function createProjectCompilerHost(
  input: SourceCompileInput,
  files: Record<string, string>,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const resolutions = input.project?.resolutions ?? {};
  const has = (fileName: string) =>
    Object.prototype.hasOwnProperty.call(files, fileName);
  const directoryExists = (directoryName: string) =>
    Object.keys(files).some(fileName =>
      fileName.startsWith(`${directoryName}/`),
    );
  const extensionFromFileName = (fileName: string): ts.Extension => {
    if (/\.d\.ts$/i.test(fileName)) return ts.Extension.Dts;
    if (/\.[cm]?js$/i.test(fileName)) return ts.Extension.Js;
    if (/\.json$/i.test(fileName)) return ts.Extension.Json;
    return ts.Extension.Ts;
  };
  const host: ts.CompilerHost = {
    fileExists: has,
    readFile: fileName => files[fileName],
    getSourceFile: (fileName, languageVersion) => {
      const text = files[fileName];
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => 'lib.d.ts',
    getCurrentDirectory: () => dirname(input.filename),
    getCanonicalFileName: fileName => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    writeFile: () => {},
    directoryExists,
    getDirectories: () => [],
    realpath: fileName => fileName,
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map(moduleName => {
        const resolvedFileName =
          resolutions[containingFile]?.[moduleName] ??
          ts.resolveModuleName(moduleName, containingFile, options, {
            fileExists: has,
            readFile: fileName => files[fileName],
            directoryExists,
            getCurrentDirectory: () => dirname(input.filename),
            getDirectories: () => [],
            realpath: fileName => fileName,
            useCaseSensitiveFileNames: () => true,
          }).resolvedModule?.resolvedFileName;
        if (!resolvedFileName || !has(resolvedFileName)) return undefined;
        return {
          resolvedFileName,
          extension: extensionFromFileName(resolvedFileName),
          isExternalLibraryImport: false,
        };
      }),
  };
  return host;
}

/** Build a program from a host-provided, serializable source snapshot. */
export function createSourceProgram(input: SourceCompileInput): ts.Program {
  const files = {
    ...(input.project?.files ?? {}),
    [input.filename]: input.code,
  };
  const options = projectCompilerOptions(input);
  const rootNames = Array.from(
    new Set([
      ...Object.keys(files).filter(name => /\.[cm]?[jt]sx?$/i.test(name)),
      input.filename,
    ]),
  );
  return ts.createProgram(
    rootNames,
    options,
    createProjectCompilerHost(input, files, options),
  );
}

/**
 * Collect enum values from every non-declaration file in `program`.
 */
export function createEvaluationState(
  program: ts.Program,
  options?: CompileOptions,
): EvaluationState {
  const typeChecker = program.getTypeChecker();
  const enumMap: { [filePath: string]: { [key: string]: any } } = {};
  const importBindingsMap: { [filePath: string]: Set<string> } = {};
  const evaluatedFiles: Set<string> = new Set();
  const enumEvaluatedFiles: Set<string> = new Set();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }

    importBindingsMap[sourceFile.fileName] = new Set();

    ts.forEachChild(sourceFile, node => {
      if (ts.isEnumDeclaration(node)) {
        let nextEnumValue = 0;
        node.members.forEach(member => {
          const enumName = node.name.getText(sourceFile);
          const memberName = member.name.getText(sourceFile);
          const fullEnumMemberName = `${enumName}.${memberName}`;
          if (!enumMap[sourceFile.fileName]) {
            enumMap[sourceFile.fileName] = {};
          }
          if (member.initializer) {
            const value = evaluate(
              member.initializer,
              sourceFile,
              typeChecker,
              enumMap,
              importBindingsMap,
              false,
              enumEvaluatedFiles,
              undefined,
              options,
            );
            enumMap[sourceFile.fileName][fullEnumMemberName] = value;
            if (typeof value === 'number') {
              nextEnumValue = value + 1;
            }
          } else {
            enumMap[sourceFile.fileName][fullEnumMemberName] = nextEnumValue;
            nextEnumValue++;
          }
        });
      }
    });
  }

  return { typeChecker, enumMap, importBindingsMap, evaluatedFiles };
}

/**
 * Evaluate the entry file's default export ("second pass"), using the enum
 * and enum bookkeeping already collected in `state`.
 */
export function evaluateDefaultExport(
  program: ts.Program,
  entryFile: string,
  state: EvaluationState,
  options?: CompileOptions,
): object {
  const { typeChecker, enumMap, importBindingsMap, evaluatedFiles } = state;
  let output: { [key: string]: any } = {};

  const entrySourceFile = program.getSourceFile(entryFile);
  if (!entrySourceFile) {
    return output;
  }

  let foundDefaultExport = false;
  ts.forEachChild(entrySourceFile, node => {
    if (ts.isExportAssignment(node)) {
      output = evaluate(
        node.expression,
        entrySourceFile,
        typeChecker,
        enumMap,
        importBindingsMap,
        false,
        evaluatedFiles,
        undefined,
        options,
      );
      foundDefaultExport = true;
    } else if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const specifier of node.exportClause.elements) {
        if (specifier.name.text !== 'default') {
          continue;
        }
        output = evaluate(
          specifier.propertyName || specifier.name,
          entrySourceFile,
          typeChecker,
          enumMap,
          importBindingsMap,
          false,
          evaluatedFiles,
          undefined,
          options,
        );
        foundDefaultExport = true;
        break;
      }
    }
  });

  if (!foundDefaultExport) {
    throw new ConfTSError(
      `No default export found in the entry file: ${entrySourceFile.fileName}`,
      {
        file: entrySourceFile.fileName,
        line: 1,
        character: 1,
      },
    );
  }

  return output;
}

function serialize(
  output: object,
  format: 'json' | 'yaml',
  dependencies: string[],
  options?: CompileOptions,
): { output: string; dependencies: string[] } {
  const customTags = [
    {
      identify: (v: any) => v instanceof FormattedNumber,
      default: true,
      tag: 'tag:yaml.org,2002:float',
      resolve: (v: string) => parseFloat(v),
      stringify: ({ value }: any) => (value as FormattedNumber).text,
    },
  ];

  if (format === 'json') {
    const jsonSource = options?.preserveKeyOrder
      ? jsonStringify(orderedClone(output), 2)
      : jsonStringify(output, 2);
    return { output: jsonSource, dependencies };
  } else if (format === 'yaml') {
    const yamlOptions = { customTags, indentSeq: false };
    const yamlSource = options?.preserveKeyOrder
      ? yamlStringify(orderedClone(output), yamlOptions)
      : yamlStringify(output, yamlOptions);
    return { output: yamlSource, dependencies };
  } else {
    throw new ConfTSError(`Unsupported format: ${format}`, {
      file: 'unknown',
      line: 1,
      character: 1,
    });
  }
}

export function compile(
  input: CompileInput,
  format: 'json' | 'yaml',
  options?: CompileOptions,
) {
  const inputFile = typeof input === 'string' ? input : input.filename;
  let program: ts.Program;
  let tsConfigPath: string | undefined;
  if (typeof input === 'string') {
    ({ program, tsConfigPath } = createFileProgram(input));
  } else if (input.project) {
    program = createSourceProgram(input);
  } else {
    ({ program, tsConfigPath } = createFileProgramWithOverrides(inputFile, {
      [inputFile]: input.code,
    }));
  }
  const state = createEvaluationState(program, options);
  const output = evaluateDefaultExport(program, inputFile, state, options);
  const fileNames = Array.from(
    new Set([...(tsConfigPath ? [tsConfigPath] : []), ...state.evaluatedFiles]),
  );
  return serialize(output, format, fileNames, options);
}
