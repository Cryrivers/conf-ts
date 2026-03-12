import * as path from 'path';
import { compile as compileJs } from '@conf-ts/compiler';
import { compile as compileNative } from '@conf-ts/compiler-native';
import { Bench } from 'tinybench';

const configPath = path.resolve(
  __dirname,
  'fixtures/specs/complex-types.conf.ts',
);

const bench = new Bench({ time: 2000 });

bench
  .add('compiler (JS)', () => {
    compileJs(configPath, 'json', { macroMode: true });
  })
  .add('compiler-native (Rust)', () => {
    compileNative(configPath, 'json', { macroMode: true });
  });

async function run() {
  console.log(`Running benchmark on ${path.basename(configPath)}...`);
  await bench.run();

  console.table(bench.table());
}

run().catch(console.error);
