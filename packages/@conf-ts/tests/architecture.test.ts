import path from 'path';
import * as compiler from '@conf-ts/compiler';
import * as nativeCompiler from '@conf-ts/compiler-native';
import * as macroTransformer from '@conf-ts/macro-transformer';
import { transform as nativeMacroTransform } from '@conf-ts/macro-transformer-native';
import { describe, expect, it } from 'vitest';

describe('source-oriented architecture', () => {
  it('compiles an injected source project without a filesystem read', () => {
    const filename = '/virtual/config.ts';
    const code = 'export default { answer: 40 + 2 };';

    const input = {
      filename,
      code,
      project: { files: { [filename]: 'export default { answer: 0 };' } },
    };

    for (const compile of [compiler.compile, nativeCompiler.compile]) {
      const result = compile(input, 'json');
      expect(JSON.parse(result.output)).toEqual({ answer: 42 });
      expect(result.dependencies).toContain(filename);
    }
  });

  it('resolves project imports with and without an explicit resolution table', () => {
    const filename = '/virtual/index.ts';
    const dependency = '/virtual/value.ts';
    const code =
      "import { value } from './value'; export default { answer: value };";
    const files = {
      [filename]: code,
      [dependency]: 'export const value = 42;',
    };

    for (const project of [
      { files },
      {
        files,
        resolutions: { [filename]: { './value': dependency } },
      },
    ]) {
      for (const compile of [compiler.compile, nativeCompiler.compile]) {
        const result = compile({ filename, code, project }, 'json');
        expect(JSON.parse(result.output)).toEqual({ answer: 42 });
        expect(result.dependencies).toEqual(
          expect.arrayContaining([filename, dependency]),
        );
      }
    }
  });

  it('resolves baseUrl/paths aliases from an inline source project in both compilers', () => {
    const filename = '/virtual/index.ts';
    const dependency = '/virtual/answer.ts';
    const code =
      "import { answer } from '@/answer'; export default { answer };";
    const project = {
      files: { [filename]: code, [dependency]: 'export const answer = 42;' },
      compilerOptions: {
        baseUrl: '/virtual',
        paths: { '@/*': ['*'] },
      },
    };

    for (const compile of [compiler.compile, nativeCompiler.compile]) {
      const result = compile({ filename, code, project }, 'json');
      expect(JSON.parse(result.output)).toEqual({ answer: 42 });
      expect(result.dependencies).toEqual(
        expect.arrayContaining([filename, dependency]),
      );
    }
  });

  it('resolves in-memory aliases from compilerOptions in both compilers', () => {
    const files = {
      '/virtual/index.ts':
        "import { answer } from '@/answer'; export default { answer };",
      '/virtual/src/answer.ts': 'export const answer = 42;',
    };
    const tsconfig = {
      compilerOptions: {
        baseUrl: '/virtual',
        paths: { '@/*': ['src/*'] },
      },
    };

    for (const compileInMemory of [
      compiler.compileInMemory,
      nativeCompiler.compileInMemory,
    ]) {
      const result = compileInMemory(
        files,
        '/virtual/index.ts',
        'json',
        tsconfig,
      );
      expect(JSON.parse(result.output)).toEqual({ answer: 42 });
    }
  });

  it('keeps compiler and macro composition explicit', () => {
    expect(compiler).not.toHaveProperty('compileTransformed');
    expect(compiler).not.toHaveProperty('compileInMemoryTransformed');
    expect(macroTransformer).not.toHaveProperty('compile');
    expect(macroTransformer).not.toHaveProperty('compileInMemory');
  });

  it('transforms macro calls outside the default-export evaluation path', () => {
    const filename = path.resolve(
      __dirname,
      'fixtures/macros/type-casting.conf.ts',
    );
    const code = [
      "import { String } from '@conf-ts/macro';",
      'export const eagerlyTransformed = String(42);',
      'export default { untouched: true };',
    ].join('\n');
    const project = macroTransformer.createMacroProjectSnapshot([filename]);

    const result = macroTransformer.transform({ filename, code, project });
    const nativeResult = nativeMacroTransform({ filename, code, project });

    expect(result.code).toContain('export const eagerlyTransformed = "42";');
    expect(result.code).not.toContain('@conf-ts/macro');
    expect(result.code).not.toContain('String(42)');
    expect(result).toHaveProperty('map', null);
    expect(nativeResult).toHaveProperty('map', null);
  });

  it('keeps aliases and shadowed calls binding-aware across transformers', () => {
    const filename = path.resolve(
      __dirname,
      'fixtures/macros/type-casting.conf.ts',
    );
    const code = [
      "import { String as macroString } from '@conf-ts/macro';",
      'export function untouched(macroString: (value: number) => number) {',
      '  return macroString(1);',
      '}',
      'export const eagerlyTransformed = macroString(42);',
      'export default { untouched: true };',
    ].join('\n');
    const project = macroTransformer.createMacroProjectSnapshot([filename]);
    const input = { filename, code, project };

    const typescriptResult = macroTransformer.transform(input);
    const nativeResult = nativeMacroTransform(input);

    expect(nativeResult.code).toBe(typescriptResult.code);
    expect(typescriptResult.code).toContain('return macroString(1);');
    expect(typescriptResult.code).toContain(
      'export const eagerlyTransformed = "42";',
    );
    expect(typescriptResult.code).not.toContain('@conf-ts/macro');
  });

  it('supports namespace macros without leaving a runtime import', () => {
    const filename = path.resolve(
      __dirname,
      'fixtures/macros/type-casting.conf.ts',
    );
    const code = [
      "import * as macros from '@conf-ts/macro';",
      'export const eagerlyTransformed = macros.String(42);',
      'export default { untouched: true };',
    ].join('\n');
    const project = macroTransformer.createMacroProjectSnapshot([filename]);
    const input = { filename, code, project };

    const typescriptResult = macroTransformer.transform(input);
    const nativeResult = nativeMacroTransform(input);

    expect(nativeResult.code).toBe(typescriptResult.code);
    expect(typescriptResult.code).toContain(
      'export const eagerlyTransformed = "42";',
    );
    expect(typescriptResult.code).not.toContain('@conf-ts/macro');
    expect(typescriptResult.code).not.toContain('macros.String');
  });

  it('transforms combined arrayMap and expr macros in a single pass', () => {
    const filename = '/virtual/config.ts';
    const code = [
      "import { arrayMap, expr } from '@conf-ts/macro';",
      'const n = 2;',
      'export default { a: arrayMap([1, 2], x => x + n), b: expr(ctx => ctx.a > n) };',
    ].join('\n');
    const project = { files: { [filename]: code } };
    const input = { filename, code, project };

    const typescriptResult = macroTransformer.transform(input);
    const nativeResult = nativeMacroTransform(input);

    expect(nativeResult.code).toBe(typescriptResult.code);
    expect(typescriptResult.code).toContain('a: [3, 4]');
    expect(typescriptResult.code).toContain('b: "a > 2"');
  });

  it('retains a namespace import that is also used as a type', () => {
    const filename = path.resolve(
      __dirname,
      'fixtures/macros/type-casting.conf.ts',
    );
    const code = [
      "import * as macros from '@conf-ts/macro';",
      'export const eagerlyTransformed = macros.String(42);',
      'export type Kept = typeof macros;',
      'export default { untouched: true };',
    ].join('\n');
    const project = macroTransformer.createMacroProjectSnapshot([filename]);
    const input = { filename, code, project };

    const typescriptResult = macroTransformer.transform(input);
    const nativeResult = nativeMacroTransform(input);

    expect(nativeResult.code).toBe(typescriptResult.code);
    expect(typescriptResult.code).toMatch(/^import \* as macros/);
    expect(typescriptResult.code).toContain('eagerlyTransformed = "42"');
  });

  it('leaves a locally bound macro name entirely untouched', () => {
    const filename = '/virtual/config.ts';
    const code =
      'const String = (value: number) => value; export default String(1);';
    const project = { files: { [filename]: code } };
    const input = { filename, code, project };

    const typescriptResult = macroTransformer.transform(input);
    const nativeResult = nativeMacroTransform(input);

    expect(typescriptResult.code).toBe(code);
    expect(nativeResult.code).toBe(code);
  });

  it('leaves unimported macro-like calls entirely untouched', () => {
    const filename = '/virtual/config.ts';
    const code =
      'export default { cast: String(1), value: expr(ctx => ctx.a) };';
    const project = { files: { [filename]: code } };
    const input = { filename, code, project };

    const typescriptResult = macroTransformer.transform(input);
    const nativeResult = nativeMacroTransform(input);

    expect(typescriptResult.code).toBe(code);
    expect(nativeResult.code).toBe(code);
  });

  it('removes only macro specifiers from mixed imports', () => {
    const filename = path.resolve(
      __dirname,
      'fixtures/macros/type-casting.conf.ts',
    );
    const code = [
      "import { String, type PreservedType } from '@conf-ts/macro';",
      'export const eagerlyTransformed = String(42);',
      'export type Kept = PreservedType;',
      'export default { untouched: true };',
    ].join('\n');
    const project = macroTransformer.createMacroProjectSnapshot([filename]);
    const input = { filename, code, project };

    const typescriptResult = macroTransformer.transform(input);
    const nativeResult = nativeMacroTransform(input);

    expect(nativeResult.code).toBe(typescriptResult.code);
    expect(typescriptResult.code).toContain(
      "import { type PreservedType } from '@conf-ts/macro';",
    );
    expect(typescriptResult.code).not.toContain('{ String,');
    expect(typescriptResult.code).not.toContain('String(42)');
  });

  it('keeps calls and imports that cannot be transformed', () => {
    const filename = '/virtual/config.ts';
    const code = [
      "import { String, arrayMap } from '@conf-ts/macro';",
      'const values = getValues();',
      'export const transformed = String(42);',
      'export const untouched = arrayMap(values, function (value) { return value; });',
    ].join('\n');
    const project = { files: { [filename]: code } };
    const input = { filename, code, project };

    const typescriptResult = macroTransformer.transform(input);
    const nativeResult = nativeMacroTransform(input);

    expect(nativeResult.code).toBe(typescriptResult.code);
    expect(typescriptResult.code).toContain(
      "import { String, arrayMap } from '@conf-ts/macro';",
    );
    expect(typescriptResult.code).toContain('transformed = "42"');
    expect(typescriptResult.code).toContain(
      'arrayMap(values, function (value) { return value; })',
    );
  });
});
