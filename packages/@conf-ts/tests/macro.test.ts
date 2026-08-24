import path from 'path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  assertMacroError,
  assertMacroOutput,
  compileJsWithMacro,
  compileNativeWithMacro,
} from './test-utils';

describe('Macro Test', () => {
  it('should evaluate reusable compile-time modifiers', () => {
    assertMacroOutput('modifier');

    const input = path.resolve(__dirname, 'fixtures/macros/modifier.conf.ts');
    for (const compile of [compileJsWithMacro, compileNativeWithMacro]) {
      const { output } = compile(input, 'json', {
        macro: true,
        preserveKeyOrder: true,
      });
      expect(
        Object.keys(
          (
            JSON.parse(output) as {
              overridden: Record<string, number>;
            }
          ).overridden,
        ),
      ).toEqual(['a', 'b']);
    }
  });

  it('should apply preserveKeyOrder throughout modifier evaluation', () => {
    assertMacroOutput('modifier-key-order');

    const input = path.resolve(
      __dirname,
      'fixtures/macros/modifier-key-order.conf.ts',
    );
    const expectedOrders = {
      inputArgument: ['a', 'b', 'c'],
      returnedObject: ['a', 'b', 'c', 'e'],
      directMerge: ['a', 'b', 'c', 'd'],
      nestedModifier: ['a', 'b', 'c', 'd', 'e'],
      nestedOuter: ['x', 'a', 'b', 'c', 'y'],
      nestedSibling: ['a', 'b', 'c'],
    };

    for (const compile of [compileJsWithMacro, compileNativeWithMacro]) {
      for (const format of ['json', 'yaml'] as const) {
        const { output } = compile(input, format, {
          macro: true,
          preserveKeyOrder: true,
        });
        const result = (
          format === 'json' ? JSON.parse(output) : parseYaml(output)
        ) as {
          inputArgument: Record<string, unknown>;
          returnedObject: Record<string, unknown>;
          directMerge: Record<string, unknown>;
          nestedModifier: Record<string, unknown>;
          nestedObject: {
            outer: Record<string, unknown>;
            sibling: Record<string, unknown>;
          };
        };

        expect(Object.keys(result.inputArgument)).toEqual(
          expectedOrders.inputArgument,
        );
        expect(Object.keys(result.returnedObject)).toEqual(
          expectedOrders.returnedObject,
        );
        expect(Object.keys(result.directMerge)).toEqual(
          expectedOrders.directMerge,
        );
        expect(Object.keys(result.nestedModifier)).toEqual(
          expectedOrders.nestedModifier,
        );
        expect(Object.keys(result.nestedObject.outer)).toEqual(
          expectedOrders.nestedOuter,
        );
        expect(Object.keys(result.nestedObject.sibling)).toEqual(
          expectedOrders.nestedSibling,
        );
      }
    }
  });

  it('should preserve and compose Expr values across static modifier inputs', () => {
    assertMacroOutput('modifier-expr-input');
  });

  it('should validate the context passed to Expr values from modifier inputs', () => {
    assertMacroError(
      'modifier-expr-input-invalid-context',
      "Nested Expr 'input.expression' must be called with exactly one argument: the current expr context parameter 'ctx'.",
    );
  });

  it('should reject invalid modifier callbacks', () => {
    assertMacroError(
      'modifier-invalid-callback-block',
      'modifier callback must be a synchronous arrow function whose body is a single expression',
    );
    assertMacroError(
      'modifier-invalid-callback-async',
      'modifier callback must be a synchronous arrow function whose body is a single expression',
    );
  });

  it('should reject dynamic modifier arguments', () => {
    assertMacroError(
      'modifier-invalid-dynamic',
      'modifier arguments must be statically analyzable',
    );
  });

  it('should reject modifier arity mismatches', () => {
    assertMacroError(
      'modifier-invalid-arity',
      'modifier expected at most 1 static argument(s), but received 2',
    );
    assertMacroError(
      'modifier-invalid-arity-missing',
      'modifier expected at least 1 static argument(s), but received 0',
    );
  });

  it('should reject modifier values escaping into runtime', () => {
    assertMacroError(
      'modifier-invalid-escape',
      'modifier values are compile-time-only',
    );
  });

  it('should reject mutable modifier aliases and nested parameter patterns', () => {
    assertMacroError(
      'modifier-invalid-let-alias',
      'modifier aliases must use const declarations',
    );
    assertMacroError(
      'modifier-invalid-pattern',
      'modifier parameters must be identifiers',
    );
  });

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
