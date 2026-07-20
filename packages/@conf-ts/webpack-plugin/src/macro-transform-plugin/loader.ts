import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
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
      compilerOptions?: Record<string, unknown>;
      previous?: MacroProjectSnapshot;
      overrides?: Record<string, string>;
    },
  ): MacroProjectSnapshot;
  transformProject: TransformProjectFn;
}

interface NativeTransformer extends Transformer {
  scanReferencedModules(
    files: Record<string, string>,
  ): Record<string, string[]>;
}

interface PreparedTransform {
  code: string;
  map: RawSourceMap | null;
  project: MacroProjectSnapshot;
  cache: ProjectCache;
  dependencies: string[];
  dependenciesByFile: Record<string, string[]>;
}

interface PreparedProject {
  project: MacroProjectSnapshot;
  results: Map<string, MacroTransformResult>;
  dependenciesByFile: Record<string, string[]>;
}

interface ProjectCache {
  implementation: MacroTransformImplementation;
  project: MacroProjectSnapshot;
  preparedByOptions: Map<string, Promise<PreparedProject>>;
  previous?: ProjectCache;
  changedFiles?: Set<string>;
  structureStable: boolean;
  snapshot?: object;
  validatedCompilation?: object;
  validationByCompilation: WeakMap<object, Promise<boolean>>;
  registeredCompilations: WeakSet<object>;
  dependencyContents: Map<string, string | undefined>;
}

interface CompilerCache {
  environment: Record<string, string>;
  projectsByFile: Map<string, ProjectCache>;
  batchesByCompilation: WeakMap<object, PendingCompilationBatch>;
}

interface PendingProjectRequest {
  implementation: MacroTransformImplementation;
  resourcePath: string;
  source: string;
  resolve: (cache: ProjectCache) => void;
  reject: (error: Error) => void;
  promise: Promise<ProjectCache>;
}

interface PendingProjectGroup {
  implementation: MacroTransformImplementation;
  compilation: CompilationState & object;
  previous?: ProjectCache;
  requests: PendingProjectRequest[];
}

interface PendingCompilationBatch {
  groups: Map<ProjectCache | string, PendingProjectGroup>;
  pendingByFile: Map<string, Promise<ProjectCache>>;
  scheduled: boolean;
  generation: number;
  activeGroups: number;
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
  if (implementation === 'typescript') {
    return require('@conf-ts/macro-transformer') as Transformer;
  }

  // Intentionally no fallback: choosing the native plugin is an explicit
  // request for the native Oxc-backed transformer.
  const native =
    require('@conf-ts/macro-transformer-native') as NativeTransformer;
  return {
    createMacroProjectSnapshot: (entryFiles, options) => {
      const previous = options?.previous;
      const overrides = options?.overrides ?? {};
      if (previous?.referencedModules) {
        const currentReferences = native.scanReferencedModules(overrides);
        const stable = Object.entries(currentReferences).every(
          ([filename, references]) =>
            Object.prototype.hasOwnProperty.call(previous.files, filename) &&
            sameStrings(previous.referencedModules?.[filename], references),
        );
        if (stable) {
          return {
            ...previous,
            files: { ...previous.files, ...overrides },
            compilerOptions: {
              ...previous.compilerOptions,
              ...options?.compilerOptions,
            },
          };
        }
      }
      return native.createMacroProjectSnapshot(entryFiles, {
        compilerOptions: options?.compilerOptions,
        overrides,
      });
    },
    transformProject: native.transformProject,
  };
}

