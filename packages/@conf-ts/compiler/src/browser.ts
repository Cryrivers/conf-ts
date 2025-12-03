import ts from 'typescript';
import { stringify as yamlStringify } from 'yaml';

import { MACRO_PACKAGE } from './constants';
import { ConfTSError } from './error';
import { evaluate } from './eval';

interface CompileOptions {
  preserveKeyOrder?: boolean;
  macro?: boolean;
  env?: Record<string, string>;
}

function orderedClone(value: any): any {
  if (Array.isArray(value)) {
    return value.map(v => orderedClone(v));
  }
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const k of Object.keys(value)) {
      out[k] = orderedClone(value[k]);
    }
    return out;
  }
  return value;
}

function validateMacroImports(
  sourceFile: ts.SourceFile,
  macro: boolean,
): Set<string> {
  const macroImports = new Set<string>();

  if (!macro) {
    return macroImports;
  }

  ts.forEachChild(sourceFile, node => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const moduleSpecifier = node.moduleSpecifier
        .getText(sourceFile)
        .slice(1, -1);
      if (moduleSpecifier === MACRO_PACKAGE) {
        if (node.importClause && node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            node.importClause.namedBindings.elements.forEach(
              importSpecifier => {
                const importedName = importSpecifier.name.getText(sourceFile);
                macroImports.add(importedName);
              },
            );
          }
        }
      }
    }
  });

  return macroImports;
}

export type InMemoryFiles = { [fileName: string]: string };

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

function compileWithProgram(
  program: ts.Program,
  entryFile: string,
  macro: boolean,
  options?: CompileOptions,
): { output: object; evaluatedFiles: Set<string> } {
  const typeChecker = program.getTypeChecker();
  const enumMap: { [filePath: string]: { [key: string]: any } } = {};
  const macroImportsMap: { [filePath: string]: Set<string> } = {};
  let output: { [key: string]: any } = {};
  const evaluatedFiles: Set<string> = new Set();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }
    macroImportsMap[sourceFile.fileName] = validateMacroImports(
      sourceFile,
      macro,
    );

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
              macroImportsMap,
              macro,
              evaluatedFiles,
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

  const entrySourceFile = program.getSourceFile(entryFile);
  if (entrySourceFile) {
    let foundDefaultExport = false;
    ts.forEachChild(entrySourceFile, node => {
      if (ts.isExportAssignment(node)) {
        output = evaluate(
          node.expression,
          entrySourceFile,
          program.getTypeChecker(),
          enumMap,
          macroImportsMap,
          macro,
          evaluatedFiles,
          undefined,
          options,
        );
        foundDefaultExport = true;
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
  }

  return { output, evaluatedFiles };
}

export function compileInMemory(
  files: InMemoryFiles,
  entryFile: string,
  format: 'json' | 'yaml',
  macro: boolean,
  tsconfig?: { compilerOptions?: ts.CompilerOptions },
  options?: CompileOptions,
) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'macro')) {
    const v: any = options.macro;
    if (v !== undefined && typeof v !== 'boolean') {
      throw new ConfTSError('Invalid option: macro must be boolean', {
        file: 'unknown',
        line: 1,
        character: 1,
      });
    }
  }
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

  const optionsTs: ts.CompilerOptions = {
    ...defaultOptions,
    ...(tsconfig?.compilerOptions || {}),
  };

  const host = createInMemoryCompilerHost(files, optionsTs);

  const isTsLike = (name: string) => /\.(tsx?|jsx?)$/i.test(name);
  const rootNames = Array.from(
    new Set<string>([...Object.keys(files).filter(isTsLike), entryFile]),
  );

  const program = ts.createProgram(rootNames, optionsTs, host);

  const { output, evaluatedFiles } = compileWithProgram(
    program,
    entryFile,
    options?.macro ?? macro,
    options,
  );
  const fileNames = Array.from(evaluatedFiles);

  if (format === 'json') {
    const jsonSource = options?.preserveKeyOrder
      ? JSON.stringify(orderedClone(output), null, 2)
      : JSON.stringify(output, null, 2);
    return { output: jsonSource, dependencies: fileNames };
  } else if (format === 'yaml') {
    const yamlSource = options?.preserveKeyOrder
      ? yamlStringify(orderedClone(output))
      : yamlStringify(output);
    return { output: yamlSource, dependencies: fileNames };
  } else {
    throw new ConfTSError(`Unsupported format: ${format}`, {
      file: 'unknown',
      line: 1,
      character: 1,
    });
  }
}
