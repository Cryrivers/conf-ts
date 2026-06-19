import { beforeEach, describe, expect, test } from 'vitest';

import expression from '../src';

/**
 * Systematic organization and expansion: grouped by syntax category, clear comments,
 * edge cases, unsupported modern features validation, and explicit error assertions.
 */

describe('Basic Expressions and Literals', () => {
  let env: Record<string, unknown>;

  beforeEach(() => {
    env = {};
  });

  test('String escapes and Unicode', () => {
    // Verify string escape sequences and \uXXXX unicode parsing
    let expr = expression('"\\u2605haha"');
    expect(expr(env)).toBe('★haha');

    expr = expression('"\\n\\r\\f\\t\\v\\s"');
    expect(expr(env)).toBe('\n\r\f\t\v\s');
  });

  test('Numeric literals and exponents', () => {
    // Verify integers/decimals/exponential notation parsing and evaluation
    let expr = expression('2e3');
    expect(expr(env)).toBe(2000);

    expr = expression('2e-3');
    expect(expr(env)).toBe(0.002);

    expr = expression('123.456');
    expect(expr(env)).toBe(123.456);
  });

  test('Unary operators: + identity, - negate, ! not', () => {
    // Engine-specific: unary + acts as identity
    let expr = expression('+"123"');
    expect(expr(env)).toBe('123');

    expr = expression('-123');
    expect(expr(env)).toBe(-123);

    expr = expression('!a');
    expect(expr({ a: 1 })).toBe(false);
    expect(expr({ a: 0 })).toBe(true);
  });

  test('Boolean/Null/Undefined literal comparisons', () => {
    // Strict comparisons with true/false/null/undefined
    let expr = expression('a === null');
    expect(expr({ a: null })).toBe(true);
    expect(expr({ a: 1 })).toBe(false);

    expr = expression('a === undefined');
    expect(expr({ a: undefined })).toBe(true);
    expect(expr({ a: 1 })).toBe(false);

    expr = expression('a === true');
    expect(expr({ a: true })).toBe(true);
    expect(expr({ a: 1 })).toBe(false);

    expr = expression('a === false');
    expect(expr({ a: false })).toBe(true);
    expect(expr({ a: 1 })).toBe(false);
  });

  test('Parentheses and leading bracket compatibility', () => {
    // Nested parentheses and leading ']' special-case behavior
    let expr = expression('(a)');
    expect(expr({ a: 42 })).toBe(42);

    expr = expression(']123');
    expect(expr(env)).toBe(undefined);
  });
});

describe('Member Access and Collection Literals', () => {
  test('Dot/Index member access with null-safe behavior', () => {
    // Dot and bracket member access; null in chain yields null
    let expr = expression('a.b.c.d');
    expect(expr({ a: { b: null } })).toBe(null);

    expr = expression('a["b"].c + a.d["e"]');
    expect(expr({ a: { b: { c: 1 }, d: { e: 2 } } })).toBe(3);

    expr = expression('a.list[i + 1]');
    expect(expr({ a: { list: [0, 5, 10] }, i: 1 })).toBe(10);
    expect(expr({ a: { list: [0, 5, 10] }, i: 0 })).toBe(5);
  });

  test('Object and array literals (trailing commas)', () => {
    // Object/array literals with trailing comma compatibility
    let expr = expression('{ a: {}, b: [] }');
    expect(expr({})).toEqual({ a: {}, b: [] });

    expr = expression('{ a: { b: { "c": null }, d: { e: 2 }, } }');
    expect(expr({})).toEqual({ a: { b: { c: null }, d: { e: 2 } } });

    expr = expression('[1, 2, 3, ][2]');
    expect(expr({})).toBe(3);
  });
});

