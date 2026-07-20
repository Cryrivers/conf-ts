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

const runtimeMacroTransformer =
  require('@conf-ts/macro-transformer') as typeof import('@conf-ts/macro-transformer');
const runtimeNativeMacroTransformer =
  require('@conf-ts/macro-transformer-native') as typeof import('@conf-ts/macro-transformer-native');

async function runMacroTransformLoader(options: {
  resourcePath: string;
  source: string;
  compilation?: object;
  implementation?: 'typescript' | 'native';
  transformOptions?: Record<string, unknown>;
  configLoader?: boolean;
  sourceMap?: boolean;
}): Promise<{ code: string; map: any; meta: any; dependencies: string[] }> {
  const dependencies: string[] = [];
  return new Promise((resolve, reject) => {
    const context = {
      resourcePath: options.resourcePath,
      sourceMap: options.sourceMap,
      ...(options.compilation ? { _compilation: options.compilation } : {}),
      loaders:
        (options.configLoader ?? options.resourcePath.includes('.conf.'))
          ? [{ options: { confTsConfigLoader: true } }]
          : [],
      cacheable: vi.fn(),
      addDependency: (dependency: string) => dependencies.push(dependency),
      getOptions: () => ({
        implementation: options.implementation ?? 'typescript',
        transformOptions: options.transformOptions ?? {},
      }),
      async: () => (error: Error | null, code: string, map: any, meta: any) => {
        if (error) reject(error);
        else resolve({ code, map, meta, dependencies });
      },
    };

    void macroTransformLoader.call(context as any, options.source);
  });
}

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

  it('puts only a sorted environment fingerprint in persistent loader options', () => {
    const rules: any[] = [];
    const compiler = {
      options: { module: { rules } },
    } as any;
    const previous = process.env.CONF_TS_FINGERPRINT_SECRET;
    process.env.CONF_TS_FINGERPRINT_SECRET = 'must-not-leak';
    try {
      new TypeScriptMacroTransformPlugin().apply(compiler);
      const loaderOptions = rules[0].use[0].options;
      expect(loaderOptions.environmentFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(loaderOptions)).not.toContain('must-not-leak');
    } finally {
      if (previous === undefined) delete process.env.CONF_TS_FINGERPRINT_SECRET;
      else process.env.CONF_TS_FINGERPRINT_SECRET = previous;
    }
  });

  it('passes through ordinary modules without scanning a project', async () => {
    const snapshot = vi.spyOn(
      runtimeMacroTransformer,
      'createMacroProjectSnapshot',
    );
    try {
      const result = await runMacroTransformLoader({
        resourcePath: '/virtual/ordinary.ts',
        source: 'export const ordinary = 42;',
        configLoader: false,
      });
      expect(result.code).toBe('export const ordinary = 42;');
      expect(result.meta).toBeUndefined();
      expect(result.dependencies).toEqual([]);
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      snapshot.mockRestore();
    }
  });

  it('defaults source maps to the webpack loader context', async () => {
    const resourcePath = path.resolve(
      __dirname,
      '../../tests/fixtures/macros/array-map.conf.ts',
    );
    const source = fs.readFileSync(resourcePath, 'utf8');
    const disabled = await runMacroTransformLoader({
      resourcePath,
      source,
      sourceMap: false,
    });
    const enabled = await runMacroTransformLoader({
      resourcePath,
      source,
      sourceMap: true,
    });
    expect(disabled.map).toBeFalsy();
    expect(enabled.map.version).toBe(3);
  });

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

  it('reuses one transformed project across modules in a compilation', async () => {
    const context = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-ts-cache-'));
    const entryPath = path.join(context, 'config.conf.ts');
    const dependencyPath = path.join(context, 'dependency.ts');
    const entrySource = [
      "import { answer } from './dependency';",
      'export default { answer };',
    ].join('\n');
    const dependencySource = [
      "import { String } from '@conf-ts/macro';",
      'export const answer = String(40 + 2);',
    ].join('\n');

    fs.writeFileSync(
      path.join(context, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
        },
      }),
    );
    fs.writeFileSync(entryPath, entrySource);
    fs.writeFileSync(dependencyPath, dependencySource);

    const snapshot = vi.spyOn(
      runtimeMacroTransformer,
      'createMacroProjectSnapshot',
    );
    const batch = vi.spyOn(runtimeMacroTransformer, 'transformProject');
    try {
      const compilation = {};
      const [entry, dependency] = await Promise.all([
        runMacroTransformLoader({
          resourcePath: entryPath,
          source: entrySource,
          compilation,
          transformOptions: { sourceMap: true },
        }),
        runMacroTransformLoader({
          resourcePath: dependencyPath,
          source: dependencySource,
          compilation,
          transformOptions: { sourceMap: true },
        }),
      ]);
      const entryProject = entry.meta[CONF_TS_MACRO_TRANSFORM_META].project;
      const dependencyProject =
        dependency.meta[CONF_TS_MACRO_TRANSFORM_META].project;

      expect(dependencyProject).toBe(entryProject);
      expect(dependency.code).toBe(entryProject.files[dependencyPath]);
      expect(dependency.code).not.toContain("from '@conf-ts/macro'");
      expect(dependency.code).toContain('"42"');
      expect(dependency.map.version).toBe(3);
      expect(entry.dependencies).toEqual([]);
      expect(
        entry.meta[CONF_TS_MACRO_TRANSFORM_META].transformDependenciesByFile[
          dependencyPath
        ],
      ).toContain(dependencyPath);

      const overridden = await runMacroTransformLoader({
        resourcePath: dependencyPath,
        source: dependencySource.replace('40 + 2', '40 + 4'),
        compilation,
        transformOptions: { sourceMap: true },
      });
      expect(overridden.meta[CONF_TS_MACRO_TRANSFORM_META].project).not.toBe(
        entryProject,
      );
      expect(overridden.code).toContain('"44"');

      fs.writeFileSync(
        dependencyPath,
        dependencySource.replace('40 + 2', '40 + 3'),
      );
      const nextCompilation = await runMacroTransformLoader({
        resourcePath: entryPath,
        source: entrySource,
        compilation: {},
        transformOptions: { sourceMap: true },
      });
      const nextProject =
        nextCompilation.meta[CONF_TS_MACRO_TRANSFORM_META].project;

      expect(nextProject).not.toBe(entryProject);
      expect(nextProject.files[dependencyPath]).toContain('"43"');
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(batch).toHaveBeenCalledTimes(3);
    } finally {
      snapshot.mockRestore();
      batch.mockRestore();
      fs.rmSync(context, { force: true, recursive: true });
    }
  });

  it('batches sibling entry files by their nearest tsconfig', async () => {
    const context = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-ts-siblings-'));
    const leftRoot = path.join(context, 'left');
    const rightRoot = path.join(context, 'right');
    fs.mkdirSync(leftRoot);
    fs.mkdirSync(rightRoot);
    const left = path.join(leftRoot, 'left.conf.ts');
    const right = path.join(rightRoot, 'right.conf.ts');
    const leftSource =
      "import { String } from '@conf-ts/macro'; export default String(1);";
    const rightSource =
      "import { String } from '@conf-ts/macro'; export default String(2);";
    for (const root of [leftRoot, rightRoot]) {
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'esnext', moduleResolution: 'bundler' },
        }),
      );
    }
    fs.writeFileSync(left, leftSource);
    fs.writeFileSync(right, rightSource);

    const snapshot = vi.spyOn(
      runtimeMacroTransformer,
      'createMacroProjectSnapshot',
    );
    try {
      const compilation = {};
      const [leftResult, rightResult] = await Promise.all([
        runMacroTransformLoader({
          resourcePath: left,
          source: leftSource,
          compilation,
        }),
        runMacroTransformLoader({
          resourcePath: right,
          source: rightSource,
          compilation,
        }),
      ]);
      expect(leftResult.code).toContain('"1"');
      expect(rightResult.code).toContain('"2"');
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(snapshot.mock.calls.map(([entries]) => entries)).toEqual(
        expect.arrayContaining([[left], [right]]),
      );
    } finally {
      snapshot.mockRestore();
      fs.rmSync(context, { force: true, recursive: true });
    }
  });

  it('isolates a failed snapshot group from valid sibling groups', async () => {
    const context = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-ts-failure-'));
    const validRoot = path.join(context, 'valid');
    const invalidRoot = path.join(context, 'invalid');
    fs.mkdirSync(validRoot);
    fs.mkdirSync(invalidRoot);
    fs.writeFileSync(
      path.join(validRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'esnext' } }),
    );
    const source =
      "import { String } from '@conf-ts/macro'; export default String(42);";
    const valid = path.join(validRoot, 'valid.conf.ts');
    const invalid = path.join(invalidRoot, 'invalid.conf.ts');
    fs.writeFileSync(valid, source);
    fs.writeFileSync(invalid, source);

    try {
      const compilation = {};
      const [validResult, invalidResult] = await Promise.allSettled([
        runMacroTransformLoader({
          resourcePath: valid,
          source,
          compilation,
        }),
        runMacroTransformLoader({
          resourcePath: invalid,
          source,
          compilation,
        }),
      ]);
      expect(validResult.status).toBe('fulfilled');
      if (validResult.status === 'fulfilled') {
        expect(validResult.value.code).toContain('"42"');
      }
      expect(invalidResult.status).toBe('rejected');
      if (invalidResult.status === 'rejected') {
        expect(invalidResult.reason).toMatchObject({
          message: 'Could not find a tsconfig.json file.',
        });
      }
      fs.writeFileSync(
        path.join(invalidRoot, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'esnext' } }),
      );
      const retried = await runMacroTransformLoader({
        resourcePath: invalid,
        source,
        compilation,
      });
      expect(retried.code).toContain('"42"');
    } finally {
      fs.rmSync(context, { force: true, recursive: true });
    }
  });

  it('registers a shared project graph once per compilation', async () => {
    const context = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-ts-deps-'));
    const first = path.join(context, 'first.conf.ts');
    const second = path.join(context, 'second.conf.ts');
    const firstSource =
      "import { String } from '@conf-ts/macro'; export default String(1);";
    const secondSource =
      "import { String } from '@conf-ts/macro'; export default String(2);";
    fs.writeFileSync(
      path.join(context, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'esnext' } }),
    );
    fs.writeFileSync(first, firstSource);
    fs.writeFileSync(second, secondSource);
    const added: string[] = [];
    const compilation = {
      fileDependencies: { add: (dependency: string) => added.push(dependency) },
      missingDependencies: { add: vi.fn() },
    };

    try {
      await Promise.all([
        runMacroTransformLoader({
          resourcePath: first,
          source: firstSource,
          compilation,
        }),
        runMacroTransformLoader({
          resourcePath: second,
          source: secondSource,
          compilation,
        }),
      ]);
      expect(added).toContain(first);
      expect(added).toContain(second);
      expect(added).toContain(path.join(context, 'tsconfig.json'));
      expect(added).toHaveLength(new Set(added).size);
    } finally {
      fs.rmSync(context, { force: true, recursive: true });
    }
  });

  it.each(['typescript', 'native'] as const)(
    'batches a dynamic context into one %s project snapshot',
    async implementation => {
      const builtPlugin = require('../dist/cjs/index.js') as {
        NativeMacroTransformPlugin: typeof NativeMacroTransformPlugin;
        TypeScriptMacroTransformPlugin: typeof TypeScriptMacroTransformPlugin;
      };
      const context = fs.mkdtempSync(
        path.join(os.tmpdir(), `conf-ts-context-${implementation}-`),
      );
      const configs = path.join(context, 'configs');
      const output = path.join(context, 'dist');
      fs.mkdirSync(configs);
      fs.writeFileSync(
        path.join(context, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            allowJs: true,
            module: 'esnext',
            moduleResolution: 'bundler',
          },
        }),
      );
      const sharedExports: string[] = [];
      for (let index = 0; index < 40; index++) {
        fs.writeFileSync(
          path.join(context, `value-${index}.js`),
          `export const value${index} = ${index};`,
        );
        sharedExports.push(
          `export { value${index} } from './value-${index}.js';`,
        );
      }
      fs.writeFileSync(
        path.join(context, 'shared.js'),
        sharedExports.join('\n'),
      );
      for (let index = 0; index < 120; index++) {
        fs.writeFileSync(
          path.join(configs, `config-${index}.conf.js`),
          [
            "import { String } from '@conf-ts/macro';",
            "import { value0 } from '../shared.js';",
            `export default String(value0 + ${index});`,
          ].join('\n'),
        );
      }
      fs.writeFileSync(
        path.join(context, 'index.js'),
        'export const load = name => import(`./configs/${name}.conf.js`);',
      );

      const snapshot = vi.spyOn(
        runtimeMacroTransformer,
        'createMacroProjectSnapshot',
      );
      const transformer =
        implementation === 'native'
          ? runtimeNativeMacroTransformer
          : runtimeMacroTransformer;
      const transform = vi.spyOn(transformer, 'transformProject');
      const Plugin =
        implementation === 'native'
          ? builtPlugin.NativeMacroTransformPlugin
          : builtPlugin.TypeScriptMacroTransformPlugin;
      const compiler = webpack({
        context,
        mode: 'production',
        devtool: false,
        cache: false,
        parallelism: 256,
        entry: './index.js',
        optimization: { minimize: false },
        output: { path: output, filename: 'bundle.js' },
        plugins: [new Plugin({ test: /\.conf\.js$/ })],
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
        const bundled = fs
          .readdirSync(output)
          .filter(filename => filename.endsWith('.js'))
          .map(filename => fs.readFileSync(path.join(output, filename), 'utf8'))
          .join('\n');
        expect(bundled).not.toContain('@conf-ts/macro');
        expect(bundled).toContain('"119"');
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(snapshot.mock.calls[0][0]).toHaveLength(120);
        expect(transform).toHaveBeenCalledTimes(1);
      } finally {
        await new Promise<void>(resolve => compiler.close(() => resolve()));
        snapshot.mockRestore();
        transform.mockRestore();
        fs.rmSync(context, { force: true, recursive: true });
      }
    },
    20_000,
  );

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

  it('keeps compiler-level graph caches correct across rebuilds', async () => {
    const builtPlugin = require('../dist/cjs/index.js') as {
      ConfTsWebpackPlugin: typeof ConfTsWebpackPlugin;
      TypeScriptMacroTransformPlugin: typeof TypeScriptMacroTransformPlugin;
    };
    const context = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-ts-rebuild-'));
    const entry = path.join(context, 'config.conf.ts');
    const values = path.join(context, 'values.ts');
    fs.writeFileSync(
      path.join(context, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
        },
      }),
    );
    fs.writeFileSync(
      entry,
      "import { answer } from './values'; export default { answer };",
    );
    fs.writeFileSync(
      values,
      "import { String } from '@conf-ts/macro'; export const answer = String(42);",
    );
    const compiler = webpack({
      context,
      mode: 'production',
      devtool: false,
      entry: './config.conf.ts',
      resolve: { extensions: ['.ts', '.js'] },
      output: { path: path.join(context, 'dist'), filename: 'bundle.js' },
      plugins: [
        new builtPlugin.TypeScriptMacroTransformPlugin(),
        new builtPlugin.ConfTsWebpackPlugin({
          compiler: 'js',
          useWorkers: false,
        }),
      ],
    });
    const run = () =>
      new Promise<webpack.Stats>((resolve, reject) => {
        compiler.run((error, stats) => {
          if (error) reject(error);
          else if (!stats) reject(new Error('Webpack returned no stats'));
          else if (stats.hasErrors()) {
            reject(new Error(stats.toString({ all: false, errors: true })));
          } else resolve(stats);
        });
      });

    try {
      await run();
      const generated = path.join(context, 'config.generated.json');
      expect(JSON.parse(fs.readFileSync(generated, 'utf8'))).toEqual({
        answer: '42',
      });

      fs.writeFileSync(
        values,
        "import { String } from '@conf-ts/macro'; export const answer = String(43);",
      );
      await run();
      expect(JSON.parse(fs.readFileSync(generated, 'utf8'))).toEqual({
        answer: '43',
      });

      const unchangedMtime = fs.statSync(generated).mtimeMs;
      await run();
      expect(fs.statSync(generated).mtimeMs).toBe(unchangedMtime);
    } finally {
      await new Promise<void>(resolve => compiler.close(() => resolve()));
      fs.rmSync(context, { force: true, recursive: true });
    }
  });

  it('keeps a batched context correct across content and structural rebuilds', async () => {
    const builtPlugin = require('../dist/cjs/index.js') as {
      TypeScriptMacroTransformPlugin: typeof TypeScriptMacroTransformPlugin;
    };
    const context = fs.mkdtempSync(
      path.join(os.tmpdir(), 'conf-ts-context-rebuild-'),
    );
    const configs = path.join(context, 'configs');
    const output = path.join(context, 'dist');
    const shared = path.join(context, 'shared.ts');
    const added = path.join(context, 'added.ts');
    fs.mkdirSync(configs);
    fs.writeFileSync(
      path.join(context, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
        },
      }),
    );
    fs.writeFileSync(shared, 'export const shared = 1;');
    const configPaths = Array.from({ length: 3 }, (_, index) => {
      const filename = path.join(configs, `config-${index}.conf.ts`);
      fs.writeFileSync(
        filename,
        [
          "import { String } from '@conf-ts/macro';",
          "import { shared } from '../shared';",
          `export default String(shared + ${index});`,
        ].join('\n'),
      );
      return filename;
    });
    fs.writeFileSync(
      path.join(context, 'index.ts'),
      'export const load = name => import(`./configs/${name}.conf.ts`);',
    );

    const snapshot = vi.spyOn(
      runtimeMacroTransformer,
      'createMacroProjectSnapshot',
    );
    const transform = vi.spyOn(runtimeMacroTransformer, 'transformProject');
    const compiler = webpack({
      context,
      mode: 'production',
      devtool: false,
      cache: false,
      parallelism: 32,
      entry: './index.ts',
      optimization: { minimize: false },
      resolve: { extensions: ['.ts', '.js'] },
      output: { path: output, filename: 'bundle.js' },
      plugins: [
        new builtPlugin.TypeScriptMacroTransformPlugin({
          test: /\.conf\.ts$/,
        }),
      ],
    });
    const run = () =>
      new Promise<webpack.Stats>((resolve, reject) => {
        compiler.run((error, stats) => {
          if (error) reject(error);
          else if (!stats) reject(new Error('Webpack returned no stats'));
          else if (stats.hasErrors()) {
            reject(new Error(stats.toString({ all: false, errors: true })));
          } else resolve(stats);
        });
      });
    const bundled = () =>
      fs
        .readdirSync(output)
        .filter(filename => filename.endsWith('.js'))
        .map(filename => fs.readFileSync(path.join(output, filename), 'utf8'))
        .join('\n');

    try {
      await run();
      const initialProjects = snapshot.mock.calls.length;
      expect(initialProjects).toBeGreaterThan(0);
      expect(initialProjects).toBeLessThanOrEqual(3);
      expect(transform).toHaveBeenCalledTimes(initialProjects);

      fs.writeFileSync(shared, 'export const shared = 2;');
      await run();
      expect(bundled()).toContain('"2"');
      expect(bundled()).toContain('"3"');
      expect(bundled()).toContain('"4"');
      expect(snapshot).toHaveBeenCalledTimes(initialProjects * 2);
      expect(transform).toHaveBeenCalledTimes(initialProjects * 2);

      fs.writeFileSync(added, 'export const added = 40;');
      fs.writeFileSync(
        configPaths[0],
        [
          "import { String } from '@conf-ts/macro';",
          "import { added } from '../added';",
          'export default String(added + 2);',
        ].join('\n'),
      );
      await run();
      expect(bundled()).toContain('"42"');
      expect(snapshot).toHaveBeenCalledTimes(initialProjects * 2 + 1);
      expect(transform).toHaveBeenCalledTimes(initialProjects * 2 + 1);

      fs.writeFileSync(
        configPaths[0],
        [
          "import { String } from '@conf-ts/macro';",
          "import { shared } from '../shared';",
          'export default String(shared);',
        ].join('\n'),
      );
      fs.rmSync(added);
      await run();
      expect(bundled()).not.toContain('"42"');
      expect(snapshot).toHaveBeenCalledTimes(initialProjects * 2 + 2);
      expect(transform).toHaveBeenCalledTimes(initialProjects * 2 + 2);

      await run();
      expect(snapshot).toHaveBeenCalledTimes(initialProjects * 2 + 2);
      expect(transform).toHaveBeenCalledTimes(initialProjects * 2 + 2);
    } finally {
      await new Promise<void>(resolve => compiler.close(() => resolve()));
      snapshot.mockRestore();
      transform.mockRestore();
      fs.rmSync(context, { force: true, recursive: true });
    }
  });
});
