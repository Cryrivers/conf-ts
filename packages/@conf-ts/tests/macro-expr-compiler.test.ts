import path from 'path';
import expression from '@conf-ts/expression';
import {
  encodeStringLiteral,
  rewriteContextExpression,
} from '@conf-ts/macro-transformer';
import { describe, expect, it } from 'vitest';

import {
  assertMacroError,
  assertMacroOutput,
  compileJsWithMacro,
} from './test-utils';

const unsupportedExprError = {
  typescript: 'Unsupported call expression: expr',
  native: 'Function "expr" is only allowed in macro mode',
};

describe('Expr Macro', () => {
  it('should convert context property access into expression strings', () => {
    assertMacroOutput('expr');
  });

  it('should expand const and enum values to literals', () => {
    assertMacroOutput('expr-const');
  });

  it('should support extended binary and unary operators', () => {
    assertMacroOutput('expr-operators');
  });

  it('should normalize expr string quote output', () => {
    assertMacroOutput('expr-quote');
    assertMacroOutput('expr-quote-single', { quote: 'single' });
  });

  it('should encode compiler expr string literals by quote style', () => {
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

  it('should rewrite compiler context expressions by quote style', () => {
    expect(rewriteContextExpression('ctx.label === "x"', 'ctx')).toBe(
      'label === "x"',
    );
    expect(
      rewriteContextExpression('ctx.label === "it\'s"', 'ctx', {
        quote: 'single',
      }),
    ).toBe("label === 'it\\'s'");
    expect(
      rewriteContextExpression('`value=${ctx.label === "x"}`', 'ctx', {
        quote: 'single',
      }),
    ).toBe("`value=${label === 'x'}`");

    const source = rewriteContextExpression('ctx.label === "it\'s"', 'ctx', {
      quote: 'single',
    });
    expect(expression(source)({ label: "it's" })).toBe(true);
  });

  it('should render nested unary operators without extra whitespace', () => {
    expect(rewriteContextExpression('!ctx.a && !ctx.b', 'ctx')).toBe(
      '!a && !b',
    );
    expect(
      rewriteContextExpression('(!ctx.a || ~ctx.b) ? -ctx.c : +ctx.d', 'ctx'),
    ).toBe('(!a || ~b) ? -c : +d');
    expect(rewriteContextExpression('- -ctx.a + + +ctx.b', 'ctx')).toBe(
      '- -a + + +b',
    );
  });

  it('should compact formatting whitespace without changing literal whitespace', () => {
    assertMacroOutput('expr-compact');
  });

  it('should keep a method call on a non-context, non-constant receiver as a runtime call', () => {
    assertMacroOutput('expr-method-call');

    const { output: result } = compileJsWithMacro(
      path.resolve(__dirname, 'fixtures/macros/expr-method-call.conf.ts'),
      'json',
      { macro: true },
    );
    const output = JSON.parse(result) as Record<string, string>;
    expect(expression(output.arrayIncludes)({ quota: 2 })).toBe(true);
    expect(expression(output.arrayIncludes)({ quota: 3 })).toBe(false);
    expect(expression(output.stringIncludes)({ name: 'a' })).toBe(true);
    expect(expression(output.stringIncludes)({ name: 'z' })).toBe(false);
  });

  it('should down-level arrow, function-expression, and block-bodied callbacks passed to array methods', () => {
    assertMacroOutput('expr-array-callback');

    const { output: result } = compileJsWithMacro(
      path.resolve(__dirname, 'fixtures/macros/expr-array-callback.conf.ts'),
      'json',
      { macro: true },
    );
    const output = JSON.parse(result) as Record<string, string>;
    const base = {
      quota: 1,
      queue: [1, 2, 3, 4, 5, 6, -1, -2, 10],
      scores: [1, 2, 3, 4, 5],
      threshold: 4,
      matrix: [[1, -1], [-1, -2], [3]],
    };

    // Arrow function with an expression body.
    expect(expression(output.arrowExpressionBody)(base)).toBe(true);
    expect(expression(output.arrowExpressionBody)({ ...base, quota: 9 })).toBe(
      false,
    );

    // `function` expression callback, down-leveled into arrow syntax.
    expect(expression(output.functionExpressionBody)(base)).toBe(true);
    expect(
      expression(output.functionExpressionBody)({
        ...base,
        queue: [10, 20, 30],
      }),
    ).toBe(false);

    // Block-bodied arrow callback, down-leveled the same way.
    expect(expression(output.blockBodiedArrow)(base)).toBe(true);
    expect(
      expression(output.blockBodiedArrow)({ ...base, threshold: 100 }),
    ).toBe(false);

    // Multiple callback parameters.
    expect(expression(output.reduceSum)(base)).toBe(15);

    // Zero-parameter callback that still reaches into the outer context.
    expect(expression(output.someAboveZero)(base)).toBe(true);
    expect(expression(output.someAboveZero)({ ...base, quota: -1 })).toBe(
      false,
    );
    expect(
      expression(output.someAboveZero)({ ...base, queue: [], quota: 5 }),
    ).toBe(false);

    // Callback referencing an outer compile-time constant.
    expect(expression(output.anyAboveMinScore)(base)).toBe(true);
    expect(
      expression(output.anyAboveMinScore)({ ...base, scores: [1, 2, 3] }),
    ).toBe(false);

    // Chained callbacks on the same expression.
    expect(expression(output.chainedFilterMap)(base)).toEqual([
      2, 4, 6, 8, 10, 12, 20,
    ]);

    // Nested callback referencing the outer context parameter.
    expect(expression(output.filterAboveThreshold)(base)).toBe(3);

    // Two levels of nested callbacks.
    expect(expression(output.countPositiveRows)(base)).toBe(2);

    // Three levels of nested callbacks (arrow -> `function` expression ->
    // arrow), where the innermost callback cross-references names bound at
    // every enclosing level, not just its immediate parent.
    expect(expression(output.complexCombination)(base)).toBe(true);
    expect(
      expression(output.complexCombination)({ ...base, threshold: -10 }),
    ).toBe(false);
  });

  it('should support object/array destructuring, defaults, and rest parameters in nested callbacks', () => {
    assertMacroOutput('expr-array-callback-patterns');

    const { output: result } = compileJsWithMacro(
      path.resolve(
        __dirname,
        'fixtures/macros/expr-array-callback-patterns.conf.ts',
      ),
      'json',
      { macro: true },
    );
    const output = JSON.parse(result) as Record<string, string>;
    const base = {
      pairs: [
        { a: 5, b: 2 },
        { a: 1, b: 9 },
      ],
      matrix: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
      queue: [1, 2, 3],
      threshold: 4,
    };

    // Object destructuring (shorthand properties).
    expect(expression(output.objectDestructure)(base)).toBe(true);
    expect(
      expression(output.objectDestructure)({
        ...base,
        pairs: [{ a: 5, b: 2 }],
      }),
    ).toBe(false);

    // Array destructuring, including a hole.
    expect(expression(output.arrayDestructureWithHole)(base)).toEqual([
      2, 4, 6,
    ]);

    // Destructured property with its own default value.
    expect(expression(output.destructureWithDefault)(base)).toBe(true);
    expect(
      expression(output.destructureWithDefault)({ ...base, pairs: [{ a: 1 }] }),
    ).toBe(true);

    // Rest parameter.
    expect(expression(output.restParam)(base)).toBe(9);

    // Plain parameter default value — never triggers here since real array
    // elements are never `undefined`, but confirms no regression.
    expect(expression(output.defaultParam)(base)).toBe(false);
    expect(expression(output.defaultParam)({ ...base, queue: [] })).toBe(false);

    // `function` expression with a destructured parameter, down-leveled
    // into arrow syntax, still reaching into the outer context.
    expect(expression(output.functionExprDestructure)(base)).toBe(false);

    // Destructuring + a default value expression that itself references
    // the outer context + an outer constant, all in one callback.
    expect(expression(output.combinedPatterns)(base)).toBe(true);
    expect(
      expression(output.combinedPatterns)({
        ...base,
        pairs: [{ a: 1 }],
        threshold: 0,
      }),
    ).toBe(false);
  });

  it('should support array spread, object shorthand, and computed object keys', () => {
    assertMacroOutput('expr-new-syntax');

    const { output: result } = compileJsWithMacro(
      path.resolve(__dirname, 'fixtures/macros/expr-new-syntax.conf.ts'),
      'json',
      { macro: true },
    );
    const output = JSON.parse(result) as Record<string, string>;
    const base = { items: [1, 2, 3], key: 'k', value: 5 };

    // Array spread.
    expect(expression(output.arraySpread)(base)).toEqual([1, 2, 3, 99]);

    // Shorthand referencing a nested callback's own bound parameter — not a
    // compile-time constant, so it stays as runtime shorthand text.
    expect(expression(output.shorthandNestedParam)(base)).toEqual([
      { item: 1, doubled: 2 },
      { item: 2, doubled: 4 },
      { item: 3, doubled: 6 },
    ]);

    // Shorthand referencing an outer compile-time constant, folded to a
    // literal alongside an explicit context property.
    expect(expression(output.shorthandOuterConst)(base)).toEqual({
      TAX_RATE: 0.08,
      key: 'k',
    });

    // Computed key rooted in the context parameter.
    expect(expression(output.computedContextKey)(base)).toEqual({ k: 5 });

    // Computed key referencing an outer compile-time constant, folded to a
    // literal key.
    expect(expression(output.computedConstKey)(base)).toEqual({ dyn: 5 });
  });

  it('should reject a nested callback parameter that shadows the context parameter', () => {
    assertMacroError('expr-invalid-callback-shadow', unsupportedExprError);
  });

  it('should reject a nested callback block body with more than a single return statement', () => {
    assertMacroError('expr-invalid-callback-block', unsupportedExprError);
  });

  it('should reject an async nested callback', () => {
    assertMacroError('expr-invalid-callback-async', unsupportedExprError);
  });

  it('should reject invalid quote options', () => {
    assertMacroError('expr', "quote must be 'single' or 'double'", {
      quote: 'nope' as any,
    });
  });

  it('should return output consumable by @conf-ts/expression', () => {
    const result = compileJsWithMacro(
      path.resolve(__dirname, 'fixtures/macros/expr-const.conf.ts'),
      'json',
      { macro: true },
    );
    const output = JSON.parse(result.output);
    const compiled = expression(output.constNumber);
    expect(compiled({ value: 150 })).toBe(true);
    expect(compiled({ value: 50 })).toBe(false);
  });

  it('should return single-quoted quote matrix output consumable by @conf-ts/expression', () => {
    const result = compileJsWithMacro(
      path.resolve(__dirname, 'fixtures/macros/expr-quote-single.conf.ts'),
      'json',
      { macro: true, quote: 'single' },
    );
    const output = JSON.parse(result.output);

    expect(expression(output.capturedControl)({ key: '\u0001' })).toBe(true);
    expect(expression(output.capturedNonAscii)({ key: '星' })).toBe(true);
  });

  it('should evaluate other @conf-ts/macro functions used inside an expr callback', () => {
    delete process.env.CONF_TS_EXPR_MACRO_MODE;
    assertMacroOutput('expr-macro');
  });

  it('should compose Expr values recursively with the current context', () => {
    assertMacroOutput('expr-compose');

    const { output: result } = compileJsWithMacro(
      path.resolve(__dirname, 'fixtures/macros/expr-compose.conf.ts'),
      'json',
      { macro: true },
    );
    const output = JSON.parse(result) as Record<string, string>;
    expect(
      expression(output.single)({
        a: true,
        b: false,
        c: true,
        name: '',
        score: 0,
      }),
    ).toBe(true);
    expect(
      expression(output.single)({
        a: false,
        b: true,
        c: true,
        name: '',
        score: 0,
      }),
    ).toBe(false);
    expect(
      expression(output.multiLevel)({
        a: false,
        b: true,
        c: true,
        name: '',
        score: 0,
      }),
    ).toBe(true);
  });

  it('should fold a call whose argument only coincidentally shares text with the context parameter', () => {
    const result = compileJsWithMacro(
      path.resolve(__dirname, 'fixtures/macros/expr-macro.conf.ts'),
      'json',
      { macro: true },
    );
    const output = JSON.parse(result.output);
    // An object key or property access spelled `ctx` isn't a reference to
    // the context parameter, so these must fold to a literal instead of
    // being kept as an unresolvable runtime call.
    expect(output.objectKeyNamedCtx).toBe('1');
    expect(output.propertyNamedCtx).toBe('41');
  });

  it('should keep String/Number/Boolean as a runtime call when they cannot be folded to a constant', () => {
    assertMacroOutput('expr-macro-runtime');

    const result = compileJsWithMacro(
      path.resolve(__dirname, 'fixtures/macros/expr-macro-runtime.conf.ts'),
      'json',
      { macro: true },
    );
    const output = JSON.parse(result.output);
    expect(expression(output.runtimeString)({ a: '5', n: 5 })).toBe(true);
    expect(expression(output.runtimeString)({ a: '5', n: 6 })).toBe(false);
    expect(expression(output.mixedFold)({ n: 1 })).toBe(42);
    expect(expression(output.nestedRuntime)({ a: '3' })).toBe(true);
    expect(expression(output.nestedRuntime)({ a: '' })).toBe(false);
  });

  it('should reject macro calls referencing an identifier that is neither a constant nor sourced from the context', () => {
    assertMacroError('expr-invalid-macro-context', unsupportedExprError);
  });

  it('should reject a type-casting macro call with the wrong number of arguments even when it touches the context', () => {
    assertMacroError('expr-invalid-macro-arity', unsupportedExprError);
  });

  it('should reject block bodies', () => {
    assertMacroError('expr-invalid-block', unsupportedExprError);
  });

  it('should reject function expressions', () => {
    assertMacroError('expr-invalid-function', unsupportedExprError);
  });

  it('should reject async arrows', () => {
    assertMacroError('expr-invalid-async', unsupportedExprError);
  });

  it('should reject direct context parameter usage', () => {
    assertMacroError('expr-invalid-direct-ctx', unsupportedExprError);
  });

  it('should reject syntax unsupported by @conf-ts/expression', () => {
    assertMacroError('expr-invalid-syntax', unsupportedExprError);
  });

  it('should require expr to be imported from @conf-ts/macro', () => {
    assertMacroError('expr-invalid-no-import', unsupportedExprError);
  });
});