describe('Function Calls and this Binding', () => {
  test('Plain function calls', () => {
    // Verify function call and argument passing
    const expr = expression('a(1, 2)');
    expect(expr({ a: (num1: number, num2: number) => num1 + num2 })).toBe(3);
  });

  test('Method calls bind this', () => {
    // Member call binds this to the object
    const expr = expression('a.b()');
    expect(
      expr({
        a: {
          b: function (this: { c: number; d: number }) {
            return this.c + this.d;
          },
          c: 2,
          d: 3,
        },
      }),
    ).toBe(5);
  });

  test('Non-function or throwing calls return null', () => {
    // Callee not a function or throws during execution returns null
    let expr = expression('a.b()');
    expect(expr({ a: { b: 123 } })).toBe(null);

    expr = expression('p.x');
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('bad property');
        },
      },
    );
    expect(expr({ p: proxy })).toBe(null);

    expr = expression('a.b()');
    expect(
      expr({
        a: {
          b() {
            throw new Error('boom');
          },
        },
      }),
    ).toBe(null);
  });
});

describe('Operators and Precedence', () => {
  test('Arithmetic and parentheses precedence', () => {
    // Verify precedence for * / % vs + -, and parentheses
    let expr = expression('a.value + 12 - (2 * 14 / 4)');
    expect(expr({ a: { value: 1 } })).toBe(6);
    expect(expr({ a: { value: 3 } })).toBe(8);

    expr = expression('1 + 2 * 3');
    expect(expr({})).toBe(7);

    expr = expression('(1 + 2) * 3');
    expect(expr({})).toBe(9);
  });

  test('Comparisons and equality (loose/strict)', () => {
    // Verify > < >= <= and loose/strict equality
    let expr = expression('a === b && a !== c');
    expect(expr({ a: 1, b: 1, c: '1' })).toBe(true);
    expect(expr({ a: 1, b: 1, c: 1 })).toBe(false);

    expr = expression('a > 3 && b < 10');
    expect(expr({ a: 4, b: 5 })).toBe(true);
    expect(expr({ a: 3, b: 5 })).toBe(false);
    expect(expr({ a: 4, b: 11 })).toBe(false);

    expr = expression('a == b');
    expect(expr({ a: 10, b: 10 })).toBe(true);
    expect(expr({ a: 10, b: '10' })).toBe(true);
    expect(expr({ a: 10, b: '110' })).toBe(false);

    expr = expression('a != b');
    expect(expr({ a: 10, b: 10 })).toBe(false);
    expect(expr({ a: 10, b: '10' })).toBe(false);
    expect(expr({ a: 10, b: '110' })).toBe(true);

    expr = expression('a >= b && c <= d');
    expect(expr({ a: 2, b: 2, c: 3, d: 3 })).toBe(true);
    expect(expr({ a: 3, b: 2, c: 3, d: 4 })).toBe(true);
    expect(expr({ a: 2, b: 2, c: 3, d: 2 })).toBe(false);
    expect(expr({ a: 1, b: 2, c: 3, d: 3 })).toBe(false);
  });

  test('Logical operators (engine returns booleans)', () => {
    // Engine returns booleans for && and || rather than short-circuit values
    let expr = expression('a && b || c && ( d || e )');
    expect(expr({ a: true, b: false, c: true, d: false, e: true })).toBe(true);
    expect(expr({ a: false, b: true, c: false, d: true, e: false })).toBe(false);

    expr = expression('!a');
    expect(expr({ a: 1 })).toBe(false);
    expect(expr({ a: 0 })).toBe(true);
  });

  test('Conditional operator ?:', () => {
    const expr = expression('a > b ? b : a');
    expect(expr({ a: 2, b: 1 })).toBe(1);
    expect(expr({ a: 2, b: 3 })).toBe(2);
  });
});

