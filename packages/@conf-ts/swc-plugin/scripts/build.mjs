import { spawnSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const debug = process.argv.includes('--debug');
const profile = debug ? 'debug' : 'release';
const cargoArgs = ['build', '--target', 'wasm32-wasip1'];
if (!debug) cargoArgs.push('--release');

const build = spawnSync('cargo', cargoArgs, {
  cwd: packageDirectory,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const artifact = resolve(
  packageDirectory,
  '..',
  'target',
  'wasm32-wasip1',
  profile,
  'conf_ts_swc_plugin.wasm',
);
await copyFile(artifact, resolve(packageDirectory, 'conf_ts_swc_plugin.wasm'));
