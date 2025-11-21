import * as fs from 'fs';
import * as path from 'path';
import { expect } from 'vitest';

import { compile } from '../src/compiler';

const SPEC_DIR = path.join(__dirname, 'specs');
const MACRO_DIR = path.join(__dirname, 'macros');

function assertOutput(
  inputFolder: string,
  testName: string,
  options?: { preserveKeyOrder?: boolean; macro?: boolean },
) {
  const inputFilePath = path.join(inputFolder, `${testName}.conf.ts`);
  const expectedOutputFilePath = path.join(inputFolder, `${testName}.json`);

  const expectedOutput = JSON.parse(
    fs.readFileSync(expectedOutputFilePath, 'utf-8'),
  );
  const expectedYamlOutputFilePath = path.join(inputFolder, `${testName}.yaml`);
  const expectedYamlOutput = fs.readFileSync(
    expectedYamlOutputFilePath,
    'utf-8',
  );

  const jsonResult = JSON.parse(compile(inputFilePath, 'json', options).output);
  const { output: yamlResult } = compile(inputFilePath, 'yaml', options);
  expect(jsonResult).toEqual(expectedOutput);
  expect(yamlResult.trimEnd()).toEqual(expectedYamlOutput.trimEnd());
}

function assertError(
  inputFolder: string,
  testName: string,
  expectedError: string,
  options?: { preserveKeyOrder?: boolean; macro?: boolean },
) {
  const inputFilePath = path.join(inputFolder, `${testName}.conf.ts`);
  expect(() => compile(inputFilePath, 'json', options)).toThrow(expectedError);
}

export function assertSpecOutput(
  testName: string,
  options?: { preserveKeyOrder?: boolean },
) {
  assertOutput(SPEC_DIR, testName, { ...options, macro: false });
}

export function assertSpecError(
  testName: string,
  expectedError: string,
  options?: { preserveKeyOrder?: boolean },
) {
  assertError(SPEC_DIR, testName, expectedError, { ...options, macro: false });
}

export function assertMacroOutput(
  testName: string,
  options?: { preserveKeyOrder?: boolean },
) {
  assertOutput(MACRO_DIR, testName, {
    ...options,
    macro: true,
  });
}

export function assertMacroError(
  testName: string,
  expectedError: string,
  options?: { preserveKeyOrder?: boolean },
) {
  assertError(MACRO_DIR, testName, expectedError, { ...options, macro: true });
}
