import path from 'path';
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
  preserveKeyOrder?: boolean;
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
  const legacyOptions = options as ConfTsWebpackPluginOptions & {
    macro?: unknown;
    quote?: unknown;
  };
  if (Object.prototype.hasOwnProperty.call(legacyOptions, 'macro')) {
    reject(
      'the macro option was removed; add TypeScriptMacroTransformPlugin or NativeMacroTransformPlugin instead',
    );
  }
  if (Object.prototype.hasOwnProperty.call(legacyOptions, 'quote')) {
    reject(
      'the quote option belongs to macro transformation; pass it to a MacroTransformPlugin instead',
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
  expectBool('preserveKeyOrder');
  expectBool('check');
  expectBool('useWorkers');
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
      preserveKeyOrder,
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
            preserveKeyOrder,
            check,
            useWorkers,
            compiler: compilerPref,
            confTsConfigLoader: true,
          },
        },
      ],
    };

    compiler.options.module.rules.push(rule);
  }
}

export {
  TypeScriptMacroTransformPlugin,
  type MacroTransformPluginOptions,
} from './macro-transform-plugin/typescript';
export { NativeMacroTransformPlugin } from './macro-transform-plugin/native';
