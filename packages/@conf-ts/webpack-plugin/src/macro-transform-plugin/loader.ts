import { createHash } from 'crypto';
import fs from 'fs';
import type {
  MacroProjectSnapshot,
  MacroTransformOptions,
  MacroTransformProjectInput,
  MacroTransformProjectResult,
  MacroTransformResult,
  RawSourceMap,
} from '@conf-ts/macro-transformer';
import type { LoaderContext } from 'webpack';

import { environmentForCompiler } from './environment';
import {
  CONF_TS_MACRO_TRANSFORM_META,
  type MacroTransformImplementation,
  type MacroTransformLoaderMeta,
} from './types';

interface MacroTransformLoaderOptions {
  implementation: MacroTransformImplementation;
  transformOptions?: MacroTransformOptions;
  environmentFingerprint?: string;
}

type TransformProjectFn = (
  input: MacroTransformProjectInput,
  options?: MacroTransformOptions,
) => MacroTransformProjectResult;

interface Transformer {
  createMacroProjectSnapshot(
    entryFiles: string[],
    options?: {
      previous?: MacroProjectSnapshot;
      overrides?: Record<string, string>;
    },
  ): MacroProjectSnapshot;
  transformProject: TransformProjectFn;
}

interface PreparedTransform {
  code: string;
  map: RawSourceMap | null;
  project: MacroProjectSnapshot;
  dependencies: string[];
  dependenciesByFile: Record<string, string[]>;
}

interface PreparedProject {
  project: MacroProjectSnapshot;
  results: Map<string, MacroTransformResult>;
  dependenciesByFile: Record<string, string[]>;
}

interface ProjectCache {
  project: MacroProjectSnapshot;
  preparedByOptions: Map<string, Promise<PreparedProject>>;
  previous?: ProjectCache;
  changedFiles?: Set<string>;
  structureStable: boolean;
  snapshot?: object;
  validatedCompilation?: object;
  dependencyContents: Map<string, string | undefined>;
}

interface CompilerCache {
  environment: Record<string, string>;
  projectsByFile: Map<string, ProjectCache>;
  inFlight?: Promise<ProjectCache>;
}

interface FileSystemInfoLike {
  createSnapshot(
    startTime: undefined,
    files: Iterable<string>,
    directories: undefined,
    missing: Iterable<string>,
    options: { hash: boolean; timestamp: boolean },
    callback: (error: Error | null, snapshot: object | null) => void,
  ): void;
  checkSnapshotValid(
    snapshot: object,
    callback: (error: Error | null, valid?: boolean) => void,
  ): void;
}

interface CompilationState {
  fileSystemInfo?: FileSystemInfoLike;
  fileDependencies?: { add(dependency: string): unknown };
  missingDependencies?: { add(dependency: string): unknown };
}

const cachesByOwner = new WeakMap<object, CompilerCache>();
const MACRO_PACKAGE = '@conf-ts/macro';

function mightContainMacroImport(source: string): boolean {
  // A backslash may be part of an escaped module specifier whose decoded
  // value is MACRO_PACKAGE. False positives only cost one transform; false
  // negatives would leave a compile-time macro in webpack's output.
  return source.includes(MACRO_PACKAGE) || source.includes('\\');
}

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
    'transformProject'
  >;
  return {
    createMacroProjectSnapshot: typescript.createMacroProjectSnapshot,
    transformProject: native.transformProject,
  };
}

