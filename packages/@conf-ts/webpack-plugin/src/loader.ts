import { promises as fs } from 'fs';
import path from 'path';
import { type CompileOptions } from '@conf-ts/compiler';
import type Piscina from 'piscina';
import type { Compiler, LoaderContext } from 'webpack';

import { resolveCompile, type CompilerPreference } from './worker';

export interface LoaderOptions extends CompileOptions {
  name?: string;
  format?: 'json' | 'yaml';
  extensionToRemove?: string;
  macro?: boolean;
  check?: boolean;
  useWorkers?: boolean;
  compiler?: CompilerPreference;
}

export const piscinaByCompiler = new WeakMap<Compiler, Piscina>();

interface CompileResult {
  output: string;
  dependencies: string[];
}

function interpolate(
  template: string,
  resourcePath: string,
  rootDir: string,
  extToRemove: string,
): string {
  const baseName = path.basename(resourcePath, extToRemove);
  const ext = path.extname(resourcePath).replace(/^\./, '');
  const relDir = path.relative(rootDir, path.dirname(resourcePath));

  return template
    .replace(/\[name\]/g, baseName)
    .replace(/\[ext\]/g, ext)
    .replace(/\[path\]/g, relDir ? relDir + path.sep : '');
}

function toWebpackError(err: unknown): Error {
  if (
    err &&
    typeof err === 'object' &&
    'file' in err &&
    'line' in err &&
    'character' in err
  ) {
    const e = err as {
      message: string;
      file: string;
      line: number;
      character: number;
    };
    const wrapped = new Error(e.message);
    (wrapped as Error & { file?: string; loc?: unknown }).file = e.file;
    (wrapped as Error & { loc?: unknown }).loc = {
      start: { line: e.line, column: e.character },
    };
    return wrapped;
  }
  return err instanceof Error ? err : new Error(String(err));
}

export default async function (
  this: LoaderContext<LoaderOptions>,
  source: string,
) {
  this.cacheable();

  const callback = this.async();
  const options = this.getOptions();
  const format = options.format ?? 'json';
  const extToRemove = options.extensionToRemove ?? '';
  const useWorkers = options.useWorkers !== false;
  const compilerPref: CompilerPreference = options.compiler ?? 'auto';

  try {
    const compileOptions: CompileOptions = {
      macroMode: options.macro || false,
      preserveKeyOrder: options.preserveKeyOrder || false,
      jsxOutput: options.jsxOutput,
    };

    let result: CompileResult;
    if (useWorkers) {
      const piscina = this._compiler
        ? piscinaByCompiler.get(this._compiler)
        : undefined;
      if (!piscina) {
        throw new Error(
          'ConfTsWebpackPlugin: worker pool not initialised. Was the plugin added to webpack.config?',
        );
      }
      result = (await piscina.run({
        resourcePath: this.resourcePath,
        format,
        options: compileOptions,
        compiler: compilerPref,
      })) as CompileResult;
    } else {
      result = resolveCompile(compilerPref).fn(
        this.resourcePath,
        format,
        compileOptions,
      );
    }

    for (const dep of result.dependencies) {
      this.addDependency(dep);
    }

    const template = options.name ?? `[name].generated.${format}`;

    if (options.check) {
      const sidecarName = interpolate(
        template,
        this.resourcePath,
        path.dirname(this.resourcePath),
        extToRemove,
      );
      const checkPath = path.join(path.dirname(this.resourcePath), sidecarName);
      try {
        const existing = await fs.readFile(checkPath, 'utf8');
        if (existing !== result.output) {
          throw new Error(`Generated output mismatch: ${checkPath}`);
        }
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          (err as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          throw new Error(`Generated file not found: ${checkPath}`);
        }
        throw err;
      }
    } else {
      const emittedName = interpolate(
        template,
        this.resourcePath,
        this.rootContext,
        extToRemove,
      );
      this.emitFile(emittedName, result.output);
    }

    callback(null, source);
  } catch (error) {
    callback(toWebpackError(error));
  }
}
