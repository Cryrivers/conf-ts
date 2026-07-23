import { performance } from 'node:perf_hooks';

import { diffProjects } from './dist/index.mjs';

const project = code => ({
  filename: '/bench/config.conf.ts',
  code,
  files: { '/bench/config.conf.ts': code },
});

function measure(label, left, right, options) {
  const started = performance.now();
  const report = diffProjects(project(left), project(right), options);
  const elapsed = performance.now() - started;
  console.log(
    `${label.padEnd(28)} ${elapsed.toFixed(1).padStart(8)} ms  ${String(
      report.changes.length,
    ).padStart(6)} changes  ${report.diagnostics
      .map(diagnostic => diagnostic.code)
      .join(',')}`,
  );
  return report;
}

const objectSize = 10_000;
const objectBefore = `export default {${Array.from(
  { length: objectSize },
  (_, index) => `k${index}:${index}`,
).join(',')}}`;
const objectAfter = objectBefore.replace(
  `k${objectSize - 1}:${objectSize - 1}`,
  `k${objectSize - 1}:${objectSize}`,
);
measure('10k-node object', objectBefore, objectAfter);

const arraySize = 5_000;
const arrayValues = Array.from(
  { length: arraySize },
  (_, index) => `{id:'service-${index}',port:${index}}`,
);
const keyedBefore = `export default [${arrayValues.join(',')}]`;
const keyedAfter = `export default [${[
  ...arrayValues.slice(1),
  arrayValues[0],
].join(',')}]`;
const keyed = measure('5k keyed array move', keyedBefore, keyedAfter);
if (keyed.diagnostics.some(diagnostic => diagnostic.code === 'matching-degraded')) {
  throw new Error('Keyed matching unexpectedly exceeded its work budget.');
}

const ambiguousBefore = `export default [${Array.from(
  { length: arraySize },
  (_, index) => `{value:${index}}`,
).join(',')}]`;
const ambiguousAfter = `export default [${Array.from(
  { length: arraySize },
  (_, index) => `{value:${arraySize - index}}`,
).join(',')}]`;
const fallback = measure('5k bounded fallback', ambiguousBefore, ambiguousAfter, {
  maxMatchWork: 1_000,
});
if (
  !fallback.diagnostics.some(
    diagnostic => diagnostic.code === 'matching-degraded',
  )
) {
  throw new Error('Fallback benchmark did not exercise budget degradation.');
}
