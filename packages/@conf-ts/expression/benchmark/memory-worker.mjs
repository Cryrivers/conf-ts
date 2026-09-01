import v8 from 'node:v8';

import expression, { compile } from '../dist/index.mjs';

const [, , phase, mode] = process.argv;

if (!['retained', 'allocation'].includes(phase)) {
  throw new Error(`Unknown memory benchmark phase: ${phase}`);
}
if (!['interpreter', 'compiled'].includes(mode)) {
  throw new Error(`Unknown memory benchmark mode: ${mode}`);
}
if (typeof globalThis.gc !== 'function') {
  throw new Error('Run this worker with --expose-gc');
}

const forceGc = () => {
  // Multiple passes make weak references and code flushing settle before the
  // snapshot. Each execution mode runs in a fresh process, so this does not
  // give either mode access to the other mode's expression cache.
  for (let pass = 0; pass < 5; pass++) globalThis.gc();
};

const snapshot = () => {
  const memory = process.memoryUsage();
  const code = v8.getHeapCodeStatistics();
  return {
    heapUsed: memory.heapUsed,
    rss: memory.rss,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    codeAndMetadata: code.code_and_metadata_size,
    bytecodeAndMetadata: code.bytecode_and_metadata_size,
    externalScriptSource: code.external_script_source_size,
  };
};

const diff = (after, before) =>
  Object.fromEntries(
    Object.keys(after).map(key => [key, after[key] - before[key]]),
  );

const warmFactories = () => {
  expression('warmValue + 1')({ warmValue: 1 });
  compile('warmValue + 1', { strict: true })({ warmValue: 1 });
};

const runRetained = () => {
  const count = 1_000;
  const factory =
    mode === 'compiled'
      ? source => compile(source, { strict: true })
      : source => expression(source);

  // Include the same one-time module and factory initialization in the
  // baseline for both modes. The measured expressions themselves are unique.
  warmFactories();
  forceGc();
  const baseline = snapshot();
  let peakHeapUsed = baseline.heapUsed;
  let peakRss = baseline.rss;

  const functions = new Array(count);
  for (let index = 0; index < count; index++) {
    functions[index] = factory(`value * weight + ${index}`);
    if ((index + 1) % 25 === 0) {
      const memory = process.memoryUsage();
      peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
    }
  }

  // Keep every returned function live even if the package LRU later evicts it.
  globalThis.__confTsMemoryFunctions = functions;
  forceGc();
  const constructed = snapshot();

  const environment = { value: 2, weight: 3 };
  let checksum = 0;
  for (const fn of functions) checksum += fn(environment);
  globalThis.__confTsMemoryChecksum = checksum;
  forceGc();
  const invoked = snapshot();

  return {
    phase,
    mode,
    count,
    constructed: diff(constructed, baseline),
    invoked: diff(invoked, baseline),
    peak: {
      heapUsed: peakHeapUsed - baseline.heapUsed,
      rss: peakRss - baseline.rss,
    },
    checksum,
  };
};

const callbackSource =
  'items.filter(item => item.active && item.score >= threshold).map(item => item.score * weight).reduce((sum, value) => sum + value, 0)';

const runAllocation = () => {
  const iterations = 1_000;
  const interpreted = expression(callbackSource);
  const compiled = compile(callbackSource, { strict: true });
  const fn = mode === 'compiled' ? compiled : interpreted;
  const environment = {
    items: Array.from({ length: 20 }, (_, index) => ({
      active: index % 3 !== 0,
      score: index,
    })),
    threshold: 5,
    weight: 2,
  };

  let checksum = 0;
  for (let index = 0; index < 10_000; index++) checksum += fn(environment);
  forceGc();
  const before = snapshot();

  // No explicit GC occurs inside this batch. The parent gives the worker a
  // large young generation so the heap delta is a useful allocation estimate.
  for (let index = 0; index < iterations; index++) checksum += fn(environment);
  const after = snapshot();
  globalThis.__confTsMemoryChecksum = checksum;

  return {
    phase,
    mode,
    iterations,
    growth: diff(after, before),
    checksum,
  };
};

const result = phase === 'retained' ? runRetained() : runAllocation();
process.stdout.write(`${JSON.stringify(result)}\n`);
