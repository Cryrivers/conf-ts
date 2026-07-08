import { describe, expect, it } from 'vitest';

import expression from '../src';
import * as expressionModule from '../src';

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
