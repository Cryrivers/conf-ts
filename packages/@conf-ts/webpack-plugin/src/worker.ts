import { type CompileOptions } from '@conf-ts/compiler';

export type CompilerPreference = 'auto' | 'native' | 'js';

interface WorkerInput {
  resourcePath: string;
  format: 'json' | 'yaml';
  options: CompileOptions;
  compiler: CompilerPreference;
}

type CompileFn = (
  inputFile: string,
  format: 'json' | 'yaml',
  options?: CompileOptions,
) => { output: string; dependencies: string[] };

let cachedCompile: { fn: CompileFn; kind: 'native' | 'js' } | undefined;

export function resolveCompile(prefer: CompilerPreference): {
  fn: CompileFn;
  kind: 'native' | 'js';
} {
  if (cachedCompile && (prefer === 'auto' || cachedCompile.kind === prefer)) {
    return cachedCompile;
  }
  if (prefer !== 'js') {
    try {
      const native = require('@conf-ts/compiler-native');
      cachedCompile = { fn: native.compile as CompileFn, kind: 'native' };
      return cachedCompile;
    } catch (err) {
      if (prefer === 'native') throw err;
    }
  }
  const js = require('@conf-ts/compiler');
  cachedCompile = { fn: js.compile as CompileFn, kind: 'js' };
  return cachedCompile;
}

let cachedTransform: { fn: CompileFn; kind: 'native' | 'js' } | undefined;

/**
 * @conf-ts/compiler / @conf-ts/compiler-native no longer evaluate macros
 * themselves — when macro mode is requested, the corresponding transformer
 * package's own transform+compile convenience wrapper is used instead,
 * following the same auto/native/js preference resolution as
 * `resolveCompile`.
 */
export function resolveTransform(prefer: CompilerPreference): {
  fn: CompileFn;
  kind: 'native' | 'js';
} {
  if (
    cachedTransform &&
    (prefer === 'auto' || cachedTransform.kind === prefer)
  ) {
    return cachedTransform;
  }
  if (prefer !== 'js') {
    try {
      const native = require('@conf-ts/macro-transformer-native');
      cachedTransform = { fn: native.compile as CompileFn, kind: 'native' };
      return cachedTransform;
    } catch (err) {
      if (prefer === 'native') throw err;
    }
  }
  const js = require('@conf-ts/macro-transformer');
  cachedTransform = { fn: js.compile as CompileFn, kind: 'js' };
  return cachedTransform;
}

export default function (message: WorkerInput) {
  const { resourcePath, format, options, compiler } = message;
  if (options.macroMode) {
    return resolveTransform(compiler).fn(resourcePath, format, options);
  }
  return resolveCompile(compiler).fn(resourcePath, format, options);
}
