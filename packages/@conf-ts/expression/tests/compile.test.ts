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

/** Also compares the side effects the environment records while running. */
const expectParityWithLog = (
  source: string,
  makeEnv: (log: unknown[]) => Record<string, unknown>,
  options?: CompileOptions,
): void => {
  const run = (fn: (env: Record<string, unknown>) => unknown) => {
    const log: unknown[] = [];
    return { outcome: capture(() => fn(makeEnv(log))), log };
  };
  expect(run(compile(source, { ...options, strict: true }))).toEqual(
    run(expression(source, options)),
  );
};

const call =
  (...args: unknown[]) =>
  (value: unknown): unknown =>
    (value as (...args: unknown[]) => unknown)(...args);

const describeFunction = (value: unknown) => {
  const fn = value as (...args: unknown[]) => unknown;
  return [typeof fn, fn.length, fn.name, 'prototype' in fn];
};

const describeArray = (value: unknown) => {
  const array = value as unknown[];
  return [array.length, Object.keys(array), [...array]];
};

const describeObject = (value: unknown) => {
  const object = value as Record<PropertyKey, unknown>;
  const prototype = Object.getPrototypeOf(object) as object;
  return [
    Reflect.ownKeys(object),
    { ...object },
    prototype === Object.prototype ? 'Object.prototype' : { ...prototype },
  ];
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

  it('matches evaluation order and receivers of member chains and calls', () => {
    const makeEnv = (log: unknown[]): Record<string, unknown> => ({
      log(value: unknown) {
        log.push(value);
        return value;
      },
      missing: undefined,
      object: {
        base: 4,
        method(this: { base: number }, value: number) {
          return this.base + value;
        },
        receiver() {
          return this === undefined;
        },
        tag(this: { base: number }, strings: TemplateStringsArray) {
          return [this.base, strings.raw[0]];
        },
      },
    });
    for (const [source, options] of [
      ['object.notCallable(log("argument"))'],
      ['missing[log("key")]'],
      ['missing?.[log("key")].deep'],
      ['object.nothing?(log("argument"))'],
      ['object.method?(log(2))'],
      ['object.method(log(1)) + object["method"](log(2))'],
      ['(object.receiver)()'],
      ['"abc".toUpperCase().length'],
      ['object.tag`x${log(1)}`'],
      ['missing.tag`x${log(1)}`'],
      ['missing.tag`x${log(1)}`', { loose: true }],
      ['missing.deep[log("key")].call(log("argument"))', { loose: true }],
      ['object.nothing.call(log("argument"))', { loose: true }],
      ['delete object.base && object.base'],
      ['delete missing?.deep.path'],
      ['delete missing.deep[log("key")]', { loose: true }],
    ] as Array<[string, CompileOptions?]>) {
      expectParityWithLog(source, makeEnv, options);
    }
  });

  it('matches arrow scoping, defaults, and closures', () => {
    const cases: Array<
      [
        source: string,
        makeEnv: () => Record<string, unknown>,
        consume: (value: unknown) => unknown,
      ]
    > = [
      ['(b = a, a) => [a, b]', () => ({ a: 'outer' }), call(undefined, 'p')],
      ['(a, a) => a', () => ({}), call(1, 2)],
      ['(a, ...rest) => [a, rest]', () => ({}), call(1, 2, 3)],
      [
        '({a, b = a}, [c, , d = c] = [1, 2, 3]) => [a, b, c, d]',
        () => ({}),
        call({ a: 5 }),
      ],
      ['({a}) => a', () => ({}), call(null)],
      ['([a, b]) => a + b', () => ({}), call('xy')],
      ['(f = () => x, x) => f()', () => ({ x: 'outer' }), call(undefined, 1)],
      [
        '(f = () => x, y = f(), x) => [y, x, f()]',
        () => ({ x: 'outer' }),
        call(undefined, undefined, 'param'),
      ],
      [
        'd => (c = d, d) => [c, d]',
        () => ({ d: 'root' }),
        value =>
          (call('outer')(value) as (...args: unknown[]) => unknown)(
            undefined,
            'inner',
          ),
      ],
      ['x => x', () => ({}), value => describeFunction(value)],
      [
        '{ f: x => x, g: (a = 1) => a }',
        () => ({}),
        value => {
          const object = value as Record<string, unknown>;
          return [describeFunction(object.f), describeFunction(object.g)];
        },
      ],
      [
        '[hidden, [0].map(x => hidden)]',
        () =>
          Object.defineProperty({ visible: 1 }, 'hidden', {
            value: 2,
            enumerable: false,
          }),
        value => value,
      ],
      [
        '[0, 1].map(x => [bump(), counter, (() => counter)()])',
        () => {
          const env: Record<string, unknown> = {
            counter: 0,
            bump() {
              env.counter = (env.counter as number) + 1;
            },
          };
          return env;
        },
        value => value,
      ],
      [
        '[1].map(x => [String(x), Number, constructor, typeof hasOwnProperty])',
        () => ({ Number: 'shadowed' }),
        value => value,
      ],
      [
        'outer => inner => [outer, inner, shared]',
        () => ({ shared: 's' }),
        value => (value as (a: number) => (b: number) => unknown)(1)(2),
      ],
      [
        'items.map(item => item.values.map(value => value * scale))',
        () => ({ items: [{ values: [1, 2] }, { values: [3] }], scale: 10 }),
        value => value,
      ],
      [
        '[1].map(x => [delete x, x, delete y, y, typeof String])',
        () => ({ y: 2 }),
        value => value,
      ],
      [
        '[1].map(x => (inner => [delete x, x, inner])(x))',
        () => ({}),
        value => value,
      ],
    ];
    for (const [source, makeEnv, consume] of cases) {
      expectParity(source, makeEnv, undefined, consume);
    }

    expectParity('[1, 2].map(x => x * y)', () => undefined as never);
    expectParity('[1, 2].map(x => x)', () => null as never);

    const env = { y: 2 };
    compile('[1].map(x => delete y)', { strict: true })(env);
    expect(env).toEqual({ y: 2 });
  });

  it('matches array and object literal construction', () => {
    const symbol = Symbol('s');
    const cases: Array<
      [
        source: string,
        makeEnv: () => Record<string, unknown>,
        consume: (value: unknown) => unknown,
      ]
    > = [
      ['[1, , 2]', () => ({}), describeArray],
      ['[1, ,]', () => ({}), describeArray],
      ['[,]', () => ({}), describeArray],
      ['[...text, ...[]]', () => ({ text: 'ab' }), describeArray],
      [
        '{ own: 1, __proto__: proto }',
        () => ({ proto: { inherited: 2 } }),
        describeObject,
      ],
      [
        '{ [key]: value }',
        () => ({ key: '__proto__', value: {} }),
        describeObject,
      ],
      [
        '{ a: 1, ...rest, a: 2, [key]: 3, ...more, "quoted-key": 4, class: 5 }',
        () => ({ rest: { b: 1, a: 0 }, more: 'xy', key: symbol }),
        describeObject,
      ],
      ['`${value}!`', () => ({ value: symbol }), value => value],
    ];
    for (const [source, makeEnv, consume] of cases) {
      expectParity(source, makeEnv, undefined, consume);
    }

    const prototype = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toString',
    )!;
    Object.defineProperty(Object.prototype, 'toString', {
      ...prototype,
      writable: false,
    });
    try {
      expectParity('{ first: 1, toString: value }', () => ({ value: 2 }));
    } finally {
      Object.defineProperty(Object.prototype, 'toString', prototype);
    }

    expectParityWithLog('{ [key]: log("value") }', log => ({
      key: {
        toString() {
          log.push('key');
          return 'k';
        },
      },
      log(value: unknown) {
        log.push(value);
        return value;
      },
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
