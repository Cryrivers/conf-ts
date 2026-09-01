import assert from 'node:assert/strict';

import expression, { compile } from '../dist/index.mjs';

// Methodology follows Zod 4.5's compile-matrix benchmark: validate correctness
// first, warm both paths, interleave measurements to reduce drift, and retain
// the fastest round as the closest approximation of the machine's noise floor.
const cases = [
  {
    name: 'arithmetic',
    source: 'subtotal * (1 + taxRate) - discount',
    envs: [
      { subtotal: 100, taxRate: 0.08, discount: 4 },
      { subtotal: 240, taxRate: 0.12, discount: 10 },
    ],
    iterations: 500_000,
  },
  {
    name: 'deep member access',
    source:
      'account.profile.metrics.score * weights.primary + account.profile.metrics.rank',
    envs: [
      {
        account: { profile: { metrics: { score: 42, rank: 3 } } },
        weights: { primary: 2 },
      },
      {
        account: { profile: { metrics: { score: 51, rank: 4 } } },
        weights: { primary: 3 },
      },
    ],
    iterations: 300_000,
  },
  {
    name: 'wide expression (20 values)',
    source: Array.from({ length: 20 }, (_, index) => `v${index}`).join(' + '),
    envs: [
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`v${index}`, index]),
      ),
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`v${index}`, index + 1]),
      ),
    ],
    iterations: 200_000,
  },
  {
    name: 'filter/map/reduce callbacks',
    source:
      'items.filter(item => item.active && item.score >= threshold).map(item => item.score * weight).reduce((sum, value) => sum + value, 0)',
    envs: [
      {
        items: Array.from({ length: 20 }, (_, index) => ({
          active: index % 3 !== 0,
          score: index,
        })),
        threshold: 5,
        weight: 2,
      },
      {
        items: Array.from({ length: 20 }, (_, index) => ({
          active: index % 4 !== 0,
          score: index + 1,
        })),
        threshold: 8,
        weight: 3,
      },
    ],
    iterations: 20_000,
  },
  {
    name: 'object/array/template construction',
    source:
      '{ ...base, label: `${prefix}-${id}`, values: [first, ...rest, last], [dynamicKey]: total }',
    envs: [
      {
        base: { enabled: true },
        prefix: 'item',
        id: 1,
        first: 0,
        rest: [1, 2, 3],
        last: 4,
        dynamicKey: 'sum',
        total: 10,
      },
      {
        base: { enabled: false },
        prefix: 'entry',
        id: 2,
        first: 5,
        rest: [6, 7, 8],
        last: 9,
        dynamicKey: 'total',
        total: 35,
      },
    ],
    iterations: 60_000,
  },
];

const sink = new Array(8);

const measureBatch = (fn, envs, iterations) => {
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index++) {
    sink[index & 7] = fn(envs[index & 1]);
  }
  return Number(process.hrtime.bigint() - started) / iterations;
};

const measurePair = (interpreted, compiled, envs, iterations) => {
  for (let index = 0; index < 5_000; index++) {
    sink[index & 7] = interpreted(envs[index & 1]);
    sink[index & 7] = compiled(envs[index & 1]);
  }

  let interpretedBest = Number.POSITIVE_INFINITY;
  let compiledBest = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 8; round++) {
    if (round % 2 === 0) {
      interpretedBest = Math.min(
        interpretedBest,
        measureBatch(interpreted, envs, iterations),
      );
      compiledBest = Math.min(
        compiledBest,
        measureBatch(compiled, envs, iterations),
      );
    } else {
      compiledBest = Math.min(
        compiledBest,
        measureBatch(compiled, envs, iterations),
      );
      interpretedBest = Math.min(
        interpretedBest,
        measureBatch(interpreted, envs, iterations),
      );
    }
  }
  return { interpretedBest, compiledBest };
};

console.log(`Node ${process.version} · ${process.platform}/${process.arch}`);
console.log('| case | interpreter | compiled | speedup |');
console.log('| --- | ---: | ---: | ---: |');

for (const benchmark of cases) {
  const interpreted = expression(benchmark.source);
  const compiled = compile(benchmark.source, { strict: true });
  for (const env of benchmark.envs) {
    assert.deepStrictEqual(compiled(env), interpreted(env));
  }

  const result = measurePair(
    interpreted,
    compiled,
    benchmark.envs,
    benchmark.iterations,
  );
  console.log(
    `| ${benchmark.name} | ${result.interpretedBest.toFixed(1)} ns/op | ${result.compiledBest.toFixed(1)} ns/op | ${(result.interpretedBest / result.compiledBest).toFixed(2)}x |`,
  );
}

const constructionBatch = (factory, offset, count) => {
  const started = process.hrtime.bigint();
  for (let index = 0; index < count; index++) {
    sink[index & 7] = factory(
      `compileInput + ${offset + index} * compileWeight`,
    );
  }
  return Number(process.hrtime.bigint() - started) / count;
};

let interpretedConstruction = Number.POSITIVE_INFINITY;
let compiledConstruction = Number.POSITIVE_INFINITY;
for (let round = 0; round < 5; round++) {
  const offset = round * 2_000;
  interpretedConstruction = Math.min(
    interpretedConstruction,
    constructionBatch(expression, offset, 200),
  );
  compiledConstruction = Math.min(
    compiledConstruction,
    constructionBatch(
      source => compile(source, { strict: true }),
      offset + 1_000,
      200,
    ),
  );
}

console.log('');
console.log('| cold construction | time |');
console.log('| --- | ---: |');
console.log(
  `| parse + interpreter closure | ${interpretedConstruction.toFixed(1)} ns/expression |`,
);
console.log(
  `| parse + code generation | ${compiledConstruction.toFixed(1)} ns/expression |`,
);
