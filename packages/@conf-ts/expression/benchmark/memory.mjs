import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./memory-worker.mjs', import.meta.url));
const modes = ['interpreter', 'compiled'];

const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const collect = (phase, mode, samples) => {
  const results = [];
  for (let sample = 0; sample < samples; sample++) {
    const child = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        '--max-semi-space-size=64',
        '--no-warnings',
        worker,
        phase,
        mode,
      ],
      { encoding: 'utf8' },
    );

    if (child.status !== 0) {
      throw new Error(
        `Memory worker failed (${phase}/${mode}):\n${child.stderr || child.stdout}`,
      );
    }
    results.push(JSON.parse(child.stdout));
  }
  return results;
};

const medianPath = (samples, ...path) =>
  median(
    samples.map(sample =>
      path.reduce((value, segment) => value[segment], sample),
    ),
  );

const formatBytes = bytes => {
  const sign = bytes < 0 ? '-' : '';
  const absolute = Math.abs(bytes);
  if (absolute >= 1024 * 1024) {
    return `${sign}${(absolute / (1024 * 1024)).toFixed(2)} MiB`;
  }
  if (absolute >= 1024) return `${sign}${(absolute / 1024).toFixed(2)} KiB`;
  return `${sign}${absolute.toFixed(0)} B`;
};

const retained = Object.fromEntries(
  modes.map(mode => [mode, collect('retained', mode, 7)]),
);
const allocations = Object.fromEntries(
  modes.map(mode => [mode, collect('allocation', mode, 9)]),
);

console.log(`Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(
  'Median of fresh --expose-gc processes; retained samples hold 1,000 unique expressions.',
);
console.log('');
console.log(
  '| mode | heap after construction | heap after first evaluation | heap ratio | V8 code + metadata | V8 bytecode + metadata | RSS delta | peak construction heap |',
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

const interpreterRetainedHeap =
  medianPath(retained.interpreter, 'invoked', 'heapUsed') /
  retained.interpreter[0].count;

for (const mode of modes) {
  const samples = retained[mode];
  const count = samples[0].count;
  const retainedHeap = medianPath(samples, 'invoked', 'heapUsed') / count;
  console.log(
    `| ${mode} | ${formatBytes(medianPath(samples, 'constructed', 'heapUsed') / count)}/expr | ${formatBytes(retainedHeap)}/expr | ${(retainedHeap / interpreterRetainedHeap).toFixed(2)}x | ${formatBytes(medianPath(samples, 'invoked', 'codeAndMetadata') / count)}/expr | ${formatBytes(medianPath(samples, 'invoked', 'bytecodeAndMetadata') / count)}/expr | ${formatBytes(medianPath(samples, 'invoked', 'rss'))} | ${formatBytes(medianPath(samples, 'peak', 'heapUsed'))} |`,
  );
}

console.log('');
console.log(
  '| callback workload | temporary heap growth | interpreter-relative |',
);
console.log('| --- | ---: | ---: |');
const interpreterAllocation =
  medianPath(allocations.interpreter, 'growth', 'heapUsed') /
  allocations.interpreter[0].iterations;
for (const mode of modes) {
  const samples = allocations[mode];
  const bytesPerEvaluation =
    medianPath(samples, 'growth', 'heapUsed') / samples[0].iterations;
  console.log(
    `| ${mode} | ${formatBytes(bytesPerEvaluation)}/evaluation | ${(bytesPerEvaluation / interpreterAllocation).toFixed(2)}x |`,
  );
}

console.log('');
console.log(
  'Retained rows are GC-settled deltas from an equally warmed baseline. V8 code/bytecode counters overlap process memory and must not be added to heap or RSS.',
);
console.log(
  'Temporary heap growth is a pre-GC allocation estimate over 1,000 hot filter/map/reduce evaluations in a 64 MiB young generation; it is not retained memory.',
);
