const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const webpack = require('webpack');

const {
  ConfTsWebpackPlugin,
  NativeMacroTransformPlugin,
  TypeScriptMacroTransformPlugin,
} = require('../dist/cjs/index.js');

const MODULE_COUNT = 120;
const CONTEXT_SHARED_MODULE_COUNT = 20;
const MEASUREMENTS = 5;
// The config-emission baseline intentionally compiles every context entry and
// is much slower than the shared macro project. One measured rebuild is enough
// for the 1.30x guard while keeping this manual benchmark practical.
const CONTEXT_MEASUREMENTS = 1;
const STAGE_MEASUREMENTS = 5;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function comparisonRow(typescript, native) {
  return {
    typescriptMs: Number(typescript.toFixed(2)),
    nativeMs: Number(native.toFixed(2)),
    nativeVsTs: Number((native / typescript).toFixed(3)),
    tsOverNative: Number((typescript / native).toFixed(2)),
  };
}

function printComparison(title, rows) {
  console.log(`\n${title}`);
  console.table(
    Object.fromEntries(
      Object.entries(rows).map(([name, values]) => [
        name,
        comparisonRow(values.typescript, values.native),
      ]),
    ),
  );
}

function moduleLoadMedian(moduleName) {
  const resolved = require.resolve(moduleName);
  const script = [
    "const { performance } = require('node:perf_hooks');",
    'const started = performance.now();',
    'require(process.argv[1]);',
    'process.stdout.write(String(performance.now() - started));',
  ].join('');
  const measurements = [];
  for (let index = 0; index <= STAGE_MEASUREMENTS; index++) {
    const elapsed = Number(
      execFileSync(process.execPath, ['-e', script, resolved], {
        encoding: 'utf8',
      }),
    );
    if (index > 0) measurements.push(elapsed);
  }
  return median(measurements);
}

function projectWithTransforms(project, batch) {
  const files = { ...project.files };
  for (const [filename, result] of Object.entries(batch.transformed)) {
    files[filename] = result.code;
  }
  return { ...project, files };
}

function compileProject(compiler, project, entryFile) {
  return compiler.compileInMemory(project.files, entryFile, 'json', {
    compilerOptions: project.compilerOptions,
  });
}

function writeFixture(root, macro) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        module: 'esnext',
        moduleResolution: 'bundler',
      },
    }),
  );
  const imports = [];
  const properties = [];
  for (let index = 0; index < MODULE_COUNT; index++) {
    const helper = path.join(root, `helper-${index}.js`);
    const value = path.join(root, `value-${index}.js`);
    fs.writeFileSync(
      helper,
      `export const raw = ${JSON.stringify(String(index))};`,
    );
    fs.writeFileSync(
      value,
      macro
        ? [
            "import { String as MacroString } from '@conf-ts/macro';",
            `import { raw } from './helper-${index}.js';`,
            `export const value${index} = MacroString(raw);`,
          ].join('\n')
        : [
            `import { raw } from './helper-${index}.js';`,
            `export const value${index} = raw;`,
          ].join('\n'),
    );
    imports.push(`import { value${index} } from './value-${index}.js';`);
    properties.push(`value${index}`);
  }
  fs.writeFileSync(
    path.join(root, 'config.conf.js'),
    `${imports.join('\n')}\nexport default { ${properties.join(', ')} };`,
  );
}

function writeContextFixture(root, macro) {
  fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        module: 'esnext',
        moduleResolution: 'bundler',
      },
    }),
  );
  const sharedExports = [];
  for (let index = 0; index < CONTEXT_SHARED_MODULE_COUNT; index++) {
    fs.writeFileSync(
      path.join(root, `helper-${index}.js`),
      `export const raw${index} = ${JSON.stringify(String(index))};`,
    );
    sharedExports.push(`export { raw${index} } from './helper-${index}.js';`);
  }
  fs.writeFileSync(path.join(root, 'shared.js'), sharedExports.join('\n'));
  for (let index = 0; index < MODULE_COUNT; index++) {
    fs.writeFileSync(
      path.join(root, 'configs', `config-${index}.conf.js`),
      macro
        ? [
            "import { String as MacroString } from '@conf-ts/macro';",
            "import { raw0 } from '../shared.js';",
            `export default MacroString(raw0 + '-${index}');`,
          ].join('\n')
        : [
            "import { raw0 } from '../shared.js';",
            `export default raw0 + '-${index}';`,
          ].join('\n'),
    );
  }
  fs.writeFileSync(
    path.join(root, 'index.js'),
    'export const load = name => import(`./configs/${name}.conf.js`);',
  );
}

