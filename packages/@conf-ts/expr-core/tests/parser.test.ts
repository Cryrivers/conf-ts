import { describe, expect, it } from 'vitest';

import { ExprSyntaxError, parse, tokenize, tryParse } from '../src';
import { parseSource, strip } from './helpers';

// Every object in the tree that has a source range, as `label text`, in
// depth-first order: nodes by `type`, parameters by `kind`, and object
// properties as `property`.
const spans = (source: string): string[] => {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.start === 'number' && typeof node.end === 'number') {
      const label = node.type ?? node.kind ?? 'property';
      out.push(`${label} ${source.slice(node.start, node.end)}`);
    }
    Object.values(node).forEach(visit);
  };
  visit(parseSource(source));
  return out;
};

describe('source ranges', () => {
  it('cover member chains, calls, and unary operators', () => {
    expect(spans('!a.b?.[c](1)')).toEqual([
      'UnaryExpression !a.b?.[c](1)',
      'ChainExpression a.b?.[c](1)',
      'CallExpression a.b?.[c](1)',
      'MemberExpression a.b?.[c]',
      'MemberExpression a.b',
      'Identifier a',
      'Literal b',
      'Identifier c',
      'Literal 1',
    ]);
  });

  it('cover binary, logical, conditional, and parenthesized expressions', () => {
    expect(spans('(a ?? b) ? c : d || e * 2')).toEqual([
      'ConditionalExpression (a ?? b) ? c : d || e * 2',
      'ParenthesizedExpression (a ?? b)',
      'LogicalExpression a ?? b',
      'Identifier a',
      'Identifier b',
      'Identifier c',
      'LogicalExpression d || e * 2',
      'Identifier d',
      'BinaryExpression e * 2',
      'Identifier e',
      'Literal 2',
    ]);
  });

  it('cover object properties, spreads, and array holes', () => {
    expect(spans('{a, "b": 1, [k]: v, ...s}')).toEqual([
      'ObjectExpression {a, "b": 1, [k]: v, ...s}',
      'property a',
      'Identifier a',
      'property "b": 1',
      'Literal 1',
      'property [k]: v',
      'Identifier k',
      'Identifier v',
      'SpreadElement ...s',
      'Identifier s',
    ]);
    expect(spans('[1, , ...xs]')).toEqual([
      'ArrayExpression [1, , ...xs]',
      'Literal 1',
      'Elision ,',
      'SpreadElement ...xs',
      'Identifier xs',
    ]);
  });

  it('cover arrow functions and each kind of parameter', () => {
    expect(spans('({a: b = 1, c}, [d, , e = 2] = [], ...f) => b')).toEqual([
      'ArrowFunctionExpression ({a: b = 1, c}, [d, , e = 2] = [], ...f) => b',
      'object {a: b = 1, c}',
      'property a: b = 1',
      'identifier b = 1',
      'Literal 1',
      'property c',
      'identifier c',
      'array [d, , e = 2] = []',
      'identifier d',
      'identifier e = 2',
      'Literal 2',
      'ArrayExpression []',
      'rest ...f',
      'Identifier b',
    ]);
    expect(spans('x => x')).toEqual([
      'ArrowFunctionExpression x => x',
      'identifier x',
      'Identifier x',
    ]);
  });

  it('measure template literal interpolations in the whole source', () => {
    expect(spans('tag`a${x + 1}b${`n${y}`}`')).toEqual([
      'TaggedTemplateExpression tag`a${x + 1}b${`n${y}`}`',
      'Identifier tag',
      'TemplateLiteral `a${x + 1}b${`n${y}`}`',
      'BinaryExpression x + 1',
      'Identifier x',
      'Literal 1',
      'TemplateLiteral `n${y}`',
      'Identifier y',
    ]);
  });

  it('exclude surrounding whitespace', () => {
    expect(parseSource('  a  +  b  ')).toMatchObject({ start: 2, end: 9 });
  });

  it('give the legacy `()` an empty literal at its closing parenthesis', () => {
    expect(parseSource('()')).toEqual({
      type: 'ParenthesizedExpression',
      expression: { type: 'Literal', value: undefined, start: 1, end: 1 },
      start: 0,
      end: 2,
    });
  });
});

describe('Literal.raw', () => {
  it('keeps the source text of each literal', () => {
    const ast = parseSource(`[1e3, 0.50, 'q', "w\\n", true, null, undefined]`);
    expect(
      (ast as { elements: Array<{ raw?: string; value: unknown }> }).elements,
    ).toMatchObject([
      { value: 1000, raw: '1e3' },
      { value: 0.5, raw: '0.50' },
      { value: 'q', raw: "'q'" },
      { value: 'w\n', raw: '"w\\n"' },
      { value: true, raw: 'true' },
      { value: null, raw: 'null' },
      { value: undefined, raw: 'undefined' },
    ]);
  });

  it('is the property name of a non-computed member access', () => {
    expect(parseSource('a.in')).toMatchObject({
      property: { type: 'Literal', value: 'in', raw: 'in', start: 2, end: 4 },
    });
  });
});

