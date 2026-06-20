import { describe, expect, test } from 'vitest';

import expression from '../src';
import type { Expr } from '../src';

describe('boundary cases', () => {
  test('extreme numbers', () => {
    let expr = expression('1e308');
    expect(expr({})).toBe(1e308);

    expr = expression('2e-308');
    expect(expr({})).toBe(2e-308);
  });

  test('deep parentheses', () => {
    const expr = expression('((((a))))');
    expect(expr({ a: 42 })).toBe(42);
  });

  test('long whitespace', () => {
    const expr = expression('   \n\t  a   +   b   ');
    expect(expr({ a: 1, b: 2 })).toBe(3);
  });

  test('cache returns same compiled function', () => {
    const e1 = expression('a + b * 2');
    const e2 = expression('a + b * 2');
    expect(e1).toBe(e2);
    expect(e1({ a: 1, b: 3 })).toBe(7);
    expect(e2({ a: 1, b: 3 })).toBe(7);
  });

  test('callback expressions preserve identity and closures', () => {
    const offset = 3;
    const callback = ((ctx: { value: number }) => ctx.value + offset) as Expr<
      { value: number },
      number
    >;

    expect(expression(callback)).toBe(callback);
    expect(expression(callback)({ value: 4 })).toBe(7);
  });

  test('array elisions preserve length and holes', () => {
    const result = expression('[1, , 3]')({});
    expect(result).toEqual([1, , 3]);
    expect(1 in (result as unknown[])).toBe(false);
  });
});
