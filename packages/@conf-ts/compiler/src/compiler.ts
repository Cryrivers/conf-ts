import { sep } from 'path';
import ts from 'typescript';
import { stringify as yamlStringify } from 'yaml';

import { ConfTSError } from './error';
import { evaluate } from './eval';
import {
  CompileOptions,
  FormattedNumber,
  jsonStringify,
  orderedClone,
  validateMacroImports,
} from './shared';

function _compile(
  inputFile: string,
  macro: boolean,
  options?: CompileOptions,
): { output: object; evaluatedFiles: Set<string>; tsConfigPath: string } {
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

  const program = ts.createProgram([inputFile], compilerOptions.options);
  const typeChecker = program.getTypeChecker();
  const enumMap: { [filePath: string]: { [key: string]: any } } = {};
  const macroImportsMap: { [filePath: string]: Set<string> } = {};
  let output: { [key: string]: any } = {};
  const evaluatedFiles: Set<string> = new Set();
  const enumEvaluatedFiles: Set<string> = new Set();

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

  return { output, evaluatedFiles, tsConfigPath };
}

export function compile(
  inputFile: string,
  format: 'json' | 'yaml',
  options?: CompileOptions,
) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'macroMode')) {
    const v: any = options.macroMode;
    if (v !== undefined && typeof v !== 'boolean') {
      throw new ConfTSError('Invalid option: macroMode must be boolean', {
        file: 'unknown',
        line: 1,
        character: 1,
      });
    }
  }
  const effectiveMacro = options?.macroMode ?? false;
  const { output, evaluatedFiles, tsConfigPath } = _compile(
    inputFile,
    effectiveMacro,
    options,
  );
  const fileNames = Array.from([tsConfigPath, ...evaluatedFiles]);

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
    return {
      output: jsonSource,
      dependencies: fileNames,
    };
  } else if (format === 'yaml') {
    const yamlOptions = {
      customTags,
      indentSeq: false,
    };
    const yamlSource = options?.preserveKeyOrder
      ? yamlStringify(orderedClone(output), yamlOptions)
      : yamlStringify(output, yamlOptions);
    return { output: yamlSource, dependencies: fileNames };
  } else {
    throw new ConfTSError(`Unsupported format: ${format}`, {
      file: 'unknown',
      line: 1,
      character: 1,
    });
  }
}