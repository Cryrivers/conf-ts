import * as fs from 'fs';
import * as path from 'path';
import { compile as compileJs } from '@conf-ts/compiler';
import { compile as compileNative } from '@conf-ts/compiler-native';
import { expect } from 'vitest';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SPEC_DIR = path.join(FIXTURES_DIR, 'specs');
const MACRO_DIR = path.join(FIXTURES_DIR, 'macros');
const EDGE_CASES_DIR = path.join(FIXTURES_DIR, 'edge-cases');

function assertOutput(
  inputFolder: string,
  testName: string,
  options?: { preserveKeyOrder?: boolean; macroMode?: boolean },
) {
  const inputFilePath = path.join(inputFolder, `${testName}.conf.ts`);
  const expectedOutputFilePath = path.join(inputFolder, `${testName}.json`);

  const expectedOutput = fs.readFileSync(expectedOutputFilePath, 'utf-8');
  const expectedYamlOutputFilePath = path.join(inputFolder, `${testName}.yaml`);
  const expectedYamlOutput = fs.readFileSync(
    expectedYamlOutputFilePath,
    'utf-8',
  );

  const { output: jsonResultJs } = compileJs(inputFilePath, 'json', options);
  const { output: yamlResultJs } = compileJs(inputFilePath, 'yaml', options);
  const { output: jsonResultNative } = compileNative(
    inputFilePath,
    'json',
    options,
  );
  const { output: yamlResultNative } = compileNative(
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
  options?: { preserveKeyOrder?: boolean; macroMode?: boolean },
) {
  const inputFilePath = path.join(inputFolder, `${testName}.conf.ts`);
  expect(() => compileJs(inputFilePath, 'json', options)).toThrow(
    expectedError,
  );
  expect(() => compileNative(inputFilePath, 'json', options)).toThrow(
    expectedError,
  );
}

export function assertSpecOutput(
  testName: string,
  options?: { preserveKeyOrder?: boolean },
) {
  assertOutput(SPEC_DIR, testName, { ...options, macroMode: false });
}

export function assertSpecError(
  testName: string,
  expectedError: string,
  options?: { preserveKeyOrder?: boolean },
) {
  assertError(SPEC_DIR, testName, expectedError, {
    ...options,
    macroMode: false,
  });
}

export function assertMacroOutput(
  testName: string,
  options?: { preserveKeyOrder?: boolean },
) {
  assertOutput(MACRO_DIR, testName, {
    ...options,
    macroMode: true,
  });
}

export function assertEdgeCaseOutput(
  testName: string,
  options?: { preserveKeyOrder?: boolean },
) {
  assertOutput(EDGE_CASES_DIR, testName, { ...options, macroMode: true });
}

export function assertMacroError(
  testName: string,
  expectedError: string,
  options?: { preserveKeyOrder?: boolean },
) {
  assertError(MACRO_DIR, testName, expectedError, {
    ...options,
    macroMode: true,
  });
}