function sameStrings(left: string[] | undefined, right: string[]): boolean {
  return (
    left?.length === right.length &&
    left.every((value, index) => value === right[index])
  );
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
  const compilationKey = compilation as CompilationState & object;
  const existing = project.validationByCompilation.get(compilationKey);
  if (existing) return existing;
  const validation = new Promise<boolean>((resolve, reject) => {
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
  project.validationByCompilation.set(compilationKey, validation);
  const clearValidation = () => {
    if (project.validationByCompilation.get(compilationKey) === validation) {
      project.validationByCompilation.delete(compilationKey);
    }
  };
  void validation.then(clearValidation, clearValidation);
  return validation;
}

function sourceChanges(
  previousCache: ProjectCache,
  sources: Record<string, string>,
): { overrides: Record<string, string>; requiresFullScan: boolean } {
  const previous = previousCache.project;
  const overrides: Record<string, string> = {};
  let requiresFullScan = false;
  for (const [filename, oldSource] of Object.entries(previous.files)) {
    const current = sources[filename] ?? readOptionalFile(filename);
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
  implementation: MacroTransformImplementation,
  entryFiles: string[],
  sources: Record<string, string>,
  compilation?: CompilationState,
  previous?: ProjectCache,
): Promise<ProjectCache> {
  const transformer = loadTransformer(implementation);
  let baseProject: MacroProjectSnapshot;
  let changedFiles: Set<string> | undefined;
  let structureStable = false;
  if (previous) {
    const changes = sourceChanges(previous, sources);
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
        { overrides: sources },
      );
    }
  } else {
    baseProject = transformer.createMacroProjectSnapshot(entryFiles, {
      overrides: sources,
    });
  }
  for (const [resourcePath, source] of Object.entries(sources)) {
    const sourceProject = projectWithSource(baseProject, resourcePath, source);
    if (sourceProject !== baseProject) {
      baseProject = sourceProject;
      changedFiles ??= new Set();
      changedFiles.add(resourcePath);
    }
  }
  const cache: ProjectCache = {
    implementation,
    project: baseProject,
    preparedByOptions: new Map(),
    previous,
    changedFiles,
    structureStable,
    validatedCompilation: compilation,
    validationByCompilation: new WeakMap(),
    registeredCompilations: new WeakSet(),
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
      batchesByCompilation: new WeakMap(),
    };
  }
  let cache = cachesByOwner.get(owner);
  if (!cache) {
    cache = {
      environment: environmentForCompiler(compiler),
      projectsByFile: new Map(),
      batchesByCompilation: new WeakMap(),
    };
    cachesByOwner.set(owner, cache);
  }
  return cache;
}

function nearestTsConfigPath(resourcePath: string): string {
  let directory = path.dirname(resourcePath);
  while (true) {
    const candidate = path.join(directory, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return `\0no-tsconfig:${directory}`;
    directory = parent;
  }
}

function publishProjectCache(
  compiler: CompilerCache,
  created: ProjectCache,
  previous: ProjectCache | undefined,
): void {
  if (previous) {
    const nextFiles = new Set([
      ...Object.keys(created.project.files),
      ...created.project.entryFiles,
    ]);
    for (const filename of [
      ...Object.keys(previous.project.files),
      ...previous.project.entryFiles,
    ]) {
      if (
        !nextFiles.has(filename) &&
        compiler.projectsByFile.get(
          projectCacheKey(previous.implementation, filename),
        ) === previous
      ) {
        compiler.projectsByFile.delete(
          projectCacheKey(previous.implementation, filename),
        );
      }
    }
  }
  for (const filename of Object.keys(created.project.files)) {
    compiler.projectsByFile.set(
      projectCacheKey(created.implementation, filename),
      created,
    );
  }
  for (const filename of created.project.entryFiles) {
    compiler.projectsByFile.set(
      projectCacheKey(created.implementation, filename),
      created,
    );
  }
}

function projectCacheKey(
  implementation: MacroTransformImplementation,
  filename: string,
): string {
  return `${implementation}\0${filename}`;
}

function finishPendingRequest(
  batch: PendingCompilationBatch,
  request: PendingProjectRequest,
): void {
  const key = projectCacheKey(request.implementation, request.resourcePath);
  if (batch.pendingByFile.get(key) === request.promise) {
    batch.pendingByFile.delete(key);
  }
}

async function flushPendingGroup(
  compiler: CompilerCache,
  batch: PendingCompilationBatch,
  group: PendingProjectGroup,
): Promise<void> {
  const sources: Record<string, string> = {};
  const entryFiles: string[] = [];
  for (const request of group.requests) {
    sources[request.resourcePath] = request.source;
    entryFiles.push(request.resourcePath);
  }
  try {
    const created = await createProjectCache(
      group.implementation,
      group.previous?.project.entryFiles ?? Array.from(new Set(entryFiles)),
      sources,
      group.compilation,
      group.previous,
    );
    publishProjectCache(compiler, created, group.previous);
    for (const request of group.requests) request.resolve(created);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const request of group.requests) request.reject(failure);
  } finally {
    for (const request of group.requests) finishPendingRequest(batch, request);
  }
}

