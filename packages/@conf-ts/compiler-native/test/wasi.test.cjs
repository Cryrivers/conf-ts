const assert = require('node:assert/strict');
const test = require('node:test');

const { compile, compileInMemory } = require('../compiler-native.wasi.cjs');

test('compiles injected source without filesystem access', () => {
  const filename = '/virtual/config.ts';
  const result = compile(
    { filename, code: 'export default { answer: 40 + 2 };' },
    'json',
  );

  assert.deepEqual(JSON.parse(result.output), { answer: 42 });
  assert.deepEqual(result.dependencies, [filename]);
});

test('resolves in-memory aliases from compilerOptions', () => {
  const result = compileInMemory(
    {
      '/virtual/index.ts':
        "import { answer } from '@/answer'; export default { answer };",
      '/virtual/src/answer.ts': 'export const answer = 42;',
    },
    '/virtual/index.ts',
    'json',
    {
      compilerOptions: {
        baseUrl: '/virtual',
        paths: { '@/*': ['src/*'] },
      },
    },
  );

  assert.deepEqual(JSON.parse(result.output), { answer: 42 });
});
