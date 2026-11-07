import { describe, expect, it } from 'vitest';

import {
  print,
  type ArrowParam,
  type ASTNode,
  type BinaryNode,
  type IdentifierParam,
  type LogicalNode,
  type ObjectNode,
  type TemplateLiteralNode,
  type UnaryNode,
} from '../src';
import { parseSource, strip } from './helpers';

// --- AST builders -------------------------------------------------------

type Operator = BinaryNode['operator'] | LogicalNode['operator'];

const LOGICAL = new Set<Operator>(['&&', '||', '??']);
const BINARY_OPERATORS: Operator[] = [
  '**',
  '*',
  '/',
  '%',
  '+',
  '-',
  '<<',
  '>>',
  '>>>',
  '>',
  '<',
  '>=',
  '<=',
  'instanceof',
  'in',
  '==',
  '!=',
  '===',
  '!==',
  '&',
  '^',
  '|',
  '&&',
  '||',
  '??',
];
const UNARY_OPERATORS: UnaryNode['operator'][] = [
  '+',
  '-',
  '!',
  '~',
  'void',
  'delete',
  'typeof',
];

const id = (name: string): ASTNode => ({ type: 'Identifier', name });
const lit = (value: unknown): ASTNode => ({ type: 'Literal', value });
const bin = (operator: Operator, left: ASTNode, right: ASTNode): ASTNode =>
  LOGICAL.has(operator)
    ? {
        type: 'LogicalExpression',
        operator: operator as LogicalNode['operator'],
        left,
        right,
      }
    : {
        type: 'BinaryExpression',
        operator: operator as BinaryNode['operator'],
        left,
        right,
      };
const un = (operator: UnaryNode['operator'], argument: ASTNode): ASTNode => ({
  type: 'UnaryExpression',
  operator,
  argument,
});
const cond = (
  test: ASTNode,
  consequent: ASTNode,
  alternate: ASTNode,
): ASTNode => ({
  type: 'ConditionalExpression',
  test,
  consequent,
  alternate,
});
const paren = (expression: ASTNode): ASTNode => ({
  type: 'ParenthesizedExpression',
  expression,
});
const chain = (expression: ASTNode): ASTNode => ({
  type: 'ChainExpression',
  expression,
});
const member = (object: ASTNode, name: string, optional = false): ASTNode => ({
  type: 'MemberExpression',
  object,
  property: lit(name),
  computed: false,
  ...(optional ? { optional } : {}),
});
const index = (
  object: ASTNode,
  property: ASTNode,
  optional = false,
): ASTNode => ({
  type: 'MemberExpression',
  object,
  property,
  computed: true,
  ...(optional ? { optional } : {}),
});
const call = (callee: ASTNode, args: ASTNode[], optional = false): ASTNode => ({
  type: 'CallExpression',
  callee,
  args,
  ...(optional ? { optional } : {}),
});
const template = (
  raws: string[],
  expressions: ASTNode[] = [],
): TemplateLiteralNode => ({
  type: 'TemplateLiteral',
  quasis: raws,
  rawQuasis: raws,
  expressions,
});
const tagged = (tag: ASTNode, quasi: TemplateLiteralNode): ASTNode => ({
  type: 'TaggedTemplateExpression',
  tag,
  quasi,
});
const ident = (name: string, value?: ASTNode): IdentifierParam => ({
  kind: 'identifier',
  name,
  ...(value ? { default: value } : {}),
});
const arrow = (params: Array<ArrowParam | string>, body: ASTNode): ASTNode => ({
  type: 'ArrowFunctionExpression',
  params: params.map(param =>
    typeof param === 'string' ? ident(param) : param,
  ),
  body,
});
const object = (properties: ObjectNode['properties']): ASTNode => ({
  type: 'ObjectExpression',
  properties,
});

const [a, b, c, d, e, f, g, x, y] = 'abcdefgxy'.split('').map(id);

// --- Hand-written expectations ------------------------------------------