describe('Type Coercion Edge Cases', () => {
  test('null/undefined with numeric operators', () => {
    // Match JS semantics for numeric operators
    let expr = expression('null + 1');
    expect(expr({})).toBe(1);

    expr = expression('undefined + 1');
    expect(Number.isNaN(expr({}) as number)).toBe(true);

    expr = expression('null * 2');
    expect(expr({})).toBe(0);

    expr = expression('undefined * 2');
    expect(Number.isNaN(expr({}) as number)).toBe(true);
  });

  test('String concatenation vs numeric addition', () => {
    let expr = expression('"a" + 1');
    expect(expr({})).toBe('a1');

    expr = expression('1 + "a"');
    expect(expr({})).toBe('1a');

    expr = expression('"a" + "b"');
    expect(expr({})).toBe('ab');
  });
});

describe('Modern JS Features (ES6+) Support', () => {
  test('Async calls: functions returning Promise', async () => {
    // Engine preserves return value; test via await
    const expr = expression('asyncAdd(1, 2)');
    const res = await expr({ asyncAdd: (a: number, b: number) => Promise.resolve(a + b) });
    expect(res).toBe(3);
  });

  test('Dynamic import simulation via identifier', async () => {
    // Simulate import() using env.import and verify Promise result
    const expr = expression('import("./mod")');
    const mod = await expr({ import: (p: string) => Promise.resolve({ default: p }) });
    expect(mod).toEqual({ default: './mod' });
  });

  test('Optional chaining', () => {
    let expr = expression('a?.b');
    expect(expr({})).toBe(undefined);

    expr = expression('a?.b?.c');
    expect(expr({ a: { b: null } })).toBe(undefined);
    expect(expr({ a: { b: { c: 3 } } })).toBe(3);

    expr = expression('a?.[\"b\"]?.c');
    expect(expr({})).toBe(undefined);

    // Optional call: short-circuits if callee is nullish
    expr = expression('a?.b()');
    expect(expr({})).toBe(undefined);
    expect(expr({ a: {} })).toBe(null); // non-callable returns null per engine semantics

    const env = {
      a: {
        b(this: { c: number }) {
          return this.c;
        },
        c: 7,
      },
    };
    expect(expr(env)).toBe(7);
  });
});

describe('Template Literals', () => {
  test('Basic interpolation and multi-line', () => {
    const expr1 = expression('`hello ${name}!`');
    expect(expr1({ name: 'world' })).toBe('hello world!');

    const expr2 = expression('`line1\n${x} line2`');
    expect(expr2({ x: 42 })).toBe('line1\n42 line2');
  });

  test('Nested template in expression and various types', () => {
    const expr = expression('`outer: ${`inner ${x}`}, bool=${b}, null=${n}`');
    expect(expr({ x: 1, b: false, n: null })).toBe('outer: inner 1, bool=false, null=null');
  });

  test.skip('Undefined variables should throw error', () => {
    const expr = expression('`value=${missing}`');
    expect(() => expr({})).toThrow('invalid expression: `value=${missing}`, undefined variable "missing"');
  });

  test('Error: unterminated template or expression', () => {
    expect(() => expression('`abc')).toThrow('invalid expression: `abc, unterminated template literal');
    expect(() => expression('`${a + 1`')).toThrow('invalid expression: `${a + 1`, unterminated template expression');
  });

  test('Tagged template literals', () => {
    const env = {
      tag(strings: TemplateStringsArray, ...values: unknown[]) {
        return `${strings.join('|')}|${values.join('|')}`;
      },
      obj: {
        t(strings: TemplateStringsArray, ...values: unknown[]) {
          // verify raw strings are available
          return `${(strings as any).raw.join('#')}#${values.join('#')}`;
        },
      },
    };
    const t1 = expression('tag`A${1}B${2}C`');
    expect(t1(env)).toBe('A|B|C|1|2');

    const t2 = expression('obj.t`X\\n${3}Y`');
    expect(t2(env)).toBe('X\\n#Y#3');
  });

  test('Escapes and Unicode in template', () => {
    const expr = expression('`star=\\u2605 tab=\\t`');
    expect(expr({})).toBe('star=★ tab=\t');
  });
});

