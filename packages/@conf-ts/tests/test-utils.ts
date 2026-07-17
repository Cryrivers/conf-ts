import * as fs from 'fs';
import * as path from 'path';
import { compile as compileJs, type CompileOptions } from '@conf-ts/compiler';
import { compile as compileNative } from '@conf-ts/compiler-native';
import {
  createMacroProjectSnapshot,
  transform as transformMacros,
  type MacroTransformOptions,
} from '@conf-ts/macro-transformer';
import { transform as transformMacrosNative } from '@conf-ts/macro-transformer-native';
import { expect } from 'vitest';

export interface TestCompileOptions
  extends CompileOptions, MacroTransformOptions {
  macro?: boolean;
}

function splitOptions(options?: TestCompileOptions): {
  compileOptions: CompileOptions;
  transformOptions: MacroTransformOptions;
} {
  const {
    macro: _macro,
    env,
    quote,
    sourceMap,
    ...sharedOptions
  } = options ?? {};
  return {
    compileOptions: sharedOptions,
    transformOptions: {
      ...sharedOptions,
      env,
      quote,
      sourceMap,
    },
  };
}

export function compileJsWithMacro(
  inputFilePath: string,
  format: 'json' | 'yaml',
  options?: TestCompileOptions,
) {
  const { compileOptions, transformOptions } = splitOptions(options);
  if (options?.macro) {
    const code = fs.readFileSync(inputFilePath, 'utf8');
    const project = createMacroProjectSnapshot([inputFilePath]);
    const transformed = transformMacros(
      { filename: inputFilePath, code, project },
      transformOptions,
    );
    const compiled = compileJs(
      { filename: inputFilePath, code: transformed.code, project },
      format,
      compileOptions,
    );
    return {
      ...compiled,
      dependencies: Array.from(
        new Set([...transformed.dependencies, ...compiled.dependencies]),
      ),
    };
  }
  return compileJs(inputFilePath, format, compileOptions);
}

export function compileNativeWithMacro(
  inputFilePath: string,
  format: 'json' | 'yaml',
  options?: TestCompileOptions,
) {
  const { compileOptions, transformOptions } = splitOptions(options);
  if (options?.macro) {
    const code = fs.readFileSync(inputFilePath, 'utf8');
    const project = createMacroProjectSnapshot([inputFilePath]);
    const transformed = transformMacrosNative(
      { filename: inputFilePath, code, project },
      transformOptions,
    );
    const compiled = compileNative(
      { filename: inputFilePath, code: transformed.code, project },
      format,
      compileOptions,
    );
    return {
      ...compiled,
      dependencies: Array.from(
        new Set([...transformed.dependencies, ...compiled.dependencies]),
      ),
    };
  }
  return compileNative(inputFilePath, format, compileOptions);
}

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SPEC_DIR = path.join(FIXTURES_DIR, 'specs');
const MACRO_DIR = path.join(FIXTURES_DIR, 'macros');
const EDGE_CASES_DIR = path.join(FIXTURES_DIR, 'edge-cases');

function assertOutput(
  inputFolder: string,
  testName: string,
  options?: TestCompileOptions,
  suffix: string = '.conf.ts',
) {
  const inputFilePath = path.join(inputFolder, `${testName}${suffix}`);
  const expectedOutputFilePath = path.join(inputFolder, `${testName}.json`);

  const expectedOutput = fs
    .readFileSync(expectedOutputFilePath, 'utf-8')
    .replace(/\n$/, '');
  const expectedYamlOutputFilePath = path.join(inputFolder, `${testName}.yaml`);
  const expectedYamlOutput = fs.readFileSync(
    expectedYamlOutputFilePath,
    'utf-8',
  );

  const { output: jsonResultJs } = compileJsWithMacro(
    inputFilePath,
    'json',
    options,
  );
  const { output: yamlResultJs } = compileJsWithMacro(
    inputFilePath,
    'yaml',
    options,
  );
  const { output: jsonResultNative } = compileNativeWithMacro(
    inputFilePath,
    'json',
    options,
  );
  const { output: yamlResultNative } = compileNativeWithMacro(
    inputFilePath,
    'yaml',
    options,
  );
  expect(jsonResultJs).toBe(expectedOutput);
  expect(jsonResultNative).toBe(expectedOutput);
  expect(yamlResultJs).toBe(expectedYamlOutput);
  expect(yamlResultNative).toBe(expectedYamlOutput);
}

type ExpectedCompileError = string | { typescript: string; native: string };

function assertError(
  inputFolder: string,
  testName: string,
  expectedError: ExpectedCompileError,
  options?: TestCompileOptions,
  suffix: string = '.conf.ts',
) {
  const inputFilePath = path.join(inputFolder, `${testName}${suffix}`);
  const typescriptError =
    typeof expectedError === 'string'
      ? expectedError
      : expectedError.typescript;
  const nativeError =
    typeof expectedError === 'string' ? expectedError : expectedError.native;
  expect(() => compileJsWithMacro(inputFilePath, 'json', options)).toThrow(
    typescriptError,
  );
  expect(() => compileNativeWithMacro(inputFilePath, 'json', options)).toThrow(
    nativeError,
  );
}

export function assertSpecOutput(
  testName: string,
  options?: TestCompileOptions,
) {
  assertOutput(SPEC_DIR, testName, options);
}

export function assertSpecError(
  testName: string,
  expectedError: string,
  options?: TestCompileOptions,
) {
  assertError(SPEC_DIR, testName, expectedError, options);
}

export function assertMacroOutput(
  testName: string,
  options?: TestCompileOptions,
) {
  assertOutput(MACRO_DIR, testName, {
    ...options,
    macro: true,
  });
}

export function assertEdgeCaseOutput(
  testName: string,
  options?: TestCompileOptions,
) {
  assertOutput(EDGE_CASES_DIR, testName, { ...options, macro: true });
}

export function assertMacroError(
  testName: string,
  expectedError: ExpectedCompileError,
  options?: TestCompileOptions,
) {
  assertError(MACRO_DIR, testName, expectedError, {
    ...options,
    macro: true,
  });
}
