import fs from 'fs';
import path from 'path';
import { compile as compileJs } from '@conf-ts/compiler';
import { compile as compileNative } from '@conf-ts/compiler-native';
import { describe, expect, it } from 'vitest';





describe('Multi-file test', () => {
  it('should handle multiple file edits correctly', () => {
    const configPath = path.resolve(__dirname, 'fixtures/multi-file');
    const { output: resultJs } = compileJs(
      path.join(configPath, 'index.ts'),
      'json',
      { macroMode: false },
    );
    const { output: resultNative } = compileNative(
      path.join(configPath, 'index.ts'),
      'json',
      { macroMode: false },
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(configPath, 'index.json'), 'utf8'),
    );
    expect(JSON.parse(resultJs)).toEqual(expected);
    expect(JSON.parse(resultNative)).toEqual(expected);
  });

  it('should handle path aliases in tsconfig.json', () => {
    const configPath = path.resolve(__dirname, 'fixtures/multi-file');
    const { output: resultJs } = compileJs(
      path.join(configPath, 'index-with-aliases.ts'),
      'json',
      { macroMode: false },
    );
    const { output: resultNative } = compileNative(
      path.join(configPath, 'index-with-aliases.ts'),
      'json',
      { macroMode: false },
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(configPath, 'index-with-aliases.json'), 'utf8'),
    );
    expect(JSON.parse(resultJs)).toEqual(expected);
    expect(JSON.parse(resultNative)).toEqual(expected);
  });

  it('should handle complex path aliases with multiple directories', () => {
    const configPath = path.resolve(__dirname, 'fixtures/multi-file');
    const { output: resultJs } = compileJs(
      path.join(configPath, 'complex-aliases.ts'),
      'json',
      { macroMode: false },
    );
    const { output: resultNative } = compileNative(
      path.join(configPath, 'complex-aliases.ts'),
      'json',
      { macroMode: false },
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(configPath, 'complex-aliases.json'), 'utf8'),
    );
    expect(JSON.parse(resultJs)).toEqual(expected);
    expect(JSON.parse(resultNative)).toEqual(expected);
  });

  it('should resolve numeric enums across files without initializers', () => {
    const configPath = path.resolve(__dirname, 'fixtures/multi-file');
    const { output: resultJs } = compileJs(
      path.join(configPath, 'numeric-enum.ts'),
      'json',
      { macroMode: false },
    );
    const { output: resultNative } = compileNative(
      path.join(configPath, 'numeric-enum.ts'),
      'json',
      { macroMode: false },
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(configPath, 'numeric-enum.json'), 'utf8'),
    );
    expect(JSON.parse(resultJs)).toEqual(expected);
    expect(JSON.parse(resultNative)).toEqual(expected);
  });

  it('should not include unrelated enum files in dependencies', () => {
    const configPath = path.resolve(__dirname, 'fixtures/multi-file');
    const { dependencies: dependenciesJs } = compileJs(
      path.join(configPath, 'numeric-enum.ts'),
      'json',
      { macroMode: false },
    );
    const { dependencies: nativeDependencies } = compileNative(
      path.join(configPath, 'numeric-enum.ts'),
      'json',
      { macroMode: false },
    );
    expect(dependenciesJs).toEqual(
      expect.arrayContaining([
        path.join(configPath, 'numeric-enum.ts'),
        path.join(configPath, 'numeric-enum-decl.ts'),
      ]),
    );
    expect(dependenciesJs).not.toContain(
      path.join(configPath, 'unrelated-enum.ts'),
    );
    expect(nativeDependencies).toEqual(
      expect.arrayContaining([
        path.join(configPath, 'numeric-enum.ts'),
        path.join(configPath, 'numeric-enum-decl.ts'),
      ]),
    );
    expect(nativeDependencies).not.toContain(
      path.join(configPath, 'unrelated-enum.ts'),
    );
  });
});