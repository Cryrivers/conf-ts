const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const webpack = require('webpack');

const {
  ConfTsWebpackPlugin,
  NativeMacroTransformPlugin,
  TypeScriptMacroTransformPlugin,
} = require('../dist/cjs/index.js');

const MODULE_COUNT = 120;
const MEASUREMENTS = 5;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
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

function compilerFor(root, implementation) {
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

async function coldMeasurement(root, implementation) {
  const compiler = compilerFor(root, implementation);
  try {
    return await runCompiler(compiler);
  } finally {
    await closeCompiler(compiler);
  }
}

async function verifySingleAnalysis(root, implementation) {
  const typescript = require('@conf-ts/macro-transformer');
  const native = require('@conf-ts/macro-transformer-native');
  const transformer = implementation === 'native' ? native : typescript;
  const originalSnapshot = typescript.createMacroProjectSnapshot;
  const originalBatch = transformer.transformProject;
  let snapshots = 0;
  let batches = 0;
  typescript.createMacroProjectSnapshot = (...args) => {
    snapshots++;
    return originalSnapshot(...args);
  };
  transformer.transformProject = (...args) => {
    batches++;
    return originalBatch(...args);
  };
  const compiler = compilerFor(root, implementation);
  try {
    await runCompiler(compiler);
  } finally {
    await closeCompiler(compiler);
    typescript.createMacroProjectSnapshot = originalSnapshot;
    transformer.transformProject = originalBatch;
  }
  if (snapshots !== 1 || batches !== 1) {
    throw new Error(
      `${implementation}: expected one snapshot and one batch, got ${snapshots}/${batches}`,
    );
  }
}

async function watchMeasurements(root, implementation) {
  const compiler = compilerFor(root, implementation);
  const values = [];
  try {
    await runCompiler(compiler);
    for (let index = 0; index < MEASUREMENTS; index++) {
      fs.writeFileSync(
        path.join(root, 'helper-0.js'),
        `export const raw = ${JSON.stringify(`watch-${index}`)};`,
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
  writeFixture(roots.baseline, false);
  writeFixture(roots.typescript, true);
  writeFixture(roots.native, true);
  try {
    await coldMeasurement(roots.baseline, 'baseline');
    await coldMeasurement(roots.typescript, 'typescript');
    await coldMeasurement(roots.native, 'native');
    await verifySingleAnalysis(roots.typescript, 'typescript');
    await verifySingleAnalysis(roots.native, 'native');

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
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
