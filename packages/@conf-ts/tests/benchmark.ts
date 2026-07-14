import * as path from 'path';
import { Bench } from 'tinybench';

import { compileJsWithMacro, compileNativeWithMacro } from './test-utils';

const configPath = path.resolve(
  __dirname,
  'fixtures/specs/complex-types.conf.ts',
);

const bench = new Bench({ time: 2000 });

bench
  .add('compiler (JS)', () => {
    compileJsWithMacro(configPath, 'json', { macroMode: true });
  })
  .add('compiler-native (Rust)', () => {
    compileNativeWithMacro(configPath, 'json', { macroMode: true });
  });

async function run() {
  console.log(`Running benchmark on ${path.basename(configPath)}...`);
  await bench.run();

  console.table(bench.table());
}

run().catch(console.error);