function transformOptionsKey(options: MacroTransformOptions): string {
  return JSON.stringify({
    env: Object.entries(options.env ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    preserveKeyOrder: options.preserveKeyOrder === true,
    quote: options.quote ?? 'double',
    sourceMap: options.sourceMap === true,
  });
}

function currentCompilation(
  context: LoaderContext<MacroTransformLoaderOptions>,
): CompilationState | undefined {
  return (
    context as LoaderContext<MacroTransformLoaderOptions> & {
      _compilation?: CompilationState;
    }
  )._compilation;
}

function readOptionalFile(filename: string): string | undefined {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch {
    return undefined;
  }
}

function projectWithSource(
  project: MacroProjectSnapshot,
  resourcePath: string,
  source: string,
): MacroProjectSnapshot {
  if (project.files[resourcePath] === source) return project;
  return {
    ...project,
    files: { ...project.files, [resourcePath]: source },
  };
}

function affectedFiles(
  cache: ProjectCache,
  previous: PreparedProject,
): string[] {
  const affected = new Set(cache.changedFiles ?? []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [filename, result] of previous.results) {
      if (
        !affected.has(filename) &&
        result.dependencies.some(dependency => affected.has(dependency))
      ) {
        affected.add(filename);
        changed = true;
      }
    }
  }
  return [...affected];
}

async function prepareProject(
  cache: ProjectCache,
  key: string,
  implementation: MacroTransformImplementation,
  options: MacroTransformOptions,
  environment: Record<string, string>,
  project: MacroProjectSnapshot = cache.project,
): Promise<PreparedProject> {
  const transformer = loadTransformer(implementation);
  const transformOptions: MacroTransformOptions = {
    ...options,
    env: { ...environment, ...options.env },
    inheritProcessEnv: false,
  };
  let prior: PreparedProject | undefined;
  let targets: string[] | undefined;
  if (cache.structureStable && cache.previous) {
    prior = await cache.previous.preparedByOptions.get(key);
    if (prior) targets = affectedFiles(cache, prior);
  }
  const batch = transformer.transformProject(
    { project, ...(targets ? { files: targets } : {}) },
    transformOptions,
  );
  const results = new Map<string, MacroTransformResult>();
  if (prior && targets) {
    const affected = new Set(targets);
    for (const [filename, result] of prior.results) {
      if (!affected.has(filename) && filename in project.files) {
        results.set(filename, result);
      }
    }
  }
  for (const [filename, result] of Object.entries(batch.transformed)) {
    results.set(filename, result);
  }
  const transformedFiles = { ...project.files };
  const dependenciesByFile: Record<string, string[]> = {};
  for (const [filename, result] of results) {
    transformedFiles[filename] = result.code;
    dependenciesByFile[filename] = result.dependencies;
  }
  const transformedProject: MacroProjectSnapshot = {
    ...project,
    files: transformedFiles,
  };
  return { project: transformedProject, results, dependenciesByFile };
}

function createFileSystemSnapshot(
  compilation: CompilationState | undefined,
  project: MacroProjectSnapshot,
): Promise<object | undefined> {
  const fileSystemInfo = compilation?.fileSystemInfo;
  if (!fileSystemInfo?.createSnapshot) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    fileSystemInfo.createSnapshot(
      undefined,
      project.dependencies,
      undefined,
      project.missingDependencies ?? [],
      { hash: true, timestamp: true },
      (error: Error | null, snapshot: object | null) => {
        if (error) reject(error);
        else resolve(snapshot ?? undefined);
      },
    );
  });
}

function checkSnapshotValid(
  compilation: CompilationState | undefined,
  project: ProjectCache,
): Promise<boolean> {
  if (project.validatedCompilation === compilation)
    return Promise.resolve(true);
  const fileSystemInfo = compilation?.fileSystemInfo;
  const snapshot = project.snapshot;
  if (!snapshot || !fileSystemInfo?.checkSnapshotValid) {
    project.validatedCompilation = compilation;
    return Promise.resolve(true);
  }
  return new Promise((resolve, reject) => {
    fileSystemInfo.checkSnapshotValid(
      snapshot,
      (error: Error | null, valid?: boolean) => {
        if (error) reject(error);
        else {
          if (valid) project.validatedCompilation = compilation;
          resolve(valid === true);
        }
      },
    );
  });
}

