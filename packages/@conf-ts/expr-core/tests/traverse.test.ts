import { describe, expect, it } from 'vitest';

import {
  collectFreeIdentifiers,
  forEachChild,
  forEachParamBinding,
  getChildren,
  print,
  type ASTNode,
} from '../src';
import { parseSource } from './helpers';

const children = (source: string) =>
  getChildren(parseSource(source)).map(child =>
    child.type === 'Elision' ? '<hole>' : print(child),
  );

const free = (source: string) =>
  collectFreeIdentifiers(parseSource(source)).map(({ name }) => name);

describe('getChildren() / forEachChild()', () => {
  it('lists the child expressions of each node type in evaluation order', () => {
    expect(children('a')).toEqual([]);
    expect(children('1')).toEqual([]);
    expect(children('(a + b)')).toEqual(['a + b']);
    expect(children('a?.b')).toEqual(['a?.b']);
    expect(children('-a')).toEqual(['a']);
    expect(children('a * b')).toEqual(['a', 'b']);
    expect(children('a ?? b')).toEqual(['a', 'b']);
    expect(children('a ? b : c')).toEqual(['a', 'b', 'c']);
    expect(children('f(a, b)')).toEqual(['f', 'a', 'b']);
    expect(children('`x${a}y${b}`')).toEqual(['a', 'b']);
    expect(children('tag`x${a}`')).toEqual(['tag', 'a']);
  });

  it('skips non-computed property names but not computed keys', () => {
    expect(children('a.b')).toEqual(['a']);
    expect(children('a[b]')).toEqual(['a', 'b']);
    expect(children('a["b"]')).toEqual(['a', '"b"']);
  });

  it('looks through spreads and keeps array holes', () => {
    expect(children('[a, , ...b]')).toEqual(['a', '<hole>', 'b']);
    expect(children('{a, b: c, [d]: e, ...f}')).toEqual([
      'a',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it("visits an arrow function's parameter defaults, then its body", () => {
    expect(children('(a = 1, {b = 2} = c, [d = 3], ...e) => f')).toEqual([
      '1',
      'c',
      '2',
      '3',
      'f',
    ]);
  });

  it('calls the visitor with the child only', () => {
    const calls: unknown[][] = [];
    forEachChild(parseSource('f(a, b)'), (...args: unknown[]) => {
      calls.push(args);
    });
    expect(calls.map(args => args.length)).toEqual([1, 1, 1]);
  });

  it('ignores values that are not expression nodes', () => {
    const spread = { type: 'SpreadElement', argument: parseSource('a') };
    expect(getChildren(spread as unknown as ASTNode)).toEqual([]);
  });
});

describe('forEachParamBinding()', () => {
  it('walks defaults and bound names in evaluation order', () => {
    const ast = parseSource(
      '(a = 1, {b, c: d = 2} = e, [, f = 3], ...g) => 0',
    ) as Extract<ASTNode, { type: 'ArrowFunctionExpression' }>;
    const steps: string[] = [];
    forEachParamBinding(
      ast.params,
      value => steps.push(`default ${print(value)}`),
      name => steps.push(`bind ${name}`),
    );
    expect(steps).toEqual([
      'default 1',
      'bind a',
      'default e',
      'bind b',
      'default 2',
      'bind d',
      'default 3',
      'bind f',
      'bind g',
    ]);
  });
});

describe('collectFreeIdentifiers()', () => {
  it('lists every identifier read from the environment, in evaluation order', () => {
    expect(free('a + b.c * a(d[e], `${f}`, {g, h: i, [j]: k})')).toEqual([
      'a',
      'b',
      'a',
      'd',
      'e',
      'f',
      'g',
      'i',
      'j',
      'k',
    ]);
    expect(free('String(x) + undefined + TRUE')).toEqual([
      'String',
      'x',
      'TRUE',
    ]);
  });

  it('returns the identifier nodes themselves, with their ranges', () => {
    const source = 'user.age >= limit';
    expect(collectFreeIdentifiers(parseSource(source))).toEqual([
      { type: 'Identifier', name: 'user', start: 0, end: 4 },
      { type: 'Identifier', name: 'limit', start: 12, end: 17 },
    ]);
  });

  it("excludes names bound by an arrow function's parameters", () => {
    expect(free('items.map(item => item.price * rate)')).toEqual([
      'items',
      'rate',
    ]);
    expect(
      free('xs.map(({a, b: c}, [d, , e], ...f) => a + b + c + d + e + f + g)'),
    ).toEqual(['xs', 'b', 'g']);
    expect(free('x => y => x + y + z')).toEqual(['z']);
    // a parameter only shadows its own arrow function
    expect(free('[x => x, x]')).toEqual(['x']);
  });

  it('resolves a default value against the parameters before it', () => {
    expect(free('(a = b, b = a) => a + b')).toEqual(['b']);
    // a pattern's own default is evaluated before its elements' defaults
    expect(free('({a = b} = c, [d = a]) => d')).toEqual(['c', 'b']);
    expect(free('(a = () => b, b) => a()')).toEqual(['b']);
  });
});
