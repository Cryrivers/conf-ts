import path from 'path';
import { type CompileOptions } from '@conf-ts/compiler';
import Piscina from 'piscina';
import type { Compiler, RuleSetCondition, RuleSetRule } from 'webpack';

import { piscinaByCompiler } from './loader';
import type { CompilerPreference } from './worker';

export interface ConfTsWebpackPluginOptions {
  test?: RuleSetCondition;
  include?: RuleSetCondition;
  exclude?: RuleSetCondition;
  format?: 'json' | 'yaml';
  name?: string;
  extensionToRemove?: string | string[];
  macro?: boolean;
  preserveKeyOrder?: boolean;
  jsx?: CompileOptions['jsx'];
  jsxOutput?: CompileOptions['jsxOutput'];
  check?: boolean;
  useWorkers?: boolean;
  compiler?: CompilerPreference;
}

const VALID_FORMATS = new Set(['json', 'yaml']);
const VALID_COMPILERS = new Set(['auto', 'native', 'js']);

function validateOptions(options: ConfTsWebpackPluginOptions): void {
  const reject = (msg: string): never => {
    throw new Error(`ConfTsWebpackPlugin: ${msg}`);
  };
  const expectBool = (key: keyof ConfTsWebpackPluginOptions) => {
    const v = options[key];
    if (v !== undefined && typeof v !== 'boolean') {
      reject(`${String(key)} must be a boolean, got ${typeof v}`);
    }
  };

  if (options.format !== undefined && !VALID_FORMATS.has(options.format)) {
    reject(
      `format must be 'json' or 'yaml', got ${JSON.stringify(options.format)}`,
    );
  }
  if (
    options.compiler !== undefined &&
    !VALID_COMPILERS.has(options.compiler)
  ) {
    reject(
      `compiler must be 'auto', 'native', or 'js', got ${JSON.stringify(options.compiler)}`,
    );
  }
  if (options.name !== undefined && typeof options.name !== 'string') {
    reject(`name must be a string, got ${typeof options.name}`);
  }
  if (
    options.extensionToRemove !== undefined &&
    typeof options.extensionToRemove !== 'string' &&
    !Array.isArray(options.extensionToRemove)
  ) {
    reject(
      `extensionToRemove must be a string or an array of strings, got ${typeof options.extensionToRemove}`,
    );
  }
  if (
    Array.isArray(options.extensionToRemove) &&
    options.extensionToRemove.some(value => typeof value !== 'string')
  ) {
    reject('extensionToRemove must be a string or an array of strings');
  }
  if (
    options.jsxOutput !== undefined &&
    (typeof options.jsxOutput !== 'object' ||
      options.jsxOutput === null ||
      Array.isArray(options.jsxOutput))
  ) {
    reject('jsxOutput must be a plain object');
  }
  expectBool('macro');
  expectBool('preserveKeyOrder');
  expectBool('jsx');
  expectBool('check');
  expectBool('useWorkers');
}

export function shouldInjectJsxOutput(jsx: CompileOptions['jsx']): boolean {
  return jsx === true;
}

export class ConfTsWebpackPlugin {
  private readonly options: ConfTsWebpackPluginOptions;

  constructor(options: ConfTsWebpackPluginOptions = {}) {
    validateOptions(options);
    this.options = options;
  }

  apply(compiler: Compiler) {
    const {
      test = /\.conf\.ts$/,
      include,
      exclude,
      format,
      name,
      extensionToRemove = '.conf.ts',
      macro,
      preserveKeyOrder,
      jsx,
      jsxOutput,
      check,
      useWorkers = true,
      compiler: compilerPref = 'auto',
    } = this.options;

    if (useWorkers) {
      const pool = new Piscina({
        filename: path.join(__dirname, 'worker.js'),
      });
      piscinaByCompiler.set(compiler, pool);
      compiler.hooks.shutdown.tapPromise('ConfTsWebpackPlugin', async () => {
        piscinaByCompiler.delete(compiler);
        await pool.destroy();
      });
    }

    const rule: RuleSetRule = {
      test,
      ...(include !== undefined ? { include } : {}),
      ...(exclude !== undefined ? { exclude } : {}),
      use: [
        {
          loader: require.resolve('./loader'),
          options: {
            format,
            name,
            extensionToRemove,
            macro,
            preserveKeyOrder,
            jsx,
            jsxOutput,
            check,
            useWorkers,
            compiler: compilerPref,
          },
        },
      ],
    };

    compiler.options.module.rules.push(rule);

    if (shouldInjectJsxOutput(jsx)) {
      new compiler.webpack.BannerPlugin({
        banner: `globalThis.__CONF_TS_JSX_OUTPUT__ = ${JSON.stringify(
          jsxOutput ?? {},
        )};`,
        raw: true,
        entryOnly: true,
      }).apply(compiler);
    }
  }
}