describe('print()', () => {
  it('normalizes spacing and keeps source parentheses', () => {
    const cases: Array<[string, string]> = [
      ['a+b*c', 'a + b * c'],
      ['((a))', '((a))'],
      ['!(a)', '!(a)'],
      ['typeof(a)', 'typeof (a)'],
      ['a+-b', 'a + -b'],
      ['a- -b', 'a - -b'],
      [
        '{ a : 1 , b , "c-d" : 2, [k] : v, ...s }',
        '{a: 1, b, "c-d": 2, [k]: v, ...s}',
      ],
      ['[ 1 ,2 , ]', '[1, 2]'],
      ['[1,,2,,]', '[1, , 2, ,]'],
      ['f( a,b )?.(c)', 'f(a, b)?.(c)'],
      ['a?.b?.[c].d', 'a?.b?.[c].d'],
      ['(x)=>x', 'x => x'],
      [
        '(a,b=1,{c,d:e=2}={},[f,,g]=[],...h)=>a',
        '(a, b = 1, {c, d: e = 2} = {}, [f, , g] = [], ...h) => a',
      ],
      ['\'s\' + "t"', '"s" + "t"'],
      ['1e3 + 0.50', '1000 + 0.5'],
      ['`a${ b }c\\n`', '`a${b}c\\n`'],
      ['x => ({a: 1})', 'x => ({a: 1})'],
      ['x => {a: 1}', 'x => ({a: 1})'],
      ['a ?? b', 'a ?? b'],
      ['-1', '-1'],
      ['TRUE || Null', 'TRUE || Null'],
    ];
    for (const [source, expected] of cases) {
      expect(print(parseSource(source)), source).toBe(expected);
    }
  });

  it('adds parentheses only where precedence and associativity need them', () => {
    expect(print(bin('*', bin('+', a, b), c))).toBe('(a + b) * c');
    expect(print(bin('+', a, bin('*', b, c)))).toBe('a + b * c');
    expect(print(bin('-', bin('-', a, b), c))).toBe('a - b - c');
    expect(print(bin('-', a, bin('-', b, c)))).toBe('a - (b - c)');
    expect(print(bin('+', a, bin('+', b, c)))).toBe('a + (b + c)');
    expect(print(bin('**', a, bin('**', b, c)))).toBe('a ** b ** c');
    expect(print(bin('**', bin('**', a, b), c))).toBe('(a ** b) ** c');
    expect(print(bin('||', a, bin('&&', b, c)))).toBe('a || b && c');
    expect(print(bin('&&', bin('||', a, b), c))).toBe('(a || b) && c');
    expect(print(bin('<', bin('in', a, b), c))).toBe('a in b < c');
    expect(print(bin('===', a, bin('<', b, c)))).toBe('a === b < c');
    expect(print(bin('&', bin('|', a, b), c))).toBe('(a | b) & c');
  });

  it('prints negated and joined conditions', () => {
    // De Morgan: !(a && b) <=> !a || !b
    expect(print(un('!', bin('&&', a, b)))).toBe('!(a && b)');
    expect(print(bin('||', un('!', a), un('!', b)))).toBe('!a || !b');
    expect(print(un('!', bin('===', member(a, 'b'), lit(1))))).toBe(
      '!(a.b === 1)',
    );
    expect(print(bin('&&', bin('||', a, b), bin('||', c, d)))).toBe(
      '(a || b) && (c || d)',
    );
  });

  it('parenthesizes forms JavaScript would reject or misread', () => {
    // `??` can't be mixed with unparenthesized `&&` or `||`
    expect(print(bin('??', bin('||', a, b), c))).toBe('(a || b) ?? c');
    expect(print(bin('||', bin('??', a, b), c))).toBe('(a ?? b) || c');
    expect(print(bin('??', a, bin('&&', b, c)))).toBe('a ?? (b && c)');
    expect(print(bin('&&', bin('??', a, b), c))).toBe('(a ?? b) && c');
    expect(print(bin('??', bin('??', a, b), c))).toBe('a ?? b ?? c');
    // the base of `**` can't be a unary expression
    expect(print(bin('**', un('-', a), b))).toBe('(-a) ** b');
    expect(print(bin('**', lit(-2), lit(2)))).toBe('(-2) ** 2');
    expect(print(bin('**', a, un('-', b)))).toBe('a ** -b');
    // `--`/`++` would be other operators
    expect(print(un('-', un('-', a)))).toBe('- -a');
    expect(print(un('+', un('+', a)))).toBe('+ +a');
    expect(print(un('-', lit(-1)))).toBe('- -1');
    expect(print(un('-', un('+', a)))).toBe('-+a');
    expect(print(un('!', un('!', a)))).toBe('!!a');
    // an arrow function body starting with `{` would be a block
    expect(print(arrow(['x'], object([{ key: 'a', value: lit(1) }])))).toBe(
      'x => ({a: 1})',
    );
    expect(print(arrow(['x'], member(object([]), 'a')))).toBe('x => ({}.a)');
    // an integer followed by `.` would read as a decimal point
    expect(print(member(lit(1), 'toFixed'))).toBe('(1).toFixed');
    expect(print(member(lit(1.5), 'toFixed'))).toBe('1.5.toFixed');
    expect(print(member(lit(1e21), 'toFixed'))).toBe('1e+21.toFixed');
    expect(print(index(lit(1), lit(0)))).toBe('1[0]');
  });

  it('prints unary operators', () => {
    for (const operator of UNARY_OPERATORS) {
      const spaced = /^[a-z]/.test(operator) ? ' ' : '';
      expect(print(un(operator, a))).toBe(`${operator}${spaced}a`);
    }
    expect(print(un('typeof', bin('+', a, b)))).toBe('typeof (a + b)');
    expect(print(un('void', lit(0)))).toBe('void 0');
    expect(print(un('delete', member(a, 'b')))).toBe('delete a.b');
    expect(print(un('!', arrow(['x'], x)))).toBe('!(x => x)');
  });

  it('prints conditionals and arrow functions at the lowest precedence', () => {
    expect(print(cond(cond(a, b, c), d, e))).toBe('(a ? b : c) ? d : e');
    expect(print(cond(a, cond(b, c, d), cond(e, f, g)))).toBe(
      'a ? b ? c : d : e ? f : g',
    );
    expect(print(cond(bin('||', a, b), c, d))).toBe('a || b ? c : d');
    expect(print(cond(bin('??', a, b), c, d))).toBe('a ?? b ? c : d');
    expect(print(cond(arrow(['x'], x), a, b))).toBe('(x => x) ? a : b');
    expect(print(cond(a, arrow(['x'], x), arrow(['y'], y)))).toBe(
      'a ? x => x : y => y',
    );
    expect(print(bin('+', cond(a, b, c), d))).toBe('(a ? b : c) + d');
    expect(print(bin('+', arrow(['x'], x), a))).toBe('(x => x) + a');
    expect(print(call(arrow(['x'], x), [lit(1)]))).toBe('(x => x)(1)');
    expect(print(call(f, [arrow(['x'], x), cond(a, b, c)]))).toBe(
      'f(x => x, a ? b : c)',
    );
    expect(print(arrow([], arrow(['y'], y)))).toBe('() => y => y');
    expect(print(arrow(['x'], cond(x, a, b)))).toBe('x => x ? a : b');
  });

  it('keeps the extent of optional chains', () => {
    expect(print(chain(member(member(a, 'b', true), 'c')))).toBe('a?.b.c');
    expect(print(member(chain(member(a, 'b', true)), 'c'))).toBe('(a?.b).c');
    expect(print(call(chain(member(a, 'b', true)), []))).toBe('(a?.b)()');
    expect(print(tagged(chain(member(a, 'b', true)), template(['x'])))).toBe(
      '(a?.b)`x`',
    );
    expect(print(chain(call(member(a, 'b'), [], true)))).toBe('a.b?.()');
    expect(print(chain(index(a, lit(0), true)))).toBe('a?.[0]');
    expect(print(un('!', chain(member(a, 'b', true))))).toBe('!a?.b');
  });

  it('prints property names that cannot follow a dot as computed keys', () => {
    expect(print(member(a, 'in'))).toBe('a.in');
    expect(print(member(a, 'x-y'))).toBe('a["x-y"]');
    expect(print(member(a, 'true'))).toBe('a["true"]');
    expect(print(member(a, ''))).toBe('a[""]');
    expect(print(chain(member(a, 'x-y', true)))).toBe('a?.["x-y"]');
    expect(print(member(lit(1), 'x-y'))).toBe('1["x-y"]');
  });

  it('prints object literals', () => {
    expect(print(object([]))).toBe('{}');
    expect(
      print(
        object([
          { key: 'a', value: id('a') },
          { key: 'b', value: id('c') },
          { key: 'in', value: lit(1) },
          { key: 'true', value: lit(2) },
          { key: '1', value: lit(3) },
          { key: 'x-y', value: lit(4) },
          { key: b, computed: true, value: arrow(['x'], x) },
          { type: 'SpreadElement', argument: cond(a, b, c) },
        ]),
      ),
    ).toBe(
      '{a, b: c, in: 1, "true": 2, "1": 3, "x-y": 4, [b]: x => x, ...a ? b : c}',
    );
  });

  it('prints array literals with holes and spreads', () => {
    const hole: ASTNode = { type: 'Elision' };
    const arr = (...elements: ASTNode[]): ASTNode => ({
      type: 'ArrayExpression',
      elements,
    });
    expect(print(arr())).toBe('[]');
    expect(print(arr(hole))).toBe('[,]');
    expect(print(arr(a, hole))).toBe('[a, ,]');
    expect(print(arr(hole, a))).toBe('[, a]');
    expect(print(arr(a, hole, b))).toBe('[a, , b]');
    expect(
      print({
        type: 'ArrayExpression',
        elements: [{ type: 'SpreadElement', argument: a }, b],
      }),
    ).toBe('[...a, b]');
  });

  it('prints arrow function parameters', () => {
    const pattern: ArrowParam = {
      kind: 'object',
      properties: [
        { key: 'a', value: ident('a') },
        { key: 'b', value: ident('c', lit(2)) },
        { key: 'in', value: ident('d') },
      ],
      default: object([]),
    };
    const elements: ArrowParam = {
      kind: 'array',
      elements: [ident('e'), null, ident('f', a), null],
    };
    expect(
      print(
        arrow(
          [ident('x', lit(1)), pattern, elements, { kind: 'rest', name: 'r' }],
          x,
        ),
      ),
    ).toBe('(x = 1, {a, b: c = 2, in: d} = {}, [e, , f = a, ,], ...r) => x');
    expect(print(arrow([ident('x', arrow(['y'], y))], x))).toBe(
      '(x = y => y) => x',
    );
  });

  it('prints literal values the grammar has no literal for as expressions', () => {
    expect(print(lit(-5))).toBe('-5');
    expect(print(lit(-0))).toBe('-0');
    expect(print(lit(NaN))).toBe('0 / 0');
    expect(print(lit(Infinity))).toBe('1 / 0');
    expect(print(lit(-Infinity))).toBe('-1 / 0');
    expect(print(bin('*', a, lit(Infinity)))).toBe('a * (1 / 0)');
    expect(print(un('-', lit(NaN)))).toBe('-(0 / 0)');
    expect(print(member(lit(-1), 'x'))).toBe('(-1).x');
    expect(print(lit(1e21))).toBe('1e+21');
    expect(print(lit(5e-324))).toBe('5e-324');
    expect(print(lit(undefined))).toBe('undefined');
    expect(print(lit(null))).toBe('null');
    expect(print(lit(false))).toBe('false');
  });

  it('escapes strings so they read back as the same value', () => {
    const value = 'a"b\'c\\d\n\r\t\v\f\b\0\u001f\u007f  `${x}é😀\ud800x\udc00';
    const printed = print(lit(value));
    expect(printed).toBe(
      '"a\\"b\'c\\\\d\\n\\r\\t\\v\\f\\u0008\\u0000\\u001f\\u007f\\u2028\\u2029`${x}é😀\\ud800x\\udc00"',
    );
    expect(strip(parseSource(printed))).toEqual(lit(value));
    const single = print(lit(value), { quote: 'single' });
    expect(single.startsWith("'a\"b\\'c")).toBe(true);
    expect(strip(parseSource(single))).toEqual(lit(value));
  });

  it('prints template literals from their raw text', () => {
    const source = 'tag`a\\u0041${b}\\`\\${c}${`n${d}`}`';
    expect(print(parseSource(source))).toBe(source);
    expect(
      print(
        template(['x', '-', 'y'], [object([{ key: 'a', value: lit(1) }]), a]),
      ),
    ).toBe('`x${{a: 1}}-${a}y`');
    expect(print(tagged(bin('+', a, b), template([''])))).toBe('(a + b)``');
  });

  it('ignores source positions and raw texts', () => {
    const ast = parseSource('1e3');
    expect(print({ ...ast, value: 5 } as ASTNode)).toBe('5');
  });

  it('throws a TypeError for trees that have no source form', () => {
    const invalid: unknown[] = [
      null,
      { type: 'Unknown' },
      { type: 'Elision' },
      id('a-b'),
      id('true'),
      id('in'),
      id('1a'),
      id(''),
      lit({}),
      lit(1n),
      lit(Symbol('s')),
      un('++' as never, a),
      bin('=' as never, a, b),
      { type: 'BinaryExpression', operator: '&&', left: a, right: b },
      { type: 'LogicalExpression', operator: '+', left: a, right: b },
      {
        type: 'MemberExpression',
        object: a,
        property: id('b'),
        computed: false,
      },
      arrow([{ kind: 'rest', name: 'r' }, 'x'], x),
      arrow(['a-b'], x),
      arrow(
        [{ kind: 'object', properties: [{ key: 'a-b', value: ident('x') }] }],
        x,
      ),
      template(['a', 'b']),
      template(['`']),
      template(['${']),
      template(['\\']),
      template(['\\u12']),
      { type: 'TaggedTemplateExpression', tag: a, quasi: a },
    ];
    for (const node of invalid) {
      expect(
        () => print(node as ASTNode),
        String(
          JSON.stringify(node, (_, v) =>
            typeof v === 'bigint' || typeof v === 'symbol' ? String(v) : v,
          ),
        ),
      ).toThrow(TypeError);
    }
  });
});

