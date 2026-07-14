import {
  type CompileOptions,
  type SourceCompileInput,
} from '@conf-ts/compiler';

export type CompilerPreference = 'auto' | 'native' | 'js';

export interface WorkerInput extends SourceCompileInput {
  format: 'json' | 'yaml';
  options: CompileOptions;
  compiler: CompilerPreference;
}

type CompileFn = (
  input: SourceCompileInput,
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

export default function (message: WorkerInput) {
  const { filename, code, project, format, options, compiler } = message;
  return resolveCompile(compiler).fn(
    { filename, code, project },
    format,
    options,
  );
}
