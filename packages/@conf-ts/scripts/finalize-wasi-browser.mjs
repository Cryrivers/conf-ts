import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageDirectory = process.cwd();
const packageJson = JSON.parse(
  await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
);
const binaryName = packageJson.napi?.binaryName;

if (!binaryName) {
  throw new Error('Missing napi.binaryName in package.json');
}

await writeFile(
  resolve(packageDirectory, 'browser.js'),
  [
    `export { default } from './${binaryName}.wasi-browser.js'`,
    `export * from './${binaryName}.wasi-browser.js'`,
    '',
  ].join('\n'),
);