// --- Randomized round trips ---------------------------------------------

// A small deterministic PRNG (mulberry32), so failures are reproducible.
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const NAMES = ['a', 'b', 'TRUE', 'Null', '$x', '_y1', 'NaN', 'of', 'this'];
const PROPERTY_NAMES = ['b', 'in', 'typeof', 'TRUE', 'length'];
const OBJECT_KEYS = ['a', 'b', 'in', 'true', 'x-y', '', '1', '__proto__'];
const NUMBERS = [
  0,
  1,
  42,
  0.5,
  123.456,
  1e21,
  5e-7,
  2 ** 53,
  Number.MAX_VALUE,
  5e-324,
];
const STRING_PARTS = [
  'a',
  '"',
  "'",
  '\\',
  '\n',
  '\t',
  ' ',
  '`',
  '$',
  '{',
  '}',
  '\0',
  'é',
  '😀',
  '\ud800',
];
// [raw, cooked] template chunks; `$` is never followed by `{`.
const TEMPLATE_CHUNKS: Array<[string, string]> = [
  ['a', 'a'],
  [' ', ' '],
  ['$', '$'],
  ['{', '{'],
  ['}', '}'],
  ['\\n', '\n'],
  ['\\`', '`'],
  ['\\${', '${'],
  ['\\u0041', 'A'],
  ['\\\\', '\\'],
  ['"', '"'],
];

