import type { MacroTransformOptions } from '@conf-ts/macro-transformer';
import type { Compiler, RuleSetCondition, RuleSetRule } from 'webpack';

import type { MacroTransformImplementation } from './types';

export interface MacroTransformPluginOptions extends MacroTransformOptions {
  test?: RuleSetCondition;
  include?: RuleSetCondition;
  exclude?: RuleSetCondition;
}

function resolveLoader(): string {
  try {
    return require.resolve('./loader');
  } catch {
    // Test runners execute this TypeScript source directly, while published
    // consumers resolve the emitted loader.js above.
    return require.resolve('./loader.ts');
  }
}

export function applyMacroTransformPlugin(
  compiler: Compiler,
  implementation: MacroTransformImplementation,
  options: MacroTransformPluginOptions,
): void {
  const {
    test = /\.[cm]?[jt]sx?$/,
    include,
    exclude = /node_modules/,
    ...transformOptions
  } = options;

  const rule: RuleSetRule = {
    enforce: 'pre',
    test,
    ...(include !== undefined ? { include } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
    use: [
      {
        loader: resolveLoader(),
        options: {
          implementation,
          transformOptions,
        },
      },
    ],
  };

  compiler.options.module.rules.push(rule);
}
