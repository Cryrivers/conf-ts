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

  it('should compact formatting whitespace without changing literal whitespace', () => {
    assertMacroOutput('expr-compact');
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