describe('optional chaining and conditionals', () => {
  it('parses `?` before `(` or `[` as a conditional, as JavaScript does', () => {
    expect(strip(parseSource('a ? [1] : [2]'))).toMatchObject({
      type: 'ConditionalExpression',
      consequent: { type: 'ArrayExpression' },
      alternate: { type: 'ArrayExpression' },
    });
    expect(strip(parseSource('a ? (b + 1) * 2 : c'))).toMatchObject({
      type: 'ConditionalExpression',
      consequent: { type: 'BinaryExpression', operator: '*' },
    });
    expect(strip(parseSource('a?[0]:1'))).toMatchObject({
      type: 'ConditionalExpression',
    });
  });

  it('parses `?.(` and `?.[` as optional links', () => {
    expect(strip(parseSource('f?.(1)'))).toEqual({
      type: 'ChainExpression',
      expression: {
        type: 'CallExpression',
        callee: { type: 'Identifier', name: 'f' },
        args: [{ type: 'Literal', value: 1 }],
        optional: true,
      },
    });
    expect(strip(parseSource('a?.[0].b ? c : d'))).toMatchObject({
      type: 'ConditionalExpression',
      test: {
        type: 'ChainExpression',
        expression: {
          type: 'MemberExpression',
          object: { type: 'MemberExpression', computed: true, optional: true },
          computed: false,
        },
      },
    });
  });

  it('reads mixed-case keywords as identifiers', () => {
    expect(strip(parseSource('TRUE && Null.Undefined'))).toEqual({
      type: 'LogicalExpression',
      operator: '&&',
      left: { type: 'Identifier', name: 'TRUE' },
      right: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'Null' },
        property: { type: 'Literal', value: 'Undefined' },
        computed: false,
      },
    });
  });
});

describe('syntax errors', () => {
  const cases: Array<[string, string, number, number]> = [
    ['', 'unexpected end of expression', 0, 0],
    [';', 'unexpected token ";", expected an expression', 0, 1],
    ['a +', 'unexpected end of expression', 3, 3],
    ['a + )', 'unexpected token ")", expected an expression', 4, 5],
    ['(a', 'unexpected end of expression, expected ")"', 2, 2],
    ['a b', 'unexpected identifier "b"', 2, 3],
    ['"x" "y"', 'unexpected string "y"', 4, 7],
    ['a = 1', 'unexpected token "="', 2, 3],
    ['a.1', 'unexpected number 1, expected a property name', 2, 3],
    ['a.[0]', 'unexpected token "[", expected a property name', 2, 3],
    ['a.(0)', 'unexpected token "(", expected a property name', 2, 3],
    ['a[1', 'unexpected end of expression, expected "]"', 3, 3],
    ['f(1', 'unexpected end of expression, expected ")"', 3, 3],
    ['{ ;a: 1 }', 'unexpected token ";", expected a property name', 2, 3],
    ['{ "a" }', 'unexpected token "}", expected ":"', 6, 7],
    ['1 === 1 ? true', 'unexpected end of expression, expected ":"', 14, 14],
    ['(1) => 1', 'unexpected number 1, expected an identifier', 1, 2],
    ['x =>', 'unexpected end of expression', 4, 4],
    ['a ? b : c : d', 'unexpected token ":"', 10, 11],
  ];

  it.each(cases)('%j: %s', (source, detail, start, end) => {
    const result = tryParse(source);
    expect(result.ok).toBe(false);
    const { error } = result as { error: ExprSyntaxError };
    expect(error).toBeInstanceOf(ExprSyntaxError);
    expect(error).toBeInstanceOf(Error);
    // The message keeps its historical form; `detail` says what's wrong.
    expect(error.message).toBe(`parse expression error: ${source}`);
    expect(error).toMatchObject({
      name: 'ExprSyntaxError',
      detail,
      start,
      end,
    });
    expect(error.token).toMatchObject({ start, end });
    expect(() => parse(tokenize(source), source)).toThrow(error.message);
  });

  it('locates errors inside template literal interpolations', () => {
    const result = tryParse('x + `${a +}`');
    expect(result).toMatchObject({
      ok: false,
      error: {
        // the message quotes the interpolation, the range is in the source
        message: 'parse expression error: a +',
        detail: 'unexpected end of expression',
        start: 10,
        end: 10,
      },
    });
  });
});

describe('tryParse()', () => {
  it('returns the AST of a valid expression', () => {
    const source = 'a.b + `${c}`';
    expect(tryParse(source)).toEqual({ ok: true, ast: parseSource(source) });
  });

  it('reports lexer errors too', () => {
    expect(tryParse('"abc')).toMatchObject({
      ok: false,
      error: { detail: 'unterminated string literal', start: 0, end: 4 },
    });
  });

  it('still throws for input that is not a string', () => {
    expect(() => tryParse(undefined as never)).toThrow('invalid expression');
  });
});
