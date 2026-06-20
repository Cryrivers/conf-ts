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

  it('returns a callback that evaluates context property access', () => {
    const callback = (ctx: { a: number; b: number }) => ctx.a > ctx.b;
    const runtimeExpr = expr(callback);

    expect(runtimeExpr).toBe(callback);
    expect(expression(runtimeExpr)({ a: 2, b: 1 })).toBe(true);
  });

  it('evaluates nested context property access', () => {
    const compiled = expression(
      expr<{ user: { age: number }; limit: number }, boolean>(
        ctx => ctx.user.age >= ctx.limit,
      ),
    );

    expect(compiled({ user: { age: 18 }, limit: 18 })).toBe(true);
  });

  it('supports valid computed and captured context keys', () => {
    const key = 'a';

    expect(
      expression(expr<{ a: number }, number>(ctx => ctx['a']))({ a: 3 }),
    ).toBe(3);
    expect(
      expression(expr<{ a: number }, number>(ctx => ctx[key]))({ a: 4 }),
    ).toBe(4);
  });

  it('preserves captured closure values', () => {
    const threshold = 10;
    const compiled = expression(
      expr<{ value: number }, boolean>(ctx => ctx.value > threshold),
    );

    expect(compiled({ value: 11 })).toBe(true);
    expect(compiled({ value: 10 })).toBe(false);
  });

  it('supports extended binary and unary operators', () => {
    class Example {}
    const object: { removable?: number } = { removable: 1 };
    const instance = new Example();

    expect(
      expression(
        expr<{ base: number; exponent: number }, number>(
          ctx => ctx.base ** ctx.exponent,
        ),
      )({ base: 2, exponent: 3 }),
    ).toBe(8);
    expect(
      expression(
        expr<{ value: object; Constructor: typeof Example }, boolean>(
          ctx => ctx.value instanceof ctx.Constructor,
        ),
      )({ value: instance, Constructor: Example }),
    ).toBe(true);
    expect(
      expression(expr<{ value: unknown }, string>(ctx => typeof ctx.value))({
        value: null,
      }),
    ).toBe('object');
    expect(
      expression(
        expr<{ object: { removable?: number } }, boolean>(
          ctx => delete ctx.object.removable,
        ),
      )({ object }),
    ).toBe(true);
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

  it('rejects syntax unsupported by @conf-ts/expression', () => {
    expect(() => expr<{ a: number }, number>(ctx => (ctx.a = 2))).toThrow(
      'parse expression error',
    );
  });
});
