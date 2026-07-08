import { describe, expect, it } from 'vitest';

import expression, {
  encodeStringLiteral,
  rewriteContextExpression,
} from '../src';

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

describe('quote style', () => {
  it('keeps double quotes as the default rewrite output', () => {
    expect(rewriteContextExpression('ctx.label === "x"', 'ctx')).toBe(
      'label === "x"',
    );
  });

  it('rewrites string tokens with single quotes when requested', () => {
    expect(
      rewriteContextExpression('ctx.label === "it\'s"', 'ctx', {
        quote: 'single',
      }),
    ).toBe("label === 'it\\'s'");
  });

  it('encodes string literal escapes consistently', () => {
    const cases: Array<[string, string]> = [
      ["it's", "'it\\'s'"],
      ['"', `'"'`],
      ['\\', "'\\\\'"],
      ['\n', "'\\n'"],
      ['\u0001', "'\\u0001'"],
      ['星', "'星'"],
      ['line\n"quoted"\\path', `'line\\n"quoted"\\\\path'`],
    ];

    for (const [value, single] of cases) {
      expect(encodeStringLiteral(value)).toBe(JSON.stringify(value));
      expect(encodeStringLiteral(value, 'double')).toBe(JSON.stringify(value));
      expect(encodeStringLiteral(value, 'single')).toBe(single);
    }
  });

  it('applies quote style inside template literal expressions', () => {
    expect(
      rewriteContextExpression('`value=${ctx.label === "x"}`', 'ctx', {
        quote: 'single',
      }),
    ).toBe("`value=${label === 'x'}`");
  });

  it('round-trips single-quoted rewrite output through the parser and evaluator', () => {
    const source = rewriteContextExpression('ctx.label === "it\'s"', 'ctx', {
      quote: 'single',
    });

    expect(source).toBe("label === 'it\\'s'");
    expect(expression(source)({ label: "it's" })).toBe(true);
  });
});