function compilerForWithCompiler(root, implementation, compiler) {
  const macroPlugin =
    implementation === 'typescript'
      ? new TypeScriptMacroTransformPlugin()
      : implementation === 'native'
        ? new NativeMacroTransformPlugin()
        : undefined;
  return webpack({
    context: root,
    mode: 'production',
    devtool: false,
    cache: false,
    entry: './config.conf.js',
    optimization: { minimize: false },
    output: { path: path.join(root, 'dist'), filename: 'bundle.js' },
    plugins: [
      ...(macroPlugin ? [macroPlugin] : []),
      new ConfTsWebpackPlugin({
        compiler,
        extensionToRemove: '.conf.js',
        test: /\.conf\.js$/,
        useWorkers: false,
      }),
    ],
  });
}

function compilerFor(root, implementation) {
  return compilerForWithCompiler(root, implementation, 'js');
}

function nativePipelineCompilerFor(root, implementation) {
  return compilerForWithCompiler(root, implementation, 'native');
}

function contextCompilerFor(root, implementation) {
  const macroPlugin =
    implementation === 'typescript'
      ? new TypeScriptMacroTransformPlugin({ test: /\.conf\.js$/ })
      : implementation === 'native'
        ? new NativeMacroTransformPlugin({ test: /\.conf\.js$/ })
        : undefined;
  return webpack({
    context: root,
    mode: 'production',
    devtool: false,
    cache: false,
    parallelism: MODULE_COUNT * 2,
    entry: './index.js',
    optimization: { minimize: false },
    output: { path: path.join(root, 'dist'), filename: 'bundle.js' },
    plugins: [
      ...(macroPlugin ? [macroPlugin] : []),
      new ConfTsWebpackPlugin({
        compiler: 'js',
        extensionToRemove: '.conf.js',
        test: /\.conf\.js$/,
        useWorkers: false,
      }),
    ],
  });
}

function runCompiler(compiler) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      if (error) return reject(error);
      if (!stats) return reject(new Error('Webpack returned no stats'));
      if (stats.hasErrors()) {
        return reject(new Error(stats.toString({ all: false, errors: true })));
      }
      resolve(performance.now() - started);
    });
  });
}

function closeCompiler(compiler) {
  return new Promise(resolve => compiler.close(resolve));
}

async function coldMeasurement(
  root,
  implementation,
  createCompiler = compilerFor,
) {
  const compiler = createCompiler(root, implementation);
  try {
    return await runCompiler(compiler);
  } finally {
    await closeCompiler(compiler);
  }
}

async function withTypeScriptSnapshotOnNativePath(run) {
  const typescript = require('@conf-ts/macro-transformer');
  const native = require('@conf-ts/macro-transformer-native');
  const original = native.createMacroProjectSnapshot;
  native.createMacroProjectSnapshot = typescript.createMacroProjectSnapshot;
  try {
    return await run();
  } finally {
    native.createMacroProjectSnapshot = original;
  }
}

async function verifySingleAnalysis(
  root,
  implementation,
  createCompiler = compilerFor,
) {
  const typescript = require('@conf-ts/macro-transformer');
  const native = require('@conf-ts/macro-transformer-native');
  const transformer = implementation === 'native' ? native : typescript;
  const snapshotTransformer = implementation === 'native' ? native : typescript;
  const originalSnapshot = snapshotTransformer.createMacroProjectSnapshot;
  const originalBatch = transformer.transformProject;
  let snapshots = 0;
  let batches = 0;
  snapshotTransformer.createMacroProjectSnapshot = (...args) => {
    snapshots++;
    return originalSnapshot(...args);
  };
  transformer.transformProject = (...args) => {
    batches++;
    return originalBatch(...args);
  };
  const compiler = createCompiler(root, implementation);
  try {
    await runCompiler(compiler);
  } finally {
    await closeCompiler(compiler);
    snapshotTransformer.createMacroProjectSnapshot = originalSnapshot;
    transformer.transformProject = originalBatch;
  }
  if (snapshots !== 1 || batches !== 1) {
    throw new Error(
      `${implementation}: expected one snapshot and one batch, got ${snapshots}/${batches}`,
    );
  }
}