function schedulePendingBatch(
  compiler: CompilerCache,
  compilation: CompilationState & object,
  batch: PendingCompilationBatch,
): void {
  if (batch.scheduled) return;
  batch.scheduled = true;
  const scheduledGeneration = batch.generation;
  setImmediate(() => {
    if (batch.generation !== scheduledGeneration) {
      batch.scheduled = false;
      schedulePendingBatch(compiler, compilation, batch);
      return;
    }
    batch.scheduled = false;
    const groups = Array.from(batch.groups.values());
    batch.groups.clear();
    batch.activeGroups += groups.length;
    void Promise.all(
      groups.map(group => flushPendingGroup(compiler, batch, group)),
    ).then(() => {
      batch.activeGroups -= groups.length;
      if (batch.groups.size > 0) {
        schedulePendingBatch(compiler, compilation, batch);
      } else if (
        batch.activeGroups === 0 &&
        batch.pendingByFile.size === 0 &&
        compiler.batchesByCompilation.get(compilation) === batch
      ) {
        compiler.batchesByCompilation.delete(compilation);
      }
    });
  });
}

function enqueueProjectCache(
  compiler: CompilerCache,
  implementation: MacroTransformImplementation,
  resourcePath: string,
  source: string,
  compilation: CompilationState & object,
  previous: ProjectCache | undefined,
): Promise<ProjectCache> {
  let batch = compiler.batchesByCompilation.get(compilation);
  if (!batch) {
    batch = {
      groups: new Map(),
      pendingByFile: new Map(),
      scheduled: false,
      generation: 0,
      activeGroups: 0,
    };
    compiler.batchesByCompilation.set(compilation, batch);
  }
  const pendingKey = projectCacheKey(implementation, resourcePath);
  const pending = batch.pendingByFile.get(pendingKey);
  if (pending) return pending;

  let resolveRequest!: (cache: ProjectCache) => void;
  let rejectRequest!: (error: Error) => void;
  const promise = new Promise<ProjectCache>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const request: PendingProjectRequest = {
    implementation,
    resourcePath,
    source,
    resolve: resolveRequest,
    reject: rejectRequest,
    promise,
  };
  batch.pendingByFile.set(pendingKey, promise);
  batch.generation++;

  const groupKey =
    previous ?? `${implementation}\0${nearestTsConfigPath(resourcePath)}`;
  let group = batch.groups.get(groupKey);
  if (!group) {
    group = { implementation, compilation, previous, requests: [] };
    batch.groups.set(groupKey, group);
  }
  group.requests.push(request);
  schedulePendingBatch(compiler, compilation, batch);
  return promise;
}

async function projectCacheFor(
  cache: CompilerCache,
  implementation: MacroTransformImplementation,
  resourcePath: string,
  source: string,
  compilation?: CompilationState,
): Promise<ProjectCache> {
  const compilationKey = compilation as (CompilationState & object) | undefined;
  const cacheKey = projectCacheKey(implementation, resourcePath);
  const pending = compilationKey
    ? cache.batchesByCompilation
        .get(compilationKey)
        ?.pendingByFile.get(cacheKey)
    : undefined;
  if (pending) return pending;

  const existing = cache.projectsByFile.get(cacheKey);
  if (existing && (await checkSnapshotValid(compilation, existing))) {
    return existing;
  }
  if (compilationKey) {
    const queued = cache.batchesByCompilation
      .get(compilationKey)
      ?.pendingByFile.get(cacheKey);
    if (queued) return queued;
    return enqueueProjectCache(
      cache,
      implementation,
      resourcePath,
      source,
      compilationKey,
      existing,
    );
  }
  const created = await createProjectCache(
    implementation,
    [resourcePath],
    { [resourcePath]: source },
    undefined,
    existing,
  );
  publishProjectCache(cache, created, existing);
  return created;
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
    void prepared.then(undefined, () => {
      if (cache.preparedByOptions.get(key) === prepared) {
        cache.preparedByOptions.delete(key);
      }
    });
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
    cache,
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
    implementation,
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
  cache: ProjectCache,
): void {
  const compilation = currentCompilation(context);
  if (!compilation || cache.registeredCompilations.has(compilation)) return;
  for (const dependency of cache.project.dependencies) {
    compilation?.fileDependencies?.add(dependency);
  }
  for (const dependency of cache.project.missingDependencies ?? []) {
    compilation?.missingDependencies?.add(dependency);
  }
  cache.registeredCompilations.add(compilation);
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
    registerGraphDependencies(this, prepared.cache);
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
