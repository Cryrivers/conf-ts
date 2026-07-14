import path from 'path';
import expression, { type Expr } from '@conf-ts/expression';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { compileJsWithMacro, compileNativeWithMacro } from './test-utils';

type Env = Record<string, unknown>;
type Outcome =
  | { kind: 'value'; value: unknown; state: unknown }
  | { kind: 'error'; error: string; state: unknown };

type ParityCase = {
  name: string;
  createEnv: () => Env;
  expected?: unknown;
  state?: (env: Env) => unknown;
  error?: string;
};

const baseEnv = (): Env => ({
  value: null,
  number: 11,
  text: '12',
  label: 'line\n"quoted"\\path',
  enabled: true,
  status: 'active',
  left: 0,
  right: 'right',
  user: { profile: { score: 7 } },
  nested: { score: 8 },
  extra: { other: 9 },
  object: { removable: 1, present: 2 },
  key: 'present',
  counter: {
    value: 2,
    add(this: { value: number }, amount: number) {
      this.value += amount;
      return this.value;
    },
  },
  increment: 3,
  fail() {
    throw new RangeError('boom');
  },
});

const cases: ParityCase[] = [
  { name: 'capturedNumber', createEnv: baseEnv, expected: true },
  { name: 'capturedString', createEnv: baseEnv, expected: true },
  { name: 'capturedBoolean', createEnv: baseEnv, expected: true },
  { name: 'capturedNull', createEnv: baseEnv, expected: true },
  { name: 'capturedEnum', createEnv: baseEnv, expected: true },
  { name: 'computedKey', createEnv: baseEnv, expected: 8 },
  { name: 'asExpression', createEnv: baseEnv, expected: 11 },
  { name: 'satisfiesExpression', createEnv: baseEnv, expected: 11 },
  { name: 'nonNullExpression', createEnv: baseEnv, expected: 11 },
  { name: 'optionalChain', createEnv: baseEnv, expected: 7 },
  {
    name: 'optionalChain',
    createEnv: () => ({ ...baseEnv(), user: null }),
    expected: undefined,
  },
  {
    name: 'objectExpression',
    createEnv: baseEnv,
    expected: { value: 11, other: 9 },
  },
  {
    name: 'arrayExpression',
    createEnv: baseEnv,
    expected: [11, , 10],
  },
  {
    name: 'templateExpression',
    createEnv: baseEnv,
    expected: 'value=11:line\n"quoted"\\path',
  },
  { name: 'unaryPlus', createEnv: baseEnv, expected: 12 },
  { name: 'logicalAnd', createEnv: baseEnv, expected: 0 },
  { name: 'bitwise', createEnv: baseEnv, expected: 23 },
  {
    name: 'methodCall',
    createEnv: baseEnv,
    expected: 5,
    state: env => (env.counter as { value: number }).value,
  },
  {
    name: 'deleteProperty',
    createEnv: baseEnv,
    expected: true,
    state: env => env.object,
  },
  {
    name: 'deleteProperty',
    createEnv: () => {
      const env = baseEnv();
      Object.defineProperty(env.object, 'removable', {
        configurable: false,
        value: 1,
      });
      return env;
    },
    error: 'TypeError',
  },
  { name: 'inOperator', createEnv: baseEnv, expected: true },
  {
    name: 'instanceOf',
    createEnv: () => {
      class Example {}
      return {
        ...baseEnv(),
        Constructor: Example,
        instance: new Example(),
      };
    },
    expected: true,
  },
  {
    name: 'missingMember',
    createEnv: () => ({ ...baseEnv(), user: null }),
    error: 'TypeError',
  },
  {
    name: 'throwingCall',
    createEnv: baseEnv,
    error: 'RangeError',
  },
];

function execute(
  input: string | Expr<Env, unknown>,
  testCase: ParityCase,
): Outcome {
  const env = testCase.createEnv();
  try {
    const value = expression(input)(env);
    return {
      kind: 'value',
      value,
      state: testCase.state?.(env),
    };
  } catch (error) {
    return {
      kind: 'error',
      error: error instanceof Error ? error.constructor.name : typeof error,
      state: testCase.state?.(env),
    };
  }
}

describe('expr runtime/compiler parity', () => {
  let runtimeExpressions: Record<string, Expr<Env, unknown>>;
  let jsExpressions: Record<string, string>;
  let nativeExpressions: Record<string, string>;
  let singleQuoteJsExpressions: Record<string, string>;
  let singleQuoteNativeExpressions: Record<string, string>;

  beforeAll(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      runtimeExpressions = (await import('./fixtures/macros/expr-parity.conf'))
        .default as unknown as Record<string, Expr<Env, unknown>>;
    } finally {
      warn.mockRestore();
    }

    const file = path.resolve(__dirname, 'fixtures/macros/expr-parity.conf.ts');
    jsExpressions = JSON.parse(
      compileJsWithMacro(file, 'json', { macro: true }).output,
    );
    nativeExpressions = JSON.parse(
      compileNativeWithMacro(file, 'json', { macro: true }).output,
    );
    singleQuoteJsExpressions = JSON.parse(
      compileJsWithMacro(file, 'json', { macro: true, quote: 'single' }).output,
    );
    singleQuoteNativeExpressions = JSON.parse(
      compileNativeWithMacro(file, 'json', { macro: true, quote: 'single' })
        .output,
    );
  });

  it.each(cases)(
    '$name has identical runtime and compiled results',
    testCase => {
      const runtime = execute(runtimeExpressions[testCase.name], testCase);
      const js = execute(jsExpressions[testCase.name], testCase);
      const native = execute(nativeExpressions[testCase.name], testCase);
      const singleQuoteJs = execute(
        singleQuoteJsExpressions[testCase.name],
        testCase,
      );
      const singleQuoteNative = execute(
        singleQuoteNativeExpressions[testCase.name],
        testCase,
      );

      expect(js).toEqual(runtime);
      expect(native).toEqual(runtime);
      expect(singleQuoteJs).toEqual(runtime);
      expect(singleQuoteNative).toEqual(runtime);
      if (testCase.error) {
        expect(runtime).toMatchObject({
          kind: 'error',
          error: testCase.error,
        });
      } else {
        expect(runtime).toMatchObject({
          kind: 'value',
          value: testCase.expected,
        });
      }
    },
  );
});
