import { createHash } from 'crypto';
import type {
  MacroProjectSnapshot,
  MacroTransformInput,
  MacroTransformOptions,
  MacroTransformResult,
  RawSourceMap,
} from '@conf-ts/macro-transformer';
import type { LoaderContext } from 'webpack';

import {
  CONF_TS_MACRO_TRANSFORM_META,
  type MacroTransformImplementation,
  type MacroTransformLoaderMeta,
} from './types';

interface MacroTransformLoaderOptions {
  implementation: MacroTransformImplementation;
  transformOptions?: MacroTransformOptions;
}

type TransformFn = (
  input: MacroTransformInput,
  options?: MacroTransformOptions,
) => MacroTransformResult;

interface Transformer {
  createMacroProjectSnapshot(entryFiles: string[]): MacroProjectSnapshot;
  transform: TransformFn;
}

interface PreparedTransform {
  code: string;
  map: RawSourceMap | null;
  project: MacroProjectSnapshot;
  dependencies: string[];
}

const transformsByCompilation = new WeakMap<
  object,
  Map<string, Promise<PreparedTransform>>
>();

function loadTransformer(
  implementation: MacroTransformImplementation,
): Transformer {
  const typescript = require('@conf-ts/macro-transformer') as Transformer;
  if (implementation === 'typescript') {
    return typescript;
  }

  // Intentionally no fallback: choosing the native plugin is an explicit
  // request for the native Oxc-backed transformer.
  const native = require('@conf-ts/macro-transformer-native') as Pick<
    Transformer,
    'transform'
  >;
  return {
    createMacroProjectSnapshot: typescript.createMacroProjectSnapshot,
    transform: native.transform,
  };
}

function normalizeEnvironment(
  explicit: Record<string, string> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return { ...environment, ...explicit };
}

async function prepareTransform(
  resourcePath: string,
  source: string,
  implementation: MacroTransformImplementation,
  options: MacroTransformOptions,
): Promise<PreparedTransform> {
  const transformer = loadTransformer(implementation);
  const baseProject = transformer.createMacroProjectSnapshot([resourcePath]);
  const sourceProject: MacroProjectSnapshot = {
    ...baseProject,
    files: {
      ...baseProject.files,
      [resourcePath]: source,
    },
  };
  const transformOptions: MacroTransformOptions = {
    ...options,
    env: normalizeEnvironment(options.env),
    sourceMap: options.sourceMap !== false,
  };

  let transformedProject = sourceProject;
  const dependencies = new Set(baseProject.dependencies);
  let entryResult: MacroTransformResult | undefined;

  const files = Object.entries(sourceProject.files).sort(
    ([left], [right]) =>
      Number(left === resourcePath) - Number(right === resourcePath),
  );
  for (const [filename, code] of files) {
    if (filename.endsWith('.d.ts')) {
      continue;
    }
    const result = transformer.transform(
      { filename, code, project: transformedProject },
      transformOptions,
    );
    transformedProject = {
      ...transformedProject,
      files: {
        ...transformedProject.files,
        [filename]: result.code,
      },
    };
    for (const dependency of result.dependencies) {
      dependencies.add(dependency);
    }
    if (filename === resourcePath) {
      entryResult = result;
    }
  }

  if (!entryResult) {
    entryResult = transformer.transform(
      { filename: resourcePath, code: source, project: transformedProject },
      transformOptions,
    );
    transformedProject = {
      ...transformedProject,
      files: {
        ...transformedProject.files,
        [resourcePath]: entryResult.code,
      },
    };
    for (const dependency of entryResult.dependencies) {
      dependencies.add(dependency);
    }
  }

  return {
    code: entryResult.code,
    map: entryResult.map,
    project: transformedProject,
    dependencies: [...dependencies],
  };
}

function getPreparedTransform(
  context: LoaderContext<MacroTransformLoaderOptions>,
  source: string,
  implementation: MacroTransformImplementation,
  options: MacroTransformOptions,
): Promise<PreparedTransform> {
  const compilation = (
    context as LoaderContext<MacroTransformLoaderOptions> & {
      _compilation?: object;
    }
  )._compilation;
  if (!compilation) {
    return prepareTransform(
      context.resourcePath,
      source,
      implementation,
      options,
    );
  }

  let cache = transformsByCompilation.get(compilation);
  if (!cache) {
    cache = new Map();
    transformsByCompilation.set(compilation, cache);
  }
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const key = `${implementation}\0${context.resourcePath}\0${sourceHash}\0${JSON.stringify(options)}`;
  let prepared = cache.get(key);
  if (!prepared) {
    prepared = prepareTransform(
      context.resourcePath,
      source,
      implementation,
      options,
    );
    cache.set(key, prepared);
  }
  return prepared;
}

function parseSourceMap(map: object | string): object {
  return typeof map === 'string' ? JSON.parse(map) : map;
}

function composeSourceMaps(
  transformedMap: object | string | null,
  inputMap: object | string | null | undefined,
): object | string | null | undefined {
  if (!transformedMap) return inputMap;
  if (!inputMap) return transformedMap;

  const imported = require('@jridgewell/remapping') as {
    default?: (maps: object[], loader: () => null) => object;
  } & ((maps: object[], loader: () => null) => object);
  const remapping = imported.default ?? imported;
  return remapping(
    [parseSourceMap(transformedMap), parseSourceMap(inputMap)],
    () => null,
  );
}

function mergeMeta(
  inputMeta: unknown,
  prepared: PreparedTransform,
): MacroTransformLoaderMeta {
  const meta: MacroTransformLoaderMeta =
    inputMeta && typeof inputMeta === 'object'
      ? { ...(inputMeta as Record<string, unknown>) }
      : {};
  meta[CONF_TS_MACRO_TRANSFORM_META] = {
    project: prepared.project,
    transformDependencies: prepared.dependencies,
  };
  return meta;
}

export default async function (
  this: LoaderContext<MacroTransformLoaderOptions>,
  source: string,
  inputSourceMap?: object | string | null,
  inputMeta?: unknown,
): Promise<void> {
  this.cacheable();
  const callback = this.async();
  try {
    const loaderOptions = this.getOptions();
    const transformOptions = loaderOptions.transformOptions ?? {};
    const prepared = await getPreparedTransform(
      this,
      source,
      loaderOptions.implementation,
      transformOptions,
    );
    for (const dependency of prepared.dependencies) {
      this.addDependency(dependency);
    }
    callback(
      null,
      prepared.code,
      composeSourceMaps(prepared.map, inputSourceMap) as any,
      mergeMeta(inputMeta, prepared) as any,
    );
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
  }
}
