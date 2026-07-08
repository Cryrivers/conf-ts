import path from 'path';
import { describe, expect, it } from 'vitest';

import { ConfTsWebpackPlugin, shouldInjectJsxOutput } from '../src/index';
import {
  createCompileOptions,
  interpolate,
  normalizeExtensionToRemove,
  resolveGeneratedPath,
} from '../src/loader';

describe('loader generated file path interpolation', () => {
  it('keeps string extensionToRemove behavior', () => {
    const resourcePath = path.join('/project', 'src', 'app.conf.ts');

    expect(
      interpolate(
        '[path][name].generated.json',
        resourcePath,
        '/project',
        normalizeExtensionToRemove('.conf.ts'),
      ),
    ).toBe('src/app.generated.json');
  });

  it('supports array extensionToRemove values for broader test rules', () => {
    const resourcePath = path.join('/project', 'src', 'app.conf.tsx');

    expect(
      interpolate(
        '[path][name].generated.json',
        resourcePath,
        '/project',
        normalizeExtensionToRemove(['.conf.ts', '.conf.tsx']),
      ),
    ).toBe('src/app.generated.json');
  });

  it('uses the longest matching extensionToRemove value', () => {
    const resourcePath = path.join('/project', 'src', 'app.conf.ts');

    expect(
      interpolate(
        '[name].generated.json',
        resourcePath,
        '/project',
        normalizeExtensionToRemove(['.ts', '.conf.ts']),
      ),
    ).toBe('app.generated.json');
  });

  it('leaves the basename unchanged when no extensionToRemove value matches', () => {
    const resourcePath = path.join('/project', 'src', 'app.config.ts');

    expect(
      interpolate(
        '[name].generated.json',
        resourcePath,
        '/project',
        normalizeExtensionToRemove('.conf.ts'),
      ),
    ).toBe('app.config.ts.generated.json');
  });

  it('resolves the default generated file path next to the source file', () => {
    const resourcePath = path.join('/project', 'src', 'nested', 'app.conf.ts');

    expect(
      resolveGeneratedPath(
        '[path][name].generated.json',
        resourcePath,
        '/project',
        normalizeExtensionToRemove('.conf.ts'),
      ),
    ).toBe(path.join('/project', 'src', 'nested', 'app.generated.json'));
  });

  it('passes jsx:true through to compiler options', () => {
    expect(
      createCompileOptions({
        jsx: true,
        macro: true,
        preserveKeyOrder: true,
        jsxOutput: { type: '$type', props: false },
      }),
    ).toEqual({
      macroMode: true,
      preserveKeyOrder: true,
      jsx: true,
      jsxOutput: { type: '$type', props: false },
    });
  });

  it('validates jsx as a boolean plugin option', () => {
    expect(() => new ConfTsWebpackPlugin({ jsx: 'false' as any })).toThrow(
      'jsx must be a boolean',
    );
  });

  it('injects JSX output banner only when jsx is enabled', () => {
    expect(shouldInjectJsxOutput(undefined)).toBe(false);
    expect(shouldInjectJsxOutput(true)).toBe(true);
    expect(shouldInjectJsxOutput(false)).toBe(false);
  });
});
