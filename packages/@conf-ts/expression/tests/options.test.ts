import { describe, expect, it } from 'vitest';

import expression from '../src';
import * as expressionModule from '../src';
import type { Expr, LooseExpr, RuntimeEnv } from '../src';

// Mirrors @conf-ts/macro's `expr()` type signature without depending on that
// package (the macro-transformer replaces expr(cb) with a compiled string;
// here we only need the identity behavior to exercise the type surface).
function fakeExpr<
  Context extends RuntimeEnv = RuntimeEnv,
  ReturnType = unknown,
>(callback: (ctx: Context) => ReturnType): Expr<Context, ReturnType> {
  return callback as unknown as Expr<Context, ReturnType>;
}

type DeeplyOptionalContext = { a?: { b?: { c?: number } } };
type ArrayOptionalContext = { a?: { b?: { c?: number } }[] };

describe('optionalMemberAccess', () => {
  it('short-circuits missing non-optional member access', () => {
    const expr = expression('a.b.c.d', { optionalMemberAccess: true });

    expect(expr({ a: {} })).toBe(undefined);
    expect(expr({ a: { b: null } })).toBe(undefined);
  });

  it('preserves strict member access by default', () => {
    const expr = expression('a.b.c.d');

    expect(() => expr({ a: {} })).toThrow(TypeError);
  });

  it('works with logical operators', () => {
    const expr = expression('a.b.c.d || true', {
      optionalMemberAccess: true,
    });

    expect(expr({ a: {} })).toBe(true);
  });

  it('isolates the expression cache by option mode', () => {
    const source = 'a.b.c.d';
    const strict = expression(source);
    const tolerant = expression(source, { optionalMemberAccess: true });

    expect(expression(source)).toBe(strict);
    expect(expression(source, { optionalMemberAccess: true })).toBe(tolerant);
    expect(strict).not.toBe(tolerant);
    expect(() => strict({ a: {} })).toThrow(TypeError);
    expect(tolerant({ a: {} })).toBe(undefined);
  });

  it('handles computed access and avoids computed key evaluation after interruption', () => {
    const computed = expression('a[key].c', { optionalMemberAccess: true });
    expect(computed({ a: { b: { c: 1 } }, key: 'b' })).toBe(1);
    expect(computed({ a: {}, key: 'missing' })).toBe(undefined);

    const interrupted = expression('a.b[key()]', {
      optionalMemberAccess: true,
    });
    expect(
      interrupted({
        a: {},
        key() {
          throw new Error('key evaluated');
        },
      }),
    ).toBe(undefined);
  });

  it('short-circuits chained array/bracket access like a[b][c]', () => {
    const expr = expression('a[b][c]', { optionalMemberAccess: true });

    expect(expr({})).toBe(undefined);
    expect(expr({ a: [] })).toBe(undefined);
    expect(expr({ a: [null] })).toBe(undefined);
    expect(expr({ a: [[, , 42]], b: 0, c: 2 })).toBe(42);
  });

  it('does not make calls optional', () => {
    expect(
      expression('a.b.c()', { optionalMemberAccess: true })({ a: {} }),
    ).toBe(undefined);
    expect(() =>
      expression('a.b()', { optionalMemberAccess: true })({ a: {} }),
    ).toThrow(TypeError);
    expect(expression('a.b()', { optionalMemberAccess: true })({})).toBe(
      undefined,
    );
  });

  it('short-circuits delete and keeps leading bracket cache entries isolated', () => {
    expect(
      expression('delete a.b.c', { optionalMemberAccess: true })({ a: {} }),
    ).toBe(true);

    const strict = expression(']123');
    const tolerant = expression(']123', { optionalMemberAccess: true });
    expect(expression(']123')).toBe(strict);
    expect(expression(']123', { optionalMemberAccess: true })).toBe(tolerant);
    expect(strict).not.toBe(tolerant);
    expect(strict({})).toBe(undefined);
    expect(tolerant({})).toBe(undefined);
  });
});

