import { compileInMemory as compileInMemoryNative } from '@conf-ts/compiler-native';
import { compileInMemory as compileInMemoryJs } from '@conf-ts/compiler/browser';
import { describe, expect, it } from 'vitest';

import {
  assertJsxError,
  assertJsxOutput,
  assertSpecOutput,
} from './test-utils';

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

  it('should serialize component, member, and namespaced JSX tag names', () => {
    assertJsxOutput('type-names');
  });

  it('should support descriptor JSX type output', () => {
    assertJsxOutput('type-descriptor', {
      jsxOutput: { typeFormat: 'descriptor' },
    });
  });

  it('should support descriptor JSX type output in flat props mode', () => {
    assertJsxOutput('type-descriptor-flat', {
      jsxOutput: { type: '$type', props: false, typeFormat: 'descriptor' },
    });
  });

  it('should handle macro calls inside JSX attributes', () => {
    assertJsxOutput('with-macros', { macro: true });
  });

  it('should support flat JSX props output', () => {
    assertJsxOutput('flat-props', {
      jsxOutput: { type: '$type', props: false },
    });
  });

  it('should reject flat JSX props that collide with output fields', () => {
    assertJsxError('flat-props-conflict', 'conflicts with JSX output field', {
      jsx: true,
      jsxOutput: { props: false },
    });
  });

  it('should reject JSX children when children output is disabled', () => {
    const options = { jsx: true, jsxOutput: { children: false } } as const;
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

  it('should reject JSX unless compiler JSX support is enabled', () => {
    assertJsxError(
      'basic',
      'JSX is disabled. Enable it with compiler option jsx: true',
    );
    assertJsxError(
      'basic',
      'JSX is disabled. Enable it with compiler option jsx: true',
      {
        jsx: false,
      },
    );
  });

  it('should not reject non-JSX configs when compiler JSX support is not enabled', () => {
    assertSpecOutput('basic-default-export');
  });

  it('should support JSX output options in compileInMemory', () => {
    const files = {
      '/index.conf.tsx':
        'export default { field: <input type="text" name="email" /> }',
    };
    const options = {
      jsx: true,
      jsxOutput: { type: '$type', props: false },
    } as const;
    const expected = {
      field: { $type: 'input', type: 'text', name: 'email' },
    };

    expect(
      JSON.parse(
        compileInMemoryJs(files, '/index.conf.tsx', 'json', undefined, {
          ...options,
        }).output,
      ),
    ).toEqual(expected);
    expect(
      JSON.parse(
        compileInMemoryNative(
          files,
          '/index.conf.tsx',
          'json',
          undefined,
          options,
        ).output,
      ),
    ).toEqual(expected);
  });

  it('should reject JSX in compileInMemory unless compiler JSX support is enabled', () => {
    const files = {
      '/index.conf.tsx': 'export default { field: <input /> }',
    };
    const options = { jsx: false } as const;

    expect(() =>
      compileInMemoryJs(files, '/index.conf.tsx', 'json', undefined, options),
    ).toThrow('JSX is disabled. Enable it with compiler option jsx: true');
    expect(() =>
      compileInMemoryNative(
        files,
        '/index.conf.tsx',
        'json',
        undefined,
        options,
      ),
    ).toThrow('JSX is disabled. Enable it with compiler option jsx: true');
  });
});
