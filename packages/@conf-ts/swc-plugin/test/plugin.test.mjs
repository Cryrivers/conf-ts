import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { transformSync } from '@swc/core';

const plugin = resolve(import.meta.dirname, '..', 'conf_ts_swc_plugin.wasm');

test('loads as a standard SWC plugin and evaluates a macro call', () => {
  const filename = '/virtual/config.ts';
  const source = [
    "import { String } from '@conf-ts/macro';",
    'export const value = String(42);',
  ].join('\n');
  const result = transformSync(source, {
    filename,
    jsc: {
      parser: { syntax: 'typescript' },
      target: 'es2022',
      experimental: {
        plugins: [
          [
            plugin,
            {
              filename,
              project: {
                files: { [filename]: source },
                resolutions: {},
              },
            },
          ],
        ],
      },
    },
    module: { type: 'es6' },
  });

  assert.match(result.code, /value\s*=\s*["']42["']/u);
  assert.doesNotMatch(result.code, /String\(42\)/u);
  assert.doesNotMatch(result.code, /@conf-ts\/macro/u);
});

test('keeps shadowed aliases ordinary while expanding the imported binding', () => {
  const filename = '/virtual/config.ts';
  const source = [
    "import { String as macroString } from '@conf-ts/macro';",
    'export function untouched(macroString: (value: number) => number) {',
    '  return macroString(1);',
    '}',
    'export const value = macroString(42);',
  ].join('\n');
  const result = transformSync(source, {
    filename,
    jsc: {
      parser: { syntax: 'typescript' },
      target: 'es2022',
      experimental: {
        plugins: [
          [
            plugin,
            {
              project: {
                files: { [filename]: source },
                resolutions: {},
              },
            },
          ],
        ],
      },
    },
    module: { type: 'es6' },
  });

  assert.match(result.code, /return macroString\(1\)/u);
  assert.match(result.code, /value\s*=\s*["']42["']/u);
  assert.doesNotMatch(result.code, /@conf-ts\/macro/u);
});
