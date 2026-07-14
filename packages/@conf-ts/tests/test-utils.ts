import * as fs from 'fs';
import * as path from 'path';
import {
  compile as compileJs,
  compileTransformed,
  type CompileOptions,
} from '@conf-ts/compiler';
import { compile as compileNative } from '@conf-ts/compiler-native';
import { transformMacros } from '@conf-ts/macro-transformer';
import { compile as compileNativeMacro } from '@conf-ts/macro-transformer-native';
import { expect } from 'vitest';

/**
 * @conf-ts/compiler no longer evaluates macros itself: when `macroMode` is
 * requested, macros must be pre-evaluated by @conf-ts/macro-transformer
 * first, then the rewritten source is compiled with the ordinary
 * constants-only pipeline via `compileTransformed`.
 */
export function compileJsWithMacro(
  inputFilePath: string,
  format: 'json' | 'yaml',
  options?: CompileOptions,
) {
  if (options?.macroMode) {
    return compileTransformed(
      inputFilePath,
      format,
      transformMacros(inputFilePath, options),
      options,
    );
  }
  return compileJs(inputFilePath, format, options);
}

/**
 * Native counterpart to `compileJsWithMacro`: @conf-ts/compiler-native no
 * longer evaluates macros itself either, so macro-mode compiles route
 * through @conf-ts/macro-transformer-native's own transform+compile
 * convenience wrapper instead.
 */
export function compileNativeWithMacro(
  inputFilePath: string,
  format: 'json' | 'yaml',
  options?: CompileOptions,
) {
  if (options?.macroMode) {
    return compileNativeMacro(inputFilePath, format, options);
  }
  return compileNative(inputFilePath, format, options);
}

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SPEC_DIR = path.join(FIXTURES_DIR, 'specs');
const MACRO_DIR = path.join(FIXTURES_DIR, 'macros');
const EDGE_CASES_DIR = path.join(FIXTURES_DIR, 'edge-cases');
const JSX_DIR = path.join(FIXTURES_DIR, 'jsx');

function assertOutput(
  inputFolder: string,
  testName: string,
  options?: CompileOptions,
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

function assertError(
  inputFolder: string,
  testName: string,
  expectedError: string,
  options?: CompileOptions,
  suffix: string = '.conf.ts',
) {
  const inputFilePath = path.join(inputFolder, `${testName}${suffix}`);
  expect(() => compileJsWithMacro(inputFilePath, 'json', options)).toThrow(
    expectedError,
  );
  expect(() => compileNativeWithMacro(inputFilePath, 'json', options)).toThrow(
    expectedError,
  );
}

export function assertSpecOutput(testName: string, options?: CompileOptions) {
  assertOutput(SPEC_DIR, testName, { ...options, macroMode: false });
}

export function assertSpecError(
  testName: string,
  expectedError: string,
  options?: CompileOptions,
) {
  assertError(SPEC_DIR, testName, expectedError, {
    ...options,
    macroMode: false,
  });
}

export function assertMacroOutput(testName: string, options?: CompileOptions) {
  assertOutput(MACRO_DIR, testName, {
    ...options,
    macroMode: true,
  });
}

export function assertEdgeCaseOutput(
  testName: string,
  options?: CompileOptions,
) {
  assertOutput(EDGE_CASES_DIR, testName, { ...options, macroMode: true });
}

export function assertMacroError(
  testName: string,
  expectedError: string,
  options?: CompileOptions,
) {
  assertError(MACRO_DIR, testName, expectedError, {
    ...options,
    macroMode: true,
  });
}

export function assertJsxOutput(testName: string, options?: CompileOptions) {
  assertOutput(JSX_DIR, testName, { jsx: true, ...options }, '.json.tsx');
}

export function assertJsxError(
  testName: string,
  expectedError: string,
  options?: CompileOptions,
) {
  assertError(JSX_DIR, testName, expectedError, { ...options }, '.json.tsx');
}
