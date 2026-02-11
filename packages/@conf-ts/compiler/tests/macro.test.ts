import { describe, expect, it } from 'vitest';

import { compile } from '../src/compiler';
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

  it('should throw error when arrayMap callback is a function expression', () => {
    assertMacroError(
      'invalid-array-map-callback',
      'arrayMap: callback must be an arrow function',
    );
  });

  it('should throw error when arrayFilter callback is a function expression', () => {
    assertMacroError(
      'invalid-array-filter-callback',
      'arrayFilter: callback must be an arrow function',
    );
  });

  it('should throw error when type casting functions are not imported from @conf-ts/macro', () => {
    expect(() => {
      compile('tests/macros/invalid-imports.conf.ts', 'json', { macro: true });
    }).toThrow(
      "Type casting function 'String' must be imported from '@conf-ts/macro' to use in macro mode",
    );
  });

  it('should throw error when only some type casting functions are imported', () => {
    expect(() => {
      compile('tests/macros/partial-imports.conf.ts', 'json', { macro: true });
    }).toThrow(
      "Type casting function 'Boolean' must be imported from '@conf-ts/macro' to use in macro mode",
    );
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
