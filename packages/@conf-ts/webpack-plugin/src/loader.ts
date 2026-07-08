import { promises as fs } from 'fs';
import path from 'path';
import { type CompileOptions } from '@conf-ts/compiler';
import type Piscina from 'piscina';
import type { Compiler, LoaderContext } from 'webpack';

import { resolveCompile, type CompilerPreference } from './worker';

export interface LoaderOptions extends CompileOptions {
  name?: string;
  format?: 'json' | 'yaml';
  extensionToRemove?: string | string[];
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

export function createCompileOptions(options: LoaderOptions): CompileOptions {
  return {
    macroMode: options.macro || false,
    preserveKeyOrder: options.preserveKeyOrder || false,
    quote: options.quote,
    jsx: options.jsx,
    jsxOutput: options.jsxOutput,
  };
}

export function normalizeExtensionToRemove(
  extensionToRemove: string | string[],
): string[] {
  return Array.isArray(extensionToRemove)
    ? extensionToRemove
    : [extensionToRemove];
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function stripMatchingExtension(
  resourcePath: string,
  extensionsToRemove: string[],
): string {
  const matchedExtension = extensionsToRemove
    .filter(extension => extension && resourcePath.endsWith(extension))
    .sort((a, b) => b.length - a.length)[0];

  if (!matchedExtension) {
    return path.basename(resourcePath);
  }

  return path.basename(resourcePath.slice(0, -matchedExtension.length));
}

export function interpolate(
  template: string,
  resourcePath: string,
  rootDir: string,
  extensionsToRemove: string[],
): string {
  const baseName = stripMatchingExtension(resourcePath, extensionsToRemove);
  const ext = path.extname(resourcePath).replace(/^\./, '');
  const relDir = toPosixPath(
    path.relative(rootDir, path.dirname(resourcePath)),
  );

  return template
    .replace(/\[name\]/g, baseName)
    .replace(/\[ext\]/g, ext)
    .replace(/\[path\]/g, relDir ? relDir + path.posix.sep : '');
}

export function resolveGeneratedPath(
  template: string,
  resourcePath: string,
  rootDir: string,
  extensionsToRemove: string[],
): string {
  return path.join(
    rootDir,
    interpolate(template, resourcePath, rootDir, extensionsToRemove),
  );
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
  const extensionsToRemove = normalizeExtensionToRemove(
    options.extensionToRemove ?? '.conf.ts',
  );
  const useWorkers = options.useWorkers !== false;
  const compilerPref: CompilerPreference = options.compiler ?? 'auto';

  try {
    const compileOptions = createCompileOptions(options);

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

    const template = options.name ?? `[path][name].generated.${format}`;
    const generatedPath = resolveGeneratedPath(
      template,
      this.resourcePath,
      this.rootContext,
      extensionsToRemove,
    );

    if (options.check) {
      try {
        const existing = await fs.readFile(generatedPath, 'utf8');
        if (existing !== result.output) {
          throw new Error(`Generated output mismatch: ${generatedPath}`);
        }
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          (err as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          throw new Error(`Generated file not found: ${generatedPath}`);
        }
        throw err;
      }
    } else {
      await fs.mkdir(path.dirname(generatedPath), { recursive: true });
      await fs.writeFile(generatedPath, result.output);
    }

    callback(null, source);
  } catch (error) {
    callback(toWebpackError(error));
  }
}
