import { describe, expect, it } from 'vitest';

import { ExprSyntaxError, tokenize } from '../src';

const kinds = (source: string) =>
  tokenize(source).map(({ kind, value }) => [kind, value]);

describe('tokenize()', () => {
  it('matches keywords case-sensitively', () => {
    expect(kinds('true false null undefined')).toEqual([
      ['boolean', 'true'],
      ['boolean', 'false'],
      ['null', 'null'],
      ['undefined', 'undefined'],
      ['eof', ''],
    ]);
    for (const name of ['TRUE', 'True', 'FALSE', 'Null', 'NULL', 'Undefined']) {
      expect(kinds(name)).toEqual([
        ['identifier', name],
        ['eof', ''],
      ]);
    }
    expect(kinds('In TYPEOF Void')).toEqual([
      ['identifier', 'In'],
      ['identifier', 'TYPEOF'],
      ['identifier', 'Void'],
      ['eof', ''],
    ]);
  });

  it('gives every token its source range', () => {
    const source = ' a.b >= "x\\ty" ?? 1e3 ';
    const tokens = tokenize(source);
    expect(
      tokens.map(token => [token.kind, source.slice(token.start, token.end)]),
    ).toEqual([
      ['identifier', 'a'],
      ['punct', '.'],
      ['identifier', 'b'],
      ['operator', '>='],
      ['string', '"x\\ty"'],
      ['operator', '??'],
      ['number', '1e3'],
      ['eof', ''],
    ]);
    expect(tokens.at(-1)).toMatchObject({ start: 22, end: 22 });
  });

  it('keeps the full source text of template escapes in rawQuasis', () => {
    const [token] = tokenize('`\\u0041\\n${a}\\`\\${b}`');
    expect(token.template).toEqual({
      quasis: ['A\n', '`${b}'],
      rawQuasis: ['\\u0041\\n', '\\`\\${b}'],
      expressionsSrc: ['a'],
      expressionsStart: [11],
    });
  });

  it('finds the end of interpolations around nested strings and templates', () => {
    const source = '`${ {a: "}"}["a"] + `${`}`}\\u0041` + \'`\' }!`';
    const [token] = tokenize(source);
    const [expression] = token.template!.expressionsSrc;
    expect(expression).toBe(' {a: "}"}["a"] + `${`}`}\\u0041` + \'`\' ');
    expect(token.template!.rawQuasis).toEqual(['', '!']);
    expect(
      source.slice(token.template!.expressionsStart[0]).startsWith(expression),
    ).toBe(true);
    expect(token).toMatchObject({ start: 0, end: source.length });
  });

  it('throws ExprSyntaxError with the historical messages', () => {
    const cases: Array<[string, string, string, number, number]> = [
      ['"abc', 'invalid expression: "abc', 'unterminated string literal', 0, 4],
      [
        '"abc\\',
        'invalid expression: "abc\\',
        'unterminated string literal',
        0,
        5,
      ],
      ['2e-a', 'invalid expression: 2e-a', 'missing exponent digits', 0, 3],
      [
        'a \\ b',
        'invalid expression: a \\ b',
        'unexpected character "\\"',
        2,
        3,
      ],
      [
        '"\\uzzzz"',
        'invalid expression: "\\uzzzz", invalid unicode escape [\\uzzzz]',
        'invalid unicode escape [\\uzzzz]',
        1,
        7,
      ],
      [
        '`abc',
        'invalid expression: `abc, unterminated template literal',
        'unterminated template literal',
        0,
        4,
      ],
      [
        '`abc\\',
        'invalid expression: `abc\\',
        'unterminated template literal',
        0,
        5,
      ],
      [
        'x + `${a + 1`',
        'invalid expression: x + `${a + 1`, unterminated template expression',
        'unterminated template expression',
        5,
        13,
      ],
    ];
    for (const [source, message, detail, start, end] of cases) {
      let error: unknown;
      try {
        tokenize(source);
      } catch (caught) {
        error = caught;
      }
      expect(error, source).toBeInstanceOf(ExprSyntaxError);
      expect(error, source).toMatchObject({
        name: 'ExprSyntaxError',
        message,
        detail,
        start,
        end,
        token: undefined,
      });
    }
  });

  it('rejects input that is not a string', () => {
    expect(() => tokenize(undefined)).toThrow('invalid expression');
    expect(() => tokenize(1 as never)).toThrow('invalid expression');
    expect(tokenize('')).toEqual([
      { kind: 'eof', value: '', start: 0, end: 0 },
    ]);
  });
});