describe('Error Handling and Edge Cases', () => {
  test('Invalid inputs and syntax errors', () => {
    // Missing expression
    expect(() => expression(undefined)).toThrow('invalid expression');

    // Invalid object key and structure
    expect(() => expression('{ ;a: 123 }')).toThrow('parse expression error: { ;a: 123 }');

    // Illegal semicolon
    expect(() => expression(';')).toThrow('parse expression error: ;');

    // Standalone backslash
    expect(() => expression('\\')).toThrow('invalid expression: \\');

    // Invalid Unicode escape in string
    expect(() => expression('"" || "\\uzzzz"')).toThrow(
      'invalid expression: "" || "\\uzzzz", invalid unicode escape [\\uzzzz]',
    );

    // Unclosed string
    expect(() => expression('"')).toThrow('invalid expression: "');

    // Invalid exponent format
    expect(() => expression('2e-a')).toThrow('invalid expression: 2e-a');

    // Ternary missing colon
    expect(() => expression('1 === 1 ? true')).toThrow('parse expression error: 1 === 1 ? true');

    // Illegal trailing semicolon
    expect(() => expression('1 === 1 ? true ;')).toThrow('parse expression error: 1 === 1 ? true ;');
  });
});

describe('Nullish Coalescing Operator ??', () => {
  test('Returns right for null/undefined; returns left otherwise', () => {
    let expr = expression('null ?? 1');
    expect(expr({})).toBe(1);

    expr = expression('undefined ?? 1');
    expect(expr({})).toBe(1);

    expr = expression('false ?? 1');
    expect(expr({})).toBe(false);

    expr = expression('0 ?? 7');
    expect(expr({})).toBe(0);

    expr = expression('"" ?? "default"');
    expect(expr({})).toBe('');
  });

  test('Short-circuits: right side not evaluated when left is non-nullish', () => {
    let count = 0;
    const env = {
      a: 1,
      inc: () => {
        count += 1;
        return 2;
      },
    };
    const expr = expression('a ?? inc()');
    expect(expr(env)).toBe(1);
    expect(count).toBe(0);

    const expr2 = expression('b ?? inc()');
    // b is missing identifier => evaluates to null in this engine
    expect(expr2(env)).toBe(2);
    expect(count).toBe(1);
  });

  test('Associativity and chaining', () => {
    const expr = expression('(a ?? b) ?? c');
    expect(expr({ a: null, b: null, c: 3 })).toBe(3);
    expect(expr({ a: 10, b: 20, c: 30 })).toBe(10);

    const expr2 = expression('a ?? (b ?? c)');
    expect(expr2({ a: null, b: 1, c: 2 })).toBe(1);
    expect(expr2({ a: null, b: null, c: 2 })).toBe(2);
  });
});

describe('Object Spread', () => {
  test('Basic spread merges properties', () => {
    const expr = expression('{ ...a }');
    expect(expr({ a: { x: 1, y: 2 } })).toEqual({ x: 1, y: 2 });
  });

  test('Spread with additional properties', () => {
    const expr = expression('{ ...a, z: 3 }');
    expect(expr({ a: { x: 1, y: 2 } })).toEqual({ x: 1, y: 2, z: 3 });
  });

  test('Multiple spreads and overriding order', () => {
    const expr = expression('{ ...a, ...b, x: 9 }');
    const env = { a: { x: 1, y: 1 }, b: { y: 2, z: 2 } };
    expect(expr(env)).toEqual({ x: 9, y: 2, z: 2 });
  });

  test('Spread non-object/nullish is a no-op', () => {
    let expr = expression('{ ...null }');
    expect(expr({})).toEqual({});

    expr = expression('{ ...undefined }');
    expect(expr({})).toEqual({});

    expr = expression('{ ...1 }');
    expect(expr({})).toEqual({});
  });

  test('Spread error-resistant behavior (proxy throwing on keys)', () => {
    const bad = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('bad');
        },
      },
    );
    const expr = expression('{ ...bad, a: 1 }');
    expect(expr({ bad })).toEqual({ a: 1 });
  });
});
