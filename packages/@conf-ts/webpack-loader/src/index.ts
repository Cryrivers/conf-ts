import { promises as fs } from 'fs';
import path from 'path';
import { type compile, type CompileOptions } from '@conf-ts/compiler';
import Piscina from 'piscina';
import type { Compiler, LoaderContext } from 'webpack';

interface LoaderOptions extends CompileOptions {
  name?: string;
  format?: 'json' | 'yaml';
  extensionToRemove?: string;
  macro?: boolean;
  check?: boolean;
}

export interface ConfTsJsxOutputPluginOptions {
  jsxOutput?: CompileOptions['jsxOutput'];
}

export class ConfTsJsxOutputPlugin {
  private readonly jsxOutput: CompileOptions['jsxOutput'];

  constructor(options: ConfTsJsxOutputPluginOptions = {}) {
    this.jsxOutput = options.jsxOutput;
  }

  apply(compiler: Compiler) {
    const banner = `globalThis.__CONF_TS_JSX_OUTPUT__ = ${JSON.stringify(
      this.jsxOutput ?? {},
    )};`;

    new compiler.webpack.BannerPlugin({
      banner,
      raw: true,
      entryOnly: true,
    }).apply(compiler);
  }
}

let piscina: Piscina | null = null;

function getPiscina(): Piscina {
  if (!piscina) {
    piscina = new Piscina({
      filename: path.join(__dirname, 'worker.js'),
    });
  }
  return piscina;
}

async function runCompile(
  resourcePath: string,
  format: 'json' | 'yaml',
  options: LoaderOptions,
): Promise<ReturnType<typeof compile>> {
  return getPiscina().run({
    resourcePath,
    format,
    options,
  });
}

export default async function (
  this: LoaderContext<LoaderOptions>,
  source: string,
) {
  this.cacheable();

  const callback = this.async();
  const options = this.getOptions();
  const format = options.format || 'json';
  const extToRemove = options.extensionToRemove || '';

  try {
    const compileOptions = {
      macroMode: options.macro || false,
      preserveKeyOrder: options.preserveKeyOrder || false,
      jsxOutput: options.jsxOutput,
    };
    const { output, dependencies } = await runCompile(
      this.resourcePath,
      format,
      compileOptions,
    );

    dependencies.forEach((dep: string) => this.addDependency(dep));

    const baseName = path.basename(this.resourcePath, extToRemove);
    const fileName = path.join(
      path.dirname(this.resourcePath),
      options.name || `${baseName}.generated.${format}`,
    );

    if (options.check) {
      try {
        const existing = await fs.readFile(fileName, 'utf8');
        if (existing !== output) {
          throw new Error(`Generated output mismatch: ${fileName}`);
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error(`Generated file not found: ${fileName}`);
        }
        throw err;
      }
    } else {
      await fs.writeFile(fileName, output);
    }
    callback(null, source);
  } catch (error) {
    callback(error as Error, source);
  }
}