const generator = (seed: number) => {
  const next = random(seed);
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  const chance = (p: number) => next() < p;

  const string = () =>
    Array.from({ length: int(4) }, () => pick(STRING_PARTS)).join('');

  const literal = (): ASTNode => {
    switch (int(5)) {
      case 0:
        return lit(pick(NUMBERS));
      case 1:
        return lit(string());
      case 2:
        return lit(chance(0.5));
      case 3:
        return lit(null);
      default:
        return lit(undefined);
    }
  };

  const templateLiteral = (depth: number): TemplateLiteralNode => {
    const count = int(3);
    const raws: string[] = [];
    const cooked: string[] = [];
    for (let i = 0; i <= count; i++) {
      let raw = '';
      let value = '';
      let previous = '';
      for (let j = int(4); j > 0; j--) {
        const [chunkRaw, chunkCooked] = pick(TEMPLATE_CHUNKS);
        if (previous === '$' && chunkRaw.startsWith('{')) {
          continue;
        }
        raw += chunkRaw;
        value += chunkCooked;
        previous = chunkRaw;
      }
      // a trailing `$` would join the next interpolation's `${`
      raws.push(raw);
      cooked.push(value);
    }
    return {
      type: 'TemplateLiteral',
      quasis: cooked,
      rawQuasis: raws,
      expressions: Array.from({ length: count }, () => expression(depth - 1)),
    };
  };

  const param = (depth: number, last: boolean): ArrowParam => {
    const binding = (): IdentifierParam =>
      ident(pick(NAMES), chance(0.3) ? expression(depth - 1) : undefined);
    switch (int(last ? 4 : 3)) {
      case 0:
        return binding();
      case 1:
        return {
          kind: 'object',
          properties: Array.from({ length: int(3) }, () => {
            const value = binding();
            return {
              key: chance(0.5) ? value.name : pick(PROPERTY_NAMES),
              value,
            };
          }),
          default: chance(0.3) ? expression(depth - 1) : undefined,
        };
      case 2:
        return {
          kind: 'array',
          elements: Array.from({ length: int(4) }, () =>
            chance(0.3) ? null : binding(),
          ),
          default: chance(0.3) ? expression(depth - 1) : undefined,
        };
      default:
        return { kind: 'rest', name: pick(NAMES) };
    }
  };

  // Member/call/tag links on `base`; an optional link makes the whole
  // spine a ChainExpression, as the parser builds it.
  const postfix = (depth: number): ASTNode => {
    let node = expression(depth - 1);
    let optional = false;
    for (let links = 1 + int(3); links > 0; links--) {
      const kind = int(4);
      // a tagged template can't be an optional link
      const link = kind < 3 && chance(0.3);
      optional ||= link;
      switch (kind) {
        case 0:
          node = member(node, pick(PROPERTY_NAMES), link);
          break;
        case 1:
          node = index(node, expression(depth - 1), link);
          break;
        case 2:
          node = call(
            node,
            Array.from({ length: int(3) }, () => expression(depth - 1)),
            link,
          );
          break;
        default:
          node = tagged(node, templateLiteral(depth));
      }
    }
    return optional ? chain(node) : node;
  };

  const expression = (depth: number): ASTNode => {
    if (depth <= 0) {
      return chance(0.5) ? id(pick(NAMES)) : literal();
    }
    switch (int(12)) {
      case 0:
        return id(pick(NAMES));
      case 1:
        return literal();
      case 2:
        return un(pick(UNARY_OPERATORS), expression(depth - 1));
      case 3:
      case 4:
        return bin(
          pick(BINARY_OPERATORS),
          expression(depth - 1),
          expression(depth - 1),
        );
      case 5:
        return cond(
          expression(depth - 1),
          expression(depth - 1),
          expression(depth - 1),
        );
      case 6:
        return postfix(depth);
      case 7:
        return {
          type: 'ArrayExpression',
          elements: Array.from({ length: int(4) }, () =>
            chance(0.2)
              ? { type: 'Elision' }
              : chance(0.2)
                ? { type: 'SpreadElement', argument: expression(depth - 1) }
                : expression(depth - 1),
          ),
        };
      case 8:
        return object(
          Array.from({ length: int(4) }, () => {
            if (chance(0.2)) {
              return { type: 'SpreadElement', argument: expression(depth - 1) };
            }
            if (chance(0.2)) {
              return {
                key: expression(depth - 1),
                computed: true,
                value: expression(depth - 1),
              };
            }
            const key = pick(OBJECT_KEYS);
            return {
              key,
              value: chance(0.3)
                ? id(
                    key === 'true' || key === 'in'
                      ? 'a'
                      : key.replace(/^(?:x-y||1)$/, 'b'),
                  )
                : expression(depth - 1),
            };
          }),
        );
      case 9: {
        const count = int(4);
        return arrow(
          Array.from({ length: count }, (_, i) =>
            param(depth, i === count - 1),
          ),
          expression(depth - 1),
        );
      }
      case 10:
        return templateLiteral(depth);
      default:
        return paren(expression(depth - 1));
    }
  };

  return expression;
};

describe('print() round trips', () => {
  it('parses what it prints back into the same tree', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const ast = generator(seed)(4);
      const printed = print(ast);
      let reparsed: ASTNode;
      try {
        reparsed = parseSource(printed);
      } catch (error) {
        throw new Error(`seed ${seed}: ${printed}\n${String(error)}`);
      }
      expect(strip(reparsed), `seed ${seed}: ${printed}`).toEqual(strip(ast));
      // printing the reparsed tree, with its added parentheses, is stable
      expect(print(reparsed), `seed ${seed}`).toBe(printed);
    }
  });
});