function sourceChanges(
  previousCache: ProjectCache,
  resourcePath: string,
  source: string,
): { overrides: Record<string, string>; requiresFullScan: boolean } {
  const previous = previousCache.project;
  const overrides: Record<string, string> = {};
  let requiresFullScan = false;
  for (const [filename, oldSource] of Object.entries(previous.files)) {
    const current =
      filename === resourcePath ? source : readOptionalFile(filename);
    if (current === undefined) {
      requiresFullScan = true;
    } else if (current !== oldSource) {
      overrides[filename] = current;
    }
  }
  for (const [dependency, oldContent] of previousCache.dependencyContents) {
    const current = readOptionalFile(dependency);
    if (current !== oldContent) requiresFullScan = true;
  }
  if (
    previous.missingDependencies?.some(dependency => fs.existsSync(dependency))
  ) {
    requiresFullScan = true;
  }
  return { overrides, requiresFullScan };
}

async function createProjectCache(
  resourcePath: string,
  source: string,
  compilation?: CompilationState,
  previous?: ProjectCache,
): Promise<ProjectCache> {
  const transformer = loadTransformer('typescript');
  let baseProject: MacroProjectSnapshot;
  let changedFiles: Set<string> | undefined;
  let structureStable = false;
  if (previous) {
    const changes = sourceChanges(previous, resourcePath, source);
    if (!changes.requiresFullScan) {
      baseProject = transformer.createMacroProjectSnapshot(
        previous.project.entryFiles,
        { previous: previous.project, overrides: changes.overrides },
      );
      structureStable =
        baseProject.resolutions === previous.project.resolutions;
      changedFiles = new Set(Object.keys(changes.overrides));
    } else {
      baseProject = transformer.createMacroProjectSnapshot(
        previous.project.entryFiles,
      );
    }
  } else {
    baseProject = transformer.createMacroProjectSnapshot([resourcePath]);
  }
  const sourceProject = projectWithSource(baseProject, resourcePath, source);
  if (sourceProject !== baseProject) {
    baseProject = sourceProject;
    changedFiles ??= new Set();
    changedFiles.add(resourcePath);
  }
  const cache: ProjectCache = {
    project: baseProject,
    preparedByOptions: new Map(),
    previous,
    changedFiles,
    structureStable,
    validatedCompilation: compilation,
    dependencyContents: new Map(),
  };
  for (const dependency of baseProject.dependencies) {
    if (dependency in baseProject.files) continue;
    cache.dependencyContents.set(dependency, readOptionalFile(dependency));
  }
  cache.snapshot = await createFileSystemSnapshot(compilation, baseProject);
  return cache;
}

function compilerCache(
  context: LoaderContext<MacroTransformLoaderOptions>,
): CompilerCache {
  const compiler = context._compiler;
  const compilation = currentCompilation(context);
  const owner = compiler ?? compilation;
  if (!owner) {
    return {
      environment: environmentForCompiler(undefined),
      projectsByFile: new Map(),
    };
  }
  let cache = cachesByOwner.get(owner);
  if (!cache) {
    cache = {
      environment: environmentForCompiler(compiler),
      projectsByFile: new Map(),
    };
    cachesByOwner.set(owner, cache);
  }
  return cache;
}

async function projectCacheFor(
  cache: CompilerCache,
  resourcePath: string,
  source: string,
  compilation?: CompilationState,
): Promise<ProjectCache> {
  let existing = cache.projectsByFile.get(resourcePath);
  if (existing && (await checkSnapshotValid(compilation, existing))) {
    return existing;
  }
  if (cache.inFlight) {
    await cache.inFlight;
    existing = cache.projectsByFile.get(resourcePath);
    if (existing && (await checkSnapshotValid(compilation, existing))) {
      return existing;
    }
  }
  const pending = createProjectCache(
    resourcePath,
    source,
    compilation,
    existing,
  );
  cache.inFlight = pending;
  try {
    const created = await pending;
    for (const filename of Object.keys(created.project.files)) {
      cache.projectsByFile.set(filename, created);
    }
    cache.projectsByFile.set(resourcePath, created);
    return created;
  } finally {
    if (cache.inFlight === pending) cache.inFlight = undefined;
  }
}