describe('loose alias', () => {
  it('behaves identically to optionalMemberAccess for short-circuiting', () => {
    const expr = expression('m.n.o.p', { loose: true });

    expect(expr({ m: {} })).toBe(undefined);
    expect(expr({ m: { n: null } })).toBe(undefined);
  });

  it('works with logical operators', () => {
    const expr = expression('m.n.o.p || true', { loose: true });

    expect(expr({ m: {} })).toBe(true);
  });

  it('shares the same cache entry as optionalMemberAccess for the same source', () => {
    const source = 'm.n.o.p';
    const viaOption = expression(source, { optionalMemberAccess: true });
    const viaAlias = expression(source, { loose: true });

    expect(viaAlias).toBe(viaOption);
  });
});

describe('LooseExpr type', () => {
  it('lets a callback skip `?.` on deeply optional context', () => {
    const looseExpr: LooseExpr<DeeplyOptionalContext, number | boolean> =
      fakeExpr(ctx => ctx.a.b.c || true);

    expect(typeof looseExpr).toBe('function');
  });

  it('still requires `?.` when annotated as the strict Expr type', () => {
    // @ts-expect-error `ctx.a` is possibly undefined without LooseExpr
    const strictExpr: Expr<DeeplyOptionalContext, number | boolean> = fakeExpr(
      ctx => ctx.a.b.c || true,
    );

    expect(typeof strictExpr).toBe('function');
  });

  it('expression() accepts a LooseExpr once optionalMemberAccess/loose is enabled', () => {
    const looseExpr: LooseExpr<DeeplyOptionalContext, number | boolean> =
      fakeExpr(ctx => ctx.a.b.c || true);

    expect(() => {
      const viaOption = expression(looseExpr, { optionalMemberAccess: true });
      viaOption({}); // 'a' is optional in the original (unloosened) context
      const viaAlias = expression(looseExpr, { loose: true });
      viaAlias({});
    }).toThrow(); // fakeExpr returns the raw callback, not a compiled string
  });

  it('falls back to a deeply-required Compiled signature without the option', () => {
    const looseExpr: LooseExpr<DeeplyOptionalContext, number | boolean> =
      fakeExpr(ctx => ctx.a.b.c || true);

    expect(() => {
      const compiledStrict = expression(looseExpr);
      // @ts-expect-error without the option, Compiled requires 'a' to be present
      compiledStrict({});
    }).toThrow(); // fakeExpr returns the raw callback, not a compiled string
  });

  it('lets a callback skip `?.` through an array of optional-field elements', () => {
    // ctx.a[0].b.c needs `b` to be non-optional on the array element to read
    // `.c` off it without `?.` — this exercises LooseContext recursing into
    // array element types, not just top-level object properties.
    const looseExpr: LooseExpr<ArrayOptionalContext, number | boolean> =
      fakeExpr(ctx => ctx.a[0].b.c || true);

    expect(typeof looseExpr).toBe('function');
  });

  it('still requires `?.` through arrays when annotated as the strict Expr type', () => {
    // @ts-expect-error `ctx.a` is possibly undefined without LooseExpr
    const strictExpr: Expr<ArrayOptionalContext, number | boolean> = fakeExpr(
      ctx => ctx.a[0].b.c || true,
    );

    expect(typeof strictExpr).toBe('function');
  });

  it('falls back to a deeply-required array shape without the option', () => {
    const looseExpr: LooseExpr<ArrayOptionalContext, number | boolean> =
      fakeExpr(ctx => ctx.a[0].b.c || true);

    expect(() => {
      const viaOption = expression(looseExpr, { optionalMemberAccess: true });
      viaOption({}); // 'a' is optional in the original (unloosened) context
      viaOption({ a: [{}] }); // nested 'b'/'c' are optional in the original context

      const compiledStrict = expression(looseExpr);
      // @ts-expect-error without the option, 'a' must be present
      compiledStrict({});
      // @ts-expect-error without the option, the array element's 'b'/'c' must be present
      compiledStrict({ a: [{}] });
      compiledStrict({ a: [{ b: { c: 1 } }] });
    }).toThrow(); // fakeExpr returns the raw callback, not a compiled string
  });
});

describe('public API', () => {
  it('only exposes the evaluation entrypoint at runtime', () => {
    expect(Object.keys(expressionModule).sort()).toEqual(['default']);
    expect(expressionModule).not.toHaveProperty('parse');
    expect(expressionModule).not.toHaveProperty('tokenize');
    expect(expressionModule).not.toHaveProperty('encodeStringLiteral');
    expect(expressionModule).not.toHaveProperty('rewriteContextExpression');
    expect(expressionModule).not.toHaveProperty('validateContextExpression');
  });
});
