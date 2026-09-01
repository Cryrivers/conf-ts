import { describe, expect, it } from 'vitest';

import expression, {
  compile,
  ExpressionCompileError,
  type CompileOptions,
  type Expr,
  type LooseExpr,
} from '../src';

type Outcome = { ok: true; value: unknown } | { ok: false; errorName: string };

const capture = (run: () => unknown): Outcome => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return {
      ok: false,
      errorName: error instanceof Error ? error.constructor.name : typeof error,
    };
  }
};

const expectParity = (
  source: string,
  makeEnv: () => Record<string, unknown>,
  options?: CompileOptions,
  consume: (value: unknown) => unknown = value => value,
): void => {
  const interpreted = expression(source, options);
  const compiled = compile(source, { ...options, strict: true });

  const interpretedOutcome = capture(() => consume(interpreted(makeEnv())));
  const compiledOutcome = capture(() => consume(compiled(makeEnv())));
  expect(compiledOutcome).toEqual(interpretedOutcome);
};

describe('compile()', () => {
  it('matches the interpreter across the supported expression grammar', () => {
    const symbol = Symbol('computed');
    const cases: Array<
      [
        source: string,
        makeEnv: () => Record<string, unknown>,
        consume?: (value: unknown) => unknown,
      ]
    > = [
      ['2e3 + 2e-3', () => ({})],
      ['1e999', () => ({})],
      ['+value + -other', () => ({ value: '12', other: 2 })],
      ['2 ** 3 ** 2', () => ({})],
      ['a + b * c > 10 ? "large" : "small"', () => ({ a: 1, b: 3, c: 4 })],
      ['a && b || c ?? d', () => ({ a: true, b: 0, c: null, d: 4 })],
      ['flags & mask | extra', () => ({ flags: 7, mask: 3, extra: 8 })],
      ['key in object', () => ({ key: 'x', object: { x: 1 } })],
      ['value instanceof Type', () => ({ value: new Date(), Type: Date })],
      ['a.list[index + 1]', () => ({ a: { list: [1, 2, 3] }, index: 1 })],
      ['a?.b.c', () => ({})],
      ['(a?.b).c', () => ({})],
      ['a?.[key]?.value', () => ({ a: { x: { value: 3 } }, key: 'x' })],
      ['fn?(2)', () => ({ fn: undefined })],
      ['fn?(2)', () => ({ fn: (value: number) => value * 3 })],
      [
        'object.method(2)',
        () => ({
          object: {
            base: 4,
            method(this: { base: number }, value: number) {
              return this.base + value;
            },
          },
        }),
      ],
      ['[0, ...items, , 4]', () => ({ items: new Set([1, 2, 3]) })],
      [
        '{ ...base, [key]: value, shorthand }',
        () => ({ base: { x: 1 }, key: symbol, value: 2, shorthand: 3 }),
      ],
      ['`hello ${name}, ${count + 1}`', () => ({ name: 'world', count: 2 })],
      [
        'tag`A\\n${value}B`',
        () => ({
          value: 2,
          tag(strings: TemplateStringsArray, value: unknown) {
            return [strings[0], strings.raw[0], strings[1], value];
          },
        }),
      ],
      [
        'items.filter(item => item.score >= threshold).map(item => item.score * weight)',
        () => ({
          items: [{ score: 1 }, { score: 5 }, { score: 8 }],
          threshold: 5,
          weight: 2,
        }),
      ],
      [
        'matrix.filter(row => row.some(cell => cell > threshold)).length',
        () => ({ matrix: [[-1], [1, 2], [5]], threshold: 2 }),
      ],
      [
        '({a: first, b = first + 1} = {a: 4}) => first + b',
        () => ({}),
        value => (value as (arg?: unknown) => unknown)(),
      ],
      [
        '([, second = 3], ...rest) => second + rest.length',
        () => ({}),
        value =>
          (value as (first: unknown, ...rest: unknown[]) => unknown)(
            [1, undefined],
            4,
            5,
          ),
      ],
      [
        'a => b => a + b + outer',
        () => ({ outer: 3 }),
        value => (value as (a: number) => (b: number) => number)(1)(2),
      ],
      ['String(value) + Number(offset)', () => ({ value: 12, offset: '3' })],
      ['constructor', () => ({})],
      [']legacy', () => ({})],
    ];

    for (const [source, makeEnv, consume] of cases) {
      expectParity(source, makeEnv, undefined, consume);
    }
  });

  it('matches loose member access, including interrupted computed keys and calls', () => {
    expectParity(
      'a.b[key()].value',
      () => ({
        a: {},
        key() {
          throw new Error('must not run');
        },
      }),
      { loose: true },
    );
    expectParity('a.b.c()', () => ({ a: {} }), { loose: true });
    expectParity('a.b()', () => ({ a: {} }), { loose: true });
  });

  it('preserves delete behavior and evaluation order', () => {
    for (const source of [
      'delete object.value',
      'delete object?.value',
      'delete missing.path',
      'delete (sideEffect())',
    ]) {
      expectParity(source, () => {
        const env: Record<string, unknown> = {
          object: { value: 1 },
          sideEffect() {
            env.called = true;
            return 1;
          },
        };
        return env;
      });
    }
  });

  it('propagates accessor, proxy, callback, and non-callable errors by type', () => {
    expectParity('value.missing', () => ({ value: null }));
    expectParity('fn()', () => ({ fn: 1 }));
    expectParity('fn()', () => ({
      fn: () => {
        throw new RangeError('boom');
      },
    }));
    expectParity('proxy.value', () => ({
      proxy: new Proxy(
        {},
        {
          get() {
            throw new SyntaxError('proxy getter');
          },
        },
      ),
    }));
  });

  it('does not expose generated-function globals through root identifier lookup', () => {
    expect(compile('constructor', { strict: true })({})).toBeUndefined();
    expect(compile('globalThis', { strict: true })({})).toBeUndefined();
    expect(() =>
      compile('constructor.constructor("return globalThis")()', {
        strict: true,
      })({}),
    ).toThrow(TypeError);

    const payload = '"});return globalThis.process;//\u2028';
    expect(compile(JSON.stringify(payload), { strict: true })({})).toBe(
      payload,
    );
  });

  it('caches successful compiled functions independently by option mode', () => {
    const source = 'cacheValue.deep.path';
    const strict = compile(source, { strict: true });
    const strictAgain = compile(source, { strict: true });
    const loose = compile(source, { loose: true, strict: true });

    expect(strictAgain).toBe(strict);
    expect(loose).not.toBe(strict);
    expect(expression(source)).not.toBe(strict);
  });

  it('falls back when Function construction is blocked and strict mode exposes it', () => {
    const OriginalFunction = globalThis.Function;
    let fallback: (env: Record<string, number>) => unknown;
    globalThis.Function = function blockedFunction(): never {
      throw new EvalError('blocked by CSP');
    } as unknown as FunctionConstructor;

    try {
      fallback = compile('cspValue + 1');
      expect(fallback({ cspValue: 2 })).toBe(3);
      expect(() => compile('cspStrictValue + 1', { strict: true })).toThrow(
        ExpressionCompileError,
      );
    } finally {
      globalThis.Function = OriginalFunction;
    }

    const compiledAfterCsp = compile('cspValue + 1', { strict: true });
    expect(compiledAfterCsp).not.toBe(fallback!);
    expect(compiledAfterCsp({ cspValue: 2 })).toBe(3);
  });
});

describe('compile() types', () => {
  type Context = { nested?: { value?: number } };

  const fakeExpr = <Result>(
    callback: (ctx: Context) => Result,
  ): Expr<Context, Result> => callback as unknown as Expr<Context, Result>;

  it('keeps Expr context and return types', () => {
    const source = fakeExpr(ctx => ctx.nested?.value ?? 0);
    expect(() => {
      const compiled = compile(source);
      const value: number = compiled({});
      expect(typeof value).toBe('number');
    }).toThrow();
  });

  it('accepts LooseExpr only with loose evaluation enabled', () => {
    const source = fakeExpr(ctx => ctx.nested?.value) as LooseExpr<
      Context,
      number | undefined
    >;
    expect(() => {
      const compiled = compile(source, { loose: true });
      compiled({});
    }).toThrow();
  });
});
