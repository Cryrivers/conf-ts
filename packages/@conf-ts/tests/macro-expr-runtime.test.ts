import expression from '@conf-ts/expression';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const callbackError =
  'expr callback must be an arrow function with a single identifier parameter and expression body';

let expr: typeof import('@conf-ts/macro').expr;

describe('Macro expr runtime helper', () => {
  beforeAll(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expr = (await import('@conf-ts/macro')).expr;
    } finally {
      warn.mockRestore();
    }
  });

  it('converts context property access into an expression string', () => {
    expect(expr<{ a: number; b: number }, boolean>(ctx => ctx.a > ctx.b)).toBe(
      'a > b',
    );
  });

  it('converts nested context property access', () => {
    expect(
      expr<{ user: { age: number }; limit: number }, boolean>(
        ctx => ctx.user.age >= ctx.limit,
      ),
    ).toBe('user.age >= limit');
  });

  it('supports valid computed string context keys', () => {
    expect(expr<{ a: number }, number>(ctx => ctx['a'])).toBe('a');
  });

  it('returns an expression consumable by @conf-ts/expression', () => {
    const compiled = expression(
      expr<{ a: number; b: number }, boolean>(ctx => ctx.a > ctx.b),
    );

    expect(compiled({ a: 2, b: 1 })).toBe(true);
    expect(compiled({ a: 1, b: 2 })).toBe(false);
  });

  it('supports extended binary and unary operators', () => {
    class Example {}
    const object: { removable?: number } = { removable: 1 };

    expect(
      expr<{ base: number; exponent: number }, number>(
        ctx => ctx.base ** ctx.exponent,
      ),
    ).toBe('base ** exponent');
    expect(
      expr<{ value: object; Constructor: typeof Example }, boolean>(
        ctx => ctx.value instanceof ctx.Constructor,
      ),
    ).toBe('value instanceof Constructor');
    expect(expr<{ value: unknown }, string>(ctx => typeof ctx.value)).toBe(
      'typeof value',
    );
    expect(expression('delete object.removable')({ object })).toBe(true);
    expect(object).toEqual({});
  });

  it('rejects block bodies', () => {
    expect(() =>
      expr<{ a: number }, number>(ctx => {
        return ctx.a;
      }),
    ).toThrow(callbackError);
  });

  it('rejects function expressions', () => {
    expect(() =>
      expr<{ a: number }, number>(function (ctx) {
        return ctx.a;
      }),
    ).toThrow(callbackError);
  });

  it('rejects direct context parameter usage', () => {
    expect(() => expr<{ a: number }, { a: number }>(ctx => ctx)).toThrow(
      'expr callback cannot use the context parameter directly',
    );
  });

  it('rejects dynamic root context access', () => {
    const key = 'a';

    expect(() => expr<{ a: number }, number>(ctx => ctx[key])).toThrow(
      'expr callback can only access context properties with identifier property names',
    );
  });

  it('rejects syntax unsupported by @conf-ts/expression', () => {
    expect(() => expr<{ a: number }, number>(ctx => (ctx.a = 2))).toThrow(
      'parse expression error',
    );
  });
});
