import fs from 'fs';
import path from 'path';
import { compileTransformed, type CompileOptions } from '@conf-ts/compiler';
import {
  transformMacros as transformMacrosJs,
  type MacroTransformOptions,
} from '@conf-ts/macro-transformer';
import { transformMacros as transformMacrosNative } from '@conf-ts/macro-transformer-native';
import { describe, expect, it } from 'vitest';

const MACRO_DIR = path.resolve(__dirname, 'fixtures/macros');

// Fixtures that need non-default options or environment variables to
// compile successfully — mirrors the setup in macro.test.ts/macro-expr-compiler.test.ts.
const FIXTURE_OPTIONS: Record<string, CompileOptions> = {
  'expr-quote-single': { quote: 'single' },
};

function setUpEnv() {
  process.env.CONF_TS_FOO = 'foo';
  process.env.CONF_TS_BAR = 'bar';
  process.env.CONF_TS_EXISTS = 'exists';
  delete process.env.CONF_TS_MISSING;
  delete process.env.CONF_TS_EXPR_MACRO_MODE;
}

// Every macro fixture that has a checked-in JSON expectation is a
// success-path fixture; the rest (expr-invalid-*, invalid-*, partial-imports)
// are error-path fixtures already covered by macro.test.ts/macro-expr-compiler.test.ts.
const fixtureNames = fs
  .readdirSync(MACRO_DIR)
  .filter(f => f.endsWith('.conf.ts'))
  .map(f => f.replace(/\.conf\.ts$/, ''))
  .filter(name => fs.existsSync(path.join(MACRO_DIR, `${name}.json`)));

describe('macro-transformer / macro-transformer-native parity', () => {
  it('found at least one fixture to check', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  it.each(fixtureNames)('%s: JS and native transformers agree', name => {
    setUpEnv();
    const inputFile = path.join(MACRO_DIR, `${name}.conf.ts`);
    const options: MacroTransformOptions = FIXTURE_OPTIONS[name] ?? {};

    const jsResult = transformMacrosJs(inputFile, options);
    const nativeResult = transformMacrosNative(inputFile, options);

    // Both transformers must rewrite the exact same set of files, with
    // byte-identical rewritten source text.
    expect(Object.keys(jsResult.files).sort()).toEqual(
      Object.keys(nativeResult.files).sort(),
    );
    for (const file of Object.keys(jsResult.files)) {
      expect(nativeResult.files[file]).toBe(jsResult.files[file]);
    }

    // Both must report the same dependency set (order-independent).
    expect([...jsResult.dependencies].sort()).toEqual(
      [...nativeResult.dependencies].sort(),
    );

    // Feeding either transform result into the ordinary constants-only
    // compiler must reproduce the pre-existing checked-in fixture output —
    // the key regression guard proving the split didn't change observable
    // behavior.
    const expectedOutput = fs
      .readFileSync(path.join(MACRO_DIR, `${name}.json`), 'utf-8')
      .replace(/\n$/, '');

    const { output: fromJsTransform } = compileTransformed(
      inputFile,
      'json',
      jsResult,
      options,
    );
    const { output: fromNativeTransform } = compileTransformed(
      inputFile,
      'json',
      nativeResult,
      options,
    );

    expect(fromJsTransform).toBe(expectedOutput);
    expect(fromNativeTransform).toBe(expectedOutput);
  });
});