function transformerStageMeasurements(entryFile) {
  const typescript = require('@conf-ts/macro-transformer');
  const native = require('@conf-ts/macro-transformer-native');
  const compilerTypescript = require('@conf-ts/compiler');
  const compilerNative = require('@conf-ts/compiler-native');
  const transformers = { typescript, native };
  const compilers = {
    typescript: compilerTypescript,
    native: compilerNative,
  };
  const measurements = {
    macroModuleLoad: {
      typescript: moduleLoadMedian('@conf-ts/macro-transformer'),
      native: moduleLoadMedian('@conf-ts/macro-transformer-native'),
    },
    compilerModuleLoad: {
      typescript: moduleLoadMedian('@conf-ts/compiler'),
      native: moduleLoadMedian('@conf-ts/compiler-native'),
    },
    snapshot: { typescript: [], native: [] },
    macroTransform: { typescript: [], native: [] },
    compile: { typescript: [], native: [] },
    macroPipeline: { typescript: [], native: [] },
    fullPipeline: { typescript: [], native: [] },
  };
  const warmProjects = {
    typescript: typescript.createMacroProjectSnapshot([entryFile]),
    native: native.createMacroProjectSnapshot([entryFile]),
  };
  const warmTypeScriptTransform = typescript.transformProject({
    project: warmProjects.typescript,
  });
  const warmNativeTransform = native.transformProject({
    project: warmProjects.native,
  });
  const typeScriptTargets = Object.keys(
    warmTypeScriptTransform.transformed,
  ).sort();
  const nativeTargets = Object.keys(warmNativeTransform.transformed).sort();
  if (JSON.stringify(typeScriptTargets) !== JSON.stringify(nativeTargets)) {
    throw new Error(
      `macro transform workloads differ: TypeScript transformed ${typeScriptTargets.length} files, native transformed ${nativeTargets.length}`,
    );
  }
  const ordinaryProject = projectWithTransforms(
    warmProjects.native,
    warmNativeTransform,
  );
  compilerTypescript.compileInMemory(ordinaryProject.files, entryFile, 'json', {
    compilerOptions: ordinaryProject.compilerOptions,
  });
  compilerNative.compileInMemory(ordinaryProject.files, entryFile, 'json', {
    compilerOptions: ordinaryProject.compilerOptions,
  });
  for (let index = 0; index < STAGE_MEASUREMENTS; index++) {
    const order =
      index % 2 === 0 ? ['typescript', 'native'] : ['native', 'typescript'];
    for (const implementation of order) {
      const transformer = transformers[implementation];
      let started = performance.now();
      const project = transformer.createMacroProjectSnapshot([entryFile]);
      measurements.snapshot[implementation].push(performance.now() - started);

      started = performance.now();
      transformer.transformProject({ project });
      measurements.macroTransform[implementation].push(
        performance.now() - started,
      );

      started = performance.now();
      compileProject(compilers[implementation], ordinaryProject, entryFile);
      measurements.compile[implementation].push(performance.now() - started);

      started = performance.now();
      const pipelineProject = transformer.createMacroProjectSnapshot([
        entryFile,
      ]);
      transformer.transformProject({ project: pipelineProject });
      measurements.macroPipeline[implementation].push(
        performance.now() - started,
      );

      started = performance.now();
      const fullProject = transformer.createMacroProjectSnapshot([entryFile]);
      const fullTransform = transformer.transformProject({
        project: fullProject,
      });
      compileProject(
        compilers[implementation],
        projectWithTransforms(fullProject, fullTransform),
        entryFile,
      );
      measurements.fullPipeline[implementation].push(
        performance.now() - started,
      );
    }
  }
  const medians = Object.fromEntries(
    Object.entries(measurements).map(([stage, values]) => [
      stage,
      {
        typescript: Array.isArray(values.typescript)
          ? median(values.typescript)
          : values.typescript,
        native: Array.isArray(values.native)
          ? median(values.native)
          : values.native,
      },
    ]),
  );
  printComparison('Module-level TypeScript vs native', medians);
  if (medians.snapshot.native > medians.snapshot.typescript * 0.5) {
    throw new Error(
      `native snapshot exceeded 0.50x TypeScript snapshot (${medians.snapshot.native.toFixed(2)}ms vs ${medians.snapshot.typescript.toFixed(2)}ms)`,
    );
  }
  return medians;
}

