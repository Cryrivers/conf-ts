import { sep } from 'path';
import ts from 'typescript';
import { stringify as yamlStringify } from 'yaml';

import { MACRO_FUNCTIONS, MACRO_PACKAGE } from './constants';
import { ConfTSError, SourceLocation } from './error';
import { evaluate } from './eval';

interface CompileOptions {
  preserveKeyOrder?: boolean;
  macro?: boolean;
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
        .slice(1, -1); // Remove quotes
      if (moduleSpecifier === MACRO_PACKAGE) {
        if (node.importClause && node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            node.importClause.namedBindings.elements.forEach(
              importSpecifier => {
                const importedName = importSpecifier.name.getText(sourceFile);
                // @ts-expect-error
                if (MACRO_FUNCTIONS.includes(importedName)) {
                  macroImports.add(importedName);
                }
              },
            );
          }
        }
      }
    }
  });

  return macroImports;
}

function _compile(
  inputFile: string,
  macro: boolean,
  options?: CompileOptions,
): { output: object; evaluatedFiles: Set<string> } {
  const tsConfigPath = ts.findConfigFile(inputFile, ts.sys.fileExists);

  if (!tsConfigPath) {
    throw new ConfTSError('Could not find a tsconfig.json file.', {
      file: inputFile,
      line: 1,
      character: 1,
    });
  }

  const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  const compilerOptions = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    tsConfigPath.substring(0, tsConfigPath.lastIndexOf(sep)),
  );

  const program = ts.createProgram(
    [inputFile, ...compilerOptions.fileNames],
    compilerOptions.options,
  );
  const typeChecker = program.getTypeChecker();
  const enumMap: { [filePath: string]: { [key: string]: any } } = {};
  const macroImportsMap: { [filePath: string]: Set<string> } = {};
  let output: { [key: string]: any } = {};
  const evaluatedFiles: Set<string> = new Set();

  // First pass: collect enum values and macro imports from all files
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }

    // Validate macro imports for this file
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

  // Second pass: evaluate the default export from the entry file only
  const entrySourceFile = program.getSourceFile(inputFile);
  if (entrySourceFile) {
    let foundDefaultExport = false;
    ts.forEachChild(entrySourceFile, node => {
      if (ts.isExportAssignment(node)) {
        output = evaluate(
          node.expression,
          entrySourceFile,
          typeChecker,
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

export function compile(
  inputFile: string,
  format: 'json' | 'yaml',
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
  const effectiveMacro = options?.macro ?? false;
  const { output, evaluatedFiles } = _compile(
    inputFile,
    effectiveMacro,
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
