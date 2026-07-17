import { describe, it } from 'vitest';

import { assertMacroError, assertMacroOutput } from './test-utils';

describe('Macro Test', () => {
  it('should handle type casting using String(), Number(), and Boolean() in Macro Mode', () => {
    assertMacroOutput('type-casting');
  });

  it('should handle arrayMap macro for mapping arrays', () => {
    assertMacroOutput('array-map');
  });

  it('should handle arrayFilter macro for filtering arrays', () => {
    assertMacroOutput('array-filter');
  });

  it('should handle arrayFlatMap macro for flattening mapped arrays', () => {
    assertMacroOutput('array-flat-map');
  });

  it('should throw error when arrayMap callback is a function expression', () => {
    assertMacroError('invalid-array-map-callback', {
      typescript: 'Unsupported call expression: arrayMap',
      native: 'Function "arrayMap" is only allowed in macro mode',
    });
  });

  it('should throw error when arrayFilter callback is a function expression', () => {
    assertMacroError('invalid-array-filter-callback', {
      typescript: 'Unsupported call expression: arrayFilter',
      native: 'Function "arrayFilter" is only allowed in macro mode',
    });
  });

  it('should throw error when arrayFlatMap callback is a function expression', () => {
    assertMacroError('invalid-array-flat-map-callback', {
      typescript: 'Unsupported call expression: arrayFlatMap',
      native: 'Function "arrayFlatMap" is only allowed in macro mode',
    });
  });

  it('should let the compiler validate calls not imported from @conf-ts/macro', () => {
    assertMacroError('invalid-imports', 'String');
  });

  it('should let the compiler validate unimported calls alongside imported macros', () => {
    assertMacroError('partial-imports', 'Boolean');
  });

  it('should handle ternary operator in macro mode', () => {
    assertMacroOutput('ternary');
  });

  it('should handle env macro for reading environment variables', () => {
    process.env.CONF_TS_FOO = 'foo';
    process.env.CONF_TS_BAR = 'bar';
    assertMacroOutput('env');
  });

  it('should handle env macro with default value', () => {
    process.env.CONF_TS_EXISTS = 'exists';
    delete process.env.CONF_TS_MISSING;
    assertMacroOutput('env-default');
  });

  it('should support nested macro: single call compatibility', () => {
    assertMacroOutput('nested-single');
  });

  it('should support nested macro: two-level chains', () => {
    assertMacroOutput('nested-two');
  });

  it('should support nested macro: multi-level and nested array macros', () => {
    assertMacroOutput('nested-multi');
  });

  it('should support nested macro: parameter passing in callbacks', () => {
    assertMacroOutput('nested-param');
  });
  it('should accept macro option in options dictionary', () => {
    assertMacroOutput('type-casting');
  });
});
