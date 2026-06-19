import { describe, expect, test } from 'vitest';

import expression from '../src';

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
});
