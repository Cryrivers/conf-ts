import * as exprCore from '@conf-ts/expr-core';
import { describe, expect, it } from 'vitest';

import expression, { compile } from '../src';
import * as core from '../src/core';

const parse = (source: string) => core.parse(core.tokenize(source), source);

// Both execution modes; `compile` is strict so a failed code generation
// can't silently fall back to the interpreter.
const modes = {
  interpreted: (source: string) => expression(source),
  compiled: (source: string) => compile(source, { strict: true }),
};

describe('@conf-ts/expression/core', () => {
  it('re-exports @conf-ts/expr-core itself', () => {
    expect(Object.keys(core).sort()).toEqual(Object.keys(exprCore).sort());
    for (const [name, value] of Object.entries(exprCore)) {
      expect(core[name as keyof typeof core], name).toBe(value);
    }
  });

  it.each(Object.entries(modes))(
    'is where %s expressions get their ExprSyntaxError from',
    (_, run) => {
      let error: unknown;
      try {
        run('a +');
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(core.ExprSyntaxError);
      expect(error).toMatchObject({
        message: 'parse expression error: a +',
        detail: 'unexpected end of expression',
        start: 3,
        end: 3,
      });
    },
  );
});

describe.each(Object.entries(modes))('%s expressions', (_, run) => {
  it('read mixed-case keywords from the environment', () => {
    const env = { TRUE: 'T', False: 'F', Null: 1, Undefined: 2 };
    expect(run('[TRUE, False, Null, Undefined]')(env)).toEqual([
      'T',
      'F',
      1,
      2,
    ]);
    expect(run('[true, false, null, undefined]')(env)).toEqual([
      true,
      false,
      null,
      undefined,
    ]);
    expect(run('o.TRUE + o.Null')({ o: { TRUE: 1, Null: 2 } })).toBe(3);
  });

  it('parse conditionals whose branches start with `(` or `[`', () => {
    expect(run('a ? (b + 1) * 2 : [0]')({ a: true, b: 2 })).toBe(6);
    expect(run('a ? (b + 1) * 2 : [0]')({ a: false, b: 2 })).toEqual([0]);
    expect(run('a ?[1]:[2]')({ a: 0 })).toEqual([2]);
  });

  it('support optional calls written `?.(`', () => {
    const source = 'fn?.(2) ?? "none"';
    expect(run(source)({ fn: (value: number) => value * 3 })).toBe(6);
    expect(run(source)({})).toBe('none');
    expect(run('o.method?.(1)')({ o: {} })).toBeUndefined();
  });

  it('pass complete raw strings to template tags', () => {
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => [
      [...strings.raw],
      [...strings],
      values,
    ];
    expect(run('tag`\\u0041${1}\\n`')({ tag })).toEqual([
      ['\\u0041', '\\n'],
      ['A', '\n'],
      [1],
    ]);
  });

  it('evaluate nested template literals with escapes, strings, and braces', () => {
    expect(run('`${`\\u0041${`\\u0042`}`}`')({})).toBe('AB');
    expect(run('`${ {a: "}"}["a"] + `${`}`}\\u0041` + \'`\' }!`')({})).toBe(
      '}}A`!',
    );
  });
});

describe('print()', () => {
  // [source, environment factory]; each run gets a fresh environment because
  // some expressions mutate it.
  const cases: Array<[string, () => Record<string, unknown>]> = [
    ['a + b * c', () => ({ a: 1, b: 2, c: 3 })],
    ['(a + b) * c - (d - e)', () => ({ a: 1, b: 2, c: 3, d: 4, e: 5 })],
    ['2 ** 3 ** 2 + (-2) ** 2', () => ({})],
    ['a ?? b || c', () => ({ a: null, b: 0, c: 3 })],
    ['!(a && b) === (!a || !b)', () => ({ a: true, b: false })],
    ['typeof a === "string" ? a.length : - -a', () => ({ a: 'xyz' })],
    ['a ? b ? 1 : 2 : c ? 3 : 4', () => ({ a: true, b: false, c: true })],
    ['a?.b.c ?? (a?.b).c', () => ({ a: { b: { c: 7 } } })],
    ['f?.(1) ?? g?.(2)', () => ({ g: (value: number) => value + 1 })],
    [
      'xs.map((x, i = 2) => x * i).filter(x => x > 2)',
      () => ({ xs: [1, 2, 3] }),
    ],
    [
      '(({a, b: c = 9}, [d, , e = 4] = [1], ...rest) => a + c + d + e + rest.length)({a: 1}, undefined, 0, 0)',
      () => ({}),
    ],
    ['`x${a}y${`n${b}`}\\u0041`', () => ({ a: 1, b: 2 })],
    [
      'tag`a${b}\\n`',
      () => ({ tag: (s: TemplateStringsArray) => s.raw.join('|'), b: 1 }),
    ],
    [
      '{a, "b-c": 1, [k]: v, ...s, in: 2}',
      () => ({ a: 1, k: 'key', v: 2, s: { z: 3 } }),
    ],
    ['[1, , ...xs, ,]', () => ({ xs: [2] })],
    ['delete o.x && !("x" in o)', () => ({ o: { x: 1 } })],
    ['1.5.toFixed(1) + (1).toFixed(1) + 1e21', () => ({})],
    ['String(a) + Number("2") + TRUE', () => ({ a: 1, TRUE: '!' })],
    ['(x => x * 2)(a) + [x => x][0](1)', () => ({ a: 3 })],
    ['x => ({a: x})', () => ({})],
  ];

  it.each(cases)('%s prints to an equivalent expression', (source, env) => {
    const printed = core.print(parse(source));
    for (const run of Object.values(modes)) {
      const expected = expression(source)(env());
      const actual = run(printed)(env());
      if (typeof expected === 'function') {
        expect((actual as (x: number) => unknown)(5)).toEqual(
          (expected as (x: number) => unknown)(5),
        );
      } else {
        expect(actual).toEqual(expected);
      }
    }
  });

  it('prints literal values that have no literal syntax so they evaluate back', () => {
    const values = [-5, -0, NaN, Infinity, -Infinity, 'a"\'\\\b\0 \ud800😀'];
    for (const value of values) {
      const printed = core.print({ type: 'Literal', value });
      for (const run of Object.values(modes)) {
        expect(Object.is(run(printed)({}), value), printed).toBe(true);
      }
    }
  });
});
