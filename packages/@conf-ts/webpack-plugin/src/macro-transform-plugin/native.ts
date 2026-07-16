import type { Compiler } from 'webpack';

import {
  applyMacroTransformPlugin,
  type MacroTransformPluginOptions,
} from './shared';

export type { MacroTransformPluginOptions } from './shared';

export class NativeMacroTransformPlugin {
  constructor(private readonly options: MacroTransformPluginOptions = {}) {}

  apply(compiler: Compiler): void {
    applyMacroTransformPlugin(compiler, 'native', this.options);
  }
}
