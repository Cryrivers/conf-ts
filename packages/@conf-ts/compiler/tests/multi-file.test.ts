import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { compile } from '../src/compiler';

describe('Multi-file test', () => {
  it('should handle multiple file edits correctly', () => {
    const configPath = path.resolve(__dirname, 'multi-file');
    const { output: result } = compile(
      path.join(configPath, 'index.ts'),
      'json',
      false,
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(configPath, 'index.json'), 'utf8'),
    );
    expect(JSON.parse(result)).toEqual(expected);
  });

  it('should handle path aliases in tsconfig.json', () => {
    const configPath = path.resolve(__dirname, 'multi-file');
    const { output: result } = compile(
      path.join(configPath, 'index-with-aliases.ts'),
      'json',
      false,
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(configPath, 'index-with-aliases.json'), 'utf8'),
    );
    expect(JSON.parse(result)).toEqual(expected);
  });

  it('should handle complex path aliases with multiple directories', () => {
    const configPath = path.resolve(__dirname, 'multi-file');
    const { output: result } = compile(
      path.join(configPath, 'complex-aliases.ts'),
      'json',
      false,
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(configPath, 'complex-aliases.json'), 'utf8'),
    );
    expect(JSON.parse(result)).toEqual(expected);
  });

  it('should resolve numeric enums across files without initializers', () => {
    const configPath = path.resolve(__dirname, 'multi-file');
    const { output: result } = compile(
      path.join(configPath, 'numeric-enum.ts'),
      'json',
      false,
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(configPath, 'numeric-enum.json'), 'utf8'),
    );
    expect(JSON.parse(result)).toEqual(expected);
  });

  it('should not include unrelated enum files in dependencies', () => {
    const configPath = path.resolve(__dirname, 'multi-file');
    const { dependencies } = compile(
      path.join(configPath, 'numeric-enum.ts'),
      'json',
      false,
    );
    expect(dependencies).toEqual(
      expect.arrayContaining([
        path.join(configPath, 'numeric-enum.ts'),
        path.join(configPath, 'numeric-enum-decl.ts'),
      ]),
    );
    expect(dependencies).not.toContain(
      path.join(configPath, 'unrelated-enum.ts'),
    );
  });
});
