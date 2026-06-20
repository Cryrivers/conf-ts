import path from 'path';
import { compile as compileJs } from '@conf-ts/compiler';
import expression from '@conf-ts/expression';
import { describe, expect, it } from 'vitest';

import { assertMacroError, assertMacroOutput } from './test-utils';

const callbackError =
  'expr callback must be an arrow function with a single identifier parameter and expression body';

describe('Expr Macro', () => {
  it('should convert context property access into expression strings', () => {
    assertMacroOutput('expr');
  });

  it('should expand const and enum values to literals', () => {
    assertMacroOutput('expr-const');
  });

  it('should return output consumable by @conf-ts/expression', () => {
    const result = compileJs(
      path.resolve(__dirname, 'fixtures/macros/expr-const.conf.ts'),
      'json',
      { macroMode: true },
    );
    const output = JSON.parse(result.output);
    const compiled = expression(output.constNumber);
    expect(compiled({ value: 150 })).toBe(true);
    expect(compiled({ value: 50 })).toBe(false);
  });

  it('should reject block bodies', () => {
    assertMacroError('expr-invalid-block', callbackError);
  });

  it('should reject function expressions', () => {
    assertMacroError('expr-invalid-function', callbackError);
  });

  it('should reject async arrows', () => {
    assertMacroError('expr-invalid-async', callbackError);
  });

  it('should reject direct context parameter usage', () => {
    assertMacroError(
      'expr-invalid-direct-ctx',
      'expr callback cannot use the context parameter directly',
    );
  });

  it('should reject syntax unsupported by @conf-ts/expression', () => {
    assertMacroError('expr-invalid-syntax', 'parse expression error');
  });

  it('should require expr to be imported from @conf-ts/macro', () => {
    assertMacroError(
      'expr-invalid-no-import',
      "Macro function 'expr' must be imported from '@conf-ts/macro' to use in macro mode",
    );
  });
});
