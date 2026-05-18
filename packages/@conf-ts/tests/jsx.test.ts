import { compileInMemory as compileInMemoryNative } from '@conf-ts/compiler-native';
import { compileInMemory as compileInMemoryJs } from '@conf-ts/compiler/browser';
import { describe, expect, it } from 'vitest';

import { assertJsxError, assertJsxOutput } from './test-utils';

describe('JSX Test', () => {
  it('should handle intrinsic tags, attributes, children, fragments, and custom tags', () => {
    assertJsxOutput('basic');
  });

  it('should handle spread attributes and key handling', () => {
    assertJsxOutput('spread');
  });

  it('should handle imports from other files', () => {
    assertJsxOutput('imports');
  });

  it('should handle macro calls inside JSX attributes', () => {
    assertJsxOutput('with-macros', { macroMode: true });
  });

  it('should support flat JSX props output', () => {
    assertJsxOutput('flat-props', {
      jsxOutput: { type: '$type', props: false },
    });
  });

  it('should reject flat JSX props that collide with output fields', () => {
    assertJsxError('flat-props-conflict', 'conflicts with JSX output field', {
      jsxOutput: { props: false },
    });
  });

  it('should reject JSX children when children output is disabled', () => {
    const options = { jsxOutput: { children: false } } as const;
    assertJsxError(
      'children-disabled-text',
      'JSX children are disabled',
      options,
    );
    assertJsxError(
      'children-disabled-expression',
      'JSX children are disabled',
      options,
    );
    assertJsxError(
      'children-disabled-element',
      'JSX children are disabled',
      options,
    );
    assertJsxError(
      'children-disabled-fragment',
      'JSX children are disabled',
      options,
    );
  });

  it('should support JSX output options in compileInMemory', () => {
    const files = {
      '/index.conf.tsx':
        'export default { field: <input type="text" name="email" /> }',
    };
    const options = { jsxOutput: { type: '$type', props: false } } as const;
    const expected = {
      field: { $type: 'input', type: 'text', name: 'email' },
    };

    expect(
      JSON.parse(
        compileInMemoryJs(files, '/index.conf.tsx', 'json', false, undefined, {
          ...options,
        }).output,
      ),
    ).toEqual(expected);
    expect(
      JSON.parse(
        compileInMemoryNative(files, '/index.conf.tsx', 'json', false, options)
          .output,
      ),
    ).toEqual(expected);
  });
});