function preparedProjectFor(
  cache: ProjectCache,
  resourcePath: string,
  source: string,
  implementation: MacroTransformImplementation,
  options: MacroTransformOptions,
  environment: Record<string, string>,
): Promise<PreparedProject> {
  const project = projectWithSource(cache.project, resourcePath, source);
  const sourceKey =
    project === cache.project
      ? ''
      : `\0${resourcePath}\0${createHash('sha256').update(source).digest('hex')}`;
  const key = `${implementation}\0${transformOptionsKey(options)}${sourceKey}`;
  let prepared = cache.preparedByOptions.get(key);
  if (!prepared) {
    // Store the promise before doing the expensive transform so concurrent
    // loader calls share the same work as well as the same final project.
    prepared = Promise.resolve().then(() =>
      prepareProject(cache, key, implementation, options, environment, project),
    );
    cache.preparedByOptions.set(key, prepared);
  }
  return prepared;
}

async function preparedTransformFor(
  cache: ProjectCache,
  resourcePath: string,
  source: string,
  implementation: MacroTransformImplementation,
  options: MacroTransformOptions,
  environment: Record<string, string>,
): Promise<PreparedTransform> {
  const prepared = await preparedProjectFor(
    cache,
    resourcePath,
    source,
    implementation,
    options,
    environment,
  );
  const result = prepared.results.get(resourcePath);
  return {
    code: result?.code ?? source,
    map: result?.map ?? null,
    project: prepared.project,
    dependencies: result?.dependencies ?? [],
    dependenciesByFile: prepared.dependenciesByFile,
  };
}

async function getPreparedTransform(
  context: LoaderContext<MacroTransformLoaderOptions>,
  source: string,
  implementation: MacroTransformImplementation,
  options: MacroTransformOptions,
): Promise<PreparedTransform> {
  const compilation = currentCompilation(context);
  const compilationState = compilerCache(context);
  const projectCache = await projectCacheFor(
    compilationState,
    context.resourcePath,
    source,
    compilation,
  );
  return preparedTransformFor(
    projectCache,
    context.resourcePath,
    source,
    implementation,
    options,
    compilationState.environment,
  );
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
    transformDependenciesByFile: prepared.dependenciesByFile,
  };
  return meta;
}

function hasConfTsConfigLoader(
  context: LoaderContext<MacroTransformLoaderOptions>,
): boolean {
  return (context.loaders ?? []).some(loader => {
    const options = loader.options;
    return (
      options !== null &&
      typeof options === 'object' &&
      (options as Record<string, unknown>).confTsConfigLoader === true
    );
  });
}

function registerGraphDependencies(
  context: LoaderContext<MacroTransformLoaderOptions>,
  project: MacroProjectSnapshot,
): void {
  const compilation = currentCompilation(context);
  for (const dependency of project.dependencies) {
    compilation?.fileDependencies?.add(dependency);
  }
  for (const dependency of project.missingDependencies ?? []) {
    compilation?.missingDependencies?.add(dependency);
  }
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
    const requestedOptions = loaderOptions.transformOptions ?? {};
    if (!mightContainMacroImport(source) && !hasConfTsConfigLoader(this)) {
      callback(null, source, inputSourceMap as any, inputMeta as any);
      return;
    }
    const transformOptions: MacroTransformOptions = {
      ...requestedOptions,
      sourceMap: requestedOptions.sourceMap ?? this.sourceMap === true,
    };
    const prepared = await getPreparedTransform(
      this,
      source,
      loaderOptions.implementation,
      transformOptions,
    );
    registerGraphDependencies(this, prepared.project);
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
