import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import webpack from 'webpack';

import {
  ConfTsWebpackPlugin,
  NativeMacroTransformPlugin,
  TypeScriptMacroTransformPlugin,
} from '../src/index';
import {
  createCompileOptions,
  interpolate,
  normalizeExtensionToRemove,
  resolveGeneratedPath,
} from '../src/loader';
import macroTransformLoader from '../src/macro-transform-plugin/loader';
import { CONF_TS_MACRO_TRANSFORM_META } from '../src/macro-transform-plugin/types';
import compileTask from '../src/worker';

describe('loader generated file path interpolation', () => {
  it('exports the native macro plugin from the root and /native subpath only', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
    );

    expect(NativeMacroTransformPlugin).toBeTypeOf('function');
    expect(packageJson.exports).toHaveProperty(
      './macro-transform-plugin/native',
    );
  });

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

  it('only passes ordinary compiler options to the worker', () => {
    expect(
      createCompileOptions({
        preserveKeyOrder: true,
      }),
    ).toEqual({
      preserveKeyOrder: true,
    });
  });

  it('rejects legacy macro and quote options with migration guidance', () => {
    expect(() => new ConfTsWebpackPlugin({ macro: true } as any)).toThrow(
      'TypeScriptMacroTransformPlugin or NativeMacroTransformPlugin',
    );
    expect(() => new ConfTsWebpackPlugin({ quote: 'single' } as any)).toThrow(
      'pass it to a MacroTransformPlugin',
    );
  });

  it.each([TypeScriptMacroTransformPlugin, NativeMacroTransformPlugin])(
    'installs %s as a pre-loader for JS and TS',
    Plugin => {
      const rules: any[] = [];
      const compiler = {
        options: { module: { rules } },
      } as any;

      new Plugin().apply(compiler);

      expect(rules).toHaveLength(1);
      expect(rules[0].enforce).toBe('pre');
      expect(rules[0].test.test('config.mts')).toBe(true);
      expect(rules[0].test.test('config.js')).toBe(true);
      expect(rules[0].exclude.test('/project/node_modules/pkg/index.ts')).toBe(
        true,
      );
    },
  );

  it('compiles the loader source payload without reading the entry path', () => {
    const filename = '/virtual/config.conf.ts';
    const code = 'export default { answer: 40 + 2 };';

    const result = compileTask({
      filename,
      code,
      project: { files: { [filename]: code } },
      format: 'json',
      options: {},
      compiler: 'js',
    });

    expect(JSON.parse(result.output)).toEqual({ answer: 42 });
    expect(result.dependencies).toContain(filename);
  });

  it('composes maps and carries project metadata through the pre-loader', async () => {
    const resourcePath = path.resolve(
      __dirname,
      '../../tests/fixtures/macros/array-map.conf.ts',
    );
    const source = fs.readFileSync(resourcePath, 'utf8');
    const inputMap = {
      version: 3,
      sources: [resourcePath],
      sourcesContent: [source],
      names: [],
      mappings: 'AAAA',
    };
    const inputMeta = { sentinel: true };
    const dependencies: string[] = [];

    const transformed = await new Promise<{
      code: string;
      map: any;
      meta: any;
    }>((resolve, reject) => {
      const context = {
        resourcePath,
        cacheable: vi.fn(),
        addDependency: (dependency: string) => dependencies.push(dependency),
        getOptions: () => ({
          implementation: 'typescript',
          transformOptions: { sourceMap: true },
        }),
        async:
          () => (error: Error | null, code: string, map: any, meta: any) => {
            if (error) reject(error);
            else resolve({ code, map, meta });
          },
      };

      void macroTransformLoader.call(
        context as any,
        source,
        inputMap,
        inputMeta,
      );
    });

    expect(transformed.code).not.toContain("from '@conf-ts/macro'");
    expect(transformed.map.version).toBe(3);
    expect(transformed.meta.sentinel).toBe(true);
    expect(
      transformed.meta[CONF_TS_MACRO_TRANSFORM_META].project.files[
        resourcePath
      ],
    ).toBe(transformed.code);
    expect(
      transformed.meta[CONF_TS_MACRO_TRANSFORM_META].transformDependencies,
    ).toContain(resourcePath);
    expect(dependencies).toContain(resourcePath);
  });

  it('runs the native macro pre-transform before ordinary compilation', async () => {
    const builtPlugin = require('../dist/cjs/index.js') as {
      ConfTsWebpackPlugin: typeof ConfTsWebpackPlugin;
      NativeMacroTransformPlugin: typeof NativeMacroTransformPlugin;
    };
    const context = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-ts-webpack-'));
    const filename = path.join(context, 'config.conf.ts');
    fs.writeFileSync(
      path.join(context, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'esnext' } }),
    );
    fs.writeFileSync(
      filename,
      [
        "import { String } from '@conf-ts/macro';",
        'export default { answer: String(40 + 2) };',
      ].join('\n'),
    );

    const compiler = webpack({
      context,
      mode: 'none',
      entry: './config.conf.ts',
      output: { path: path.join(context, 'dist'), filename: 'bundle.js' },
      plugins: [
        new builtPlugin.NativeMacroTransformPlugin(),
        new builtPlugin.ConfTsWebpackPlugin({
          compiler: 'js',
          useWorkers: false,
        }),
      ],
    });

    try {
      const stats = await new Promise<webpack.Stats>((resolve, reject) => {
        compiler.run((error, result) => {
          if (error) reject(error);
          else if (!result) reject(new Error('Webpack returned no stats'));
          else resolve(result);
        });
      });
      if (stats.hasErrors()) {
        throw new Error(stats.toString({ all: false, errors: true }));
      }

      const generated = JSON.parse(
        fs.readFileSync(path.join(context, 'config.generated.json'), 'utf8'),
      );
      expect(generated).toEqual({ answer: '42' });
    } finally {
      await new Promise<void>(resolve => compiler.close(() => resolve()));
      fs.rmSync(context, { force: true, recursive: true });
    }
  });
});