async function watchMeasurements(
  root,
  implementation,
  createCompiler = compilerFor,
  helperName = 'raw',
  measurements = MEASUREMENTS,
) {
  const compiler = createCompiler(root, implementation);
  const values = [];
  try {
    await runCompiler(compiler);
    for (let index = 0; index < measurements; index++) {
      fs.writeFileSync(
        path.join(root, 'helper-0.js'),
        `export const ${helperName} = ${JSON.stringify(`watch-${index}`)};`,
      );
      values.push(await runCompiler(compiler));
    }
  } finally {
    await closeCompiler(compiler);
  }
  return median(values);
}

async function main() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'conf-ts-large-benchmark-'),
  );
  const roots = {
    baseline: path.join(temporaryRoot, 'baseline'),
    typescript: path.join(temporaryRoot, 'typescript'),
    native: path.join(temporaryRoot, 'native'),
  };
  const contextRoots = {
    baseline: path.join(temporaryRoot, 'context-baseline'),
    typescript: path.join(temporaryRoot, 'context-typescript'),
    native: path.join(temporaryRoot, 'context-native'),
  };
  writeFixture(roots.baseline, false);
  writeFixture(roots.typescript, true);
  writeFixture(roots.native, true);
  writeContextFixture(contextRoots.baseline, false);
  writeContextFixture(contextRoots.typescript, true);
  writeContextFixture(contextRoots.native, true);
  try {
    const transformerStages = transformerStageMeasurements(
      path.join(roots.native, 'config.conf.js'),
    );
    await coldMeasurement(roots.baseline, 'baseline');
    await coldMeasurement(roots.typescript, 'typescript');
    await coldMeasurement(roots.native, 'native');
    await verifySingleAnalysis(roots.typescript, 'typescript');
    await verifySingleAnalysis(roots.native, 'native');
    await verifySingleAnalysis(
      contextRoots.typescript,
      'typescript',
      contextCompilerFor,
    );
    await verifySingleAnalysis(
      contextRoots.native,
      'native',
      contextCompilerFor,
    );

    const cold = { baseline: [], typescript: [], native: [] };
    for (let index = 0; index < MEASUREMENTS; index++) {
      cold.baseline.push(await coldMeasurement(roots.baseline, 'baseline'));
      cold.typescript.push(
        await coldMeasurement(roots.typescript, 'typescript'),
      );
      cold.native.push(await coldMeasurement(roots.native, 'native'));
    }
    const coldMedians = Object.fromEntries(
      Object.entries(cold).map(([name, values]) => [name, median(values)]),
    );
    const watchMedians = {
      baseline: await watchMeasurements(roots.baseline, 'baseline'),
      typescript: await watchMeasurements(roots.typescript, 'typescript'),
      native: await watchMeasurements(roots.native, 'native'),
    };
    console.table({ cold: coldMedians, watch: watchMedians });
    for (const implementation of ['typescript', 'native']) {
      const coldRatio = coldMedians[implementation] / coldMedians.baseline;
      const watchRatio = watchMedians[implementation] / watchMedians.baseline;
      if (coldRatio > 1.3 || watchRatio > 1.3) {
        throw new Error(
          `${implementation} exceeded 1.30x baseline (cold ${coldRatio.toFixed(2)}x, watch ${watchRatio.toFixed(2)}x)`,
        );
      }
    }

    const nativePipelineCold = {
      typescriptImplementation: [],
      typescriptSnapshot: [],
      rustSnapshot: [],
    };
    for (let index = 0; index < MEASUREMENTS; index++) {
      nativePipelineCold.typescriptImplementation.push(
        await coldMeasurement(
          roots.typescript,
          'typescript',
          nativePipelineCompilerFor,
        ),
      );
      nativePipelineCold.typescriptSnapshot.push(
        await withTypeScriptSnapshotOnNativePath(() =>
          coldMeasurement(roots.native, 'native', nativePipelineCompilerFor),
        ),
      );
      nativePipelineCold.rustSnapshot.push(
        await coldMeasurement(
          roots.native,
          'native',
          nativePipelineCompilerFor,
        ),
      );
    }
    const nativePipeline = {
      coldTypeScript: median(nativePipelineCold.typescriptImplementation),
      coldNative: median(nativePipelineCold.rustSnapshot),
      coldTypeScriptSnapshot: median(nativePipelineCold.typescriptSnapshot),
      coldRustSnapshot: median(nativePipelineCold.rustSnapshot),
      watchTypeScript: await watchMeasurements(
        roots.typescript,
        'typescript',
        nativePipelineCompilerFor,
      ),
      watchTypeScriptSnapshot: await withTypeScriptSnapshotOnNativePath(() =>
        watchMeasurements(roots.native, 'native', nativePipelineCompilerFor),
      ),
      watchRustSnapshot: await watchMeasurements(
        roots.native,
        'native',
        nativePipelineCompilerFor,
      ),
    };
    console.table({ nativePipeline });
    const nativeColdRatio =
      nativePipeline.coldRustSnapshot / nativePipeline.coldTypeScriptSnapshot;
    const nativeWatchRatio =
      nativePipeline.watchRustSnapshot / nativePipeline.watchTypeScriptSnapshot;
    if (nativeColdRatio > 1.1 || nativeWatchRatio > 1.1) {
      throw new Error(
        `Rust snapshot regressed the native-only pipeline by more than 10% (cold ${nativeColdRatio.toFixed(2)}x, watch ${nativeWatchRatio.toFixed(2)}x)`,
      );
    }

    await coldMeasurement(
      contextRoots.baseline,
      'baseline',
      contextCompilerFor,
    );
    await coldMeasurement(
      contextRoots.typescript,
      'typescript',
      contextCompilerFor,
    );
    await coldMeasurement(contextRoots.native, 'native', contextCompilerFor);
    const contextCold = { baseline: [], typescript: [], native: [] };
    for (let index = 0; index < CONTEXT_MEASUREMENTS; index++) {
      contextCold.baseline.push(
        await coldMeasurement(
          contextRoots.baseline,
          'baseline',
          contextCompilerFor,
        ),
      );
      contextCold.typescript.push(
        await coldMeasurement(
          contextRoots.typescript,
          'typescript',
          contextCompilerFor,
        ),
      );
      contextCold.native.push(
        await coldMeasurement(
          contextRoots.native,
          'native',
          contextCompilerFor,
        ),
      );
    }
    const contextColdMedians = Object.fromEntries(
      Object.entries(contextCold).map(([name, values]) => [
        name,
        median(values),
      ]),
    );
    const contextWatchMedians = {
      baseline: await watchMeasurements(
        contextRoots.baseline,
        'baseline',
        contextCompilerFor,
        'raw0',
        CONTEXT_MEASUREMENTS,
      ),
      typescript: await watchMeasurements(
        contextRoots.typescript,
        'typescript',
        contextCompilerFor,
        'raw0',
        CONTEXT_MEASUREMENTS,
      ),
      native: await watchMeasurements(
        contextRoots.native,
        'native',
        contextCompilerFor,
        'raw0',
        CONTEXT_MEASUREMENTS,
      ),
    };
    console.table({
      contextCold: contextColdMedians,
      contextWatch: contextWatchMedians,
    });
    for (const implementation of ['typescript', 'native']) {
      const coldRatio =
        contextColdMedians[implementation] / contextColdMedians.baseline;
      const watchRatio =
        contextWatchMedians[implementation] / contextWatchMedians.baseline;
      if (coldRatio > 1.3 || watchRatio > 1.3) {
        throw new Error(
          `${implementation} context exceeded 1.30x baseline (cold ${coldRatio.toFixed(2)}x, watch ${watchRatio.toFixed(2)}x)`,
        );
      }
    }

    printComparison('Overall TypeScript vs native', {
      'snapshot + transform': transformerStages.macroPipeline,
      'snapshot + transform + compile': transformerStages.fullPipeline,
      'webpack cold / JS compiler': {
        typescript: coldMedians.typescript,
        native: coldMedians.native,
      },
      'webpack watch / JS compiler': {
        typescript: watchMedians.typescript,
        native: watchMedians.native,
      },
      'webpack cold / native compiler': {
        typescript: nativePipeline.coldTypeScript,
        native: nativePipeline.coldNative,
      },
      'webpack watch / native compiler': {
        typescript: nativePipeline.watchTypeScript,
        native: nativePipeline.watchRustSnapshot,
      },
      'context cold / JS compiler': {
        typescript: contextColdMedians.typescript,
        native: contextColdMedians.native,
      },
      'context watch / JS compiler': {
        typescript: contextWatchMedians.typescript,
        native: contextWatchMedians.native,
      },
    });
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
