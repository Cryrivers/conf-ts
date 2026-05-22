import path from 'path';
import { describe, expect, it } from 'vitest';

import {
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
});
