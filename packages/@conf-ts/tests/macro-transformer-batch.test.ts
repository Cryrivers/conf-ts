import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createMacroProjectSnapshot,
  transformProject as transformProjectJs,
  type MacroProjectSnapshot,
} from '@conf-ts/macro-transformer';
import { transformProject as transformProjectNative } from '@conf-ts/macro-transformer-native';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function virtualProject(): MacroProjectSnapshot {
  const macroFile = '/virtual/macro.ts';
  const valueFile = '/virtual/value.ts';
  const plainFile = '/virtual/plain.ts';
  return {
    files: {
      [macroFile]: [
        "import { String, env } from '@conf-ts/macro';",
        "import { answer } from './value';",
        "export const value = String(answer) + env('BATCH_ENV');",
      ].join('\n'),
      [valueFile]: 'export const answer = 42;',
      [plainFile]: 'export const untouched = true;',
    },
    resolutions: {
      [macroFile]: { './value': valueFile },
    },
    compilerOptions: {
      module: 99,
      moduleResolution: 100,
    },
    entryFiles: [macroFile],
    dependencies: ['/virtual/tsconfig.json', macroFile, valueFile, plainFile],
  };
}

describe('macro transform project batches', () => {
  it('rejects missing target files consistently', () => {
    const project = virtualProject();
    for (const transform of [transformProjectJs, transformProjectNative]) {
      expect(() =>
        transform({ project, files: ['/virtual/missing.ts'] }),
      ).toThrow(
        'Source file is missing from macro project: /virtual/missing.ts',
      );
    }
  });

  it('returns sparse subset results with precise per-file dependencies', () => {
    const project = virtualProject();
    const options = {
      env: { BATCH_ENV: '-frozen' },
      inheritProcessEnv: false,
    };
    const js = transformProjectJs(
      { project, files: ['/virtual/macro.ts', '/virtual/plain.ts'] },
      options,
    );
    const native = transformProjectNative(
      { project, files: ['/virtual/macro.ts', '/virtual/plain.ts'] },
      options,
    );

    expect(Object.keys(js.transformed)).toEqual(['/virtual/macro.ts']);
    expect(Object.keys(native.transformed)).toEqual(['/virtual/macro.ts']);
    expect(native.transformed['/virtual/macro.ts'].code).toBe(
      js.transformed['/virtual/macro.ts'].code,
    );
    expect(js.transformed['/virtual/macro.ts'].code).toContain(
      '"42" + "-frozen"',
    );
    expect(
      [...js.transformed['/virtual/macro.ts'].dependencies].sort(),
    ).toEqual(['/virtual/macro.ts', '/virtual/value.ts']);
    expect([...native.dependencies].sort()).toEqual(
      [...js.dependencies].sort(),
    );
    expect(js.dependencies).not.toContain('/virtual/plain.ts');
    expect(js.dependencies).not.toContain('/virtual/tsconfig.json');
  });

  it('does not inherit a changed process environment when disabled', () => {
    const previous = process.env.BATCH_ENV;
    process.env.BATCH_ENV = 'process';
    try {
      const project = virtualProject();
      for (const transform of [transformProjectJs, transformProjectNative]) {
        const result = transform(
          { project, files: ['/virtual/macro.ts'] },
          { env: { BATCH_ENV: 'explicit' }, inheritProcessEnv: false },
        );
        expect(result.transformed['/virtual/macro.ts'].code).toContain(
          '"explicit"',
        );
        expect(result.transformed['/virtual/macro.ts'].code).not.toContain(
          '"process"',
        );
      }
    } finally {
      if (previous === undefined) delete process.env.BATCH_ENV;
      else process.env.BATCH_ENV = previous;
    }
  });

  it('emits per-target source maps in both batch implementations', () => {
    const project = virtualProject();
    for (const transform of [transformProjectJs, transformProjectNative]) {
      const result = transform(
        { project, files: ['/virtual/macro.ts'] },
        {
          env: { BATCH_ENV: 'mapped' },
          inheritProcessEnv: false,
          sourceMap: true,
        },
      ).transformed['/virtual/macro.ts'];
      expect(result.map?.version).toBe(3);
      expect(result.map?.sources).toContain('/virtual/macro.ts');
      expect(result.map?.sourcesContent?.[0]).toBe(
        project.files['/virtual/macro.ts'],
      );
    }
  });

  it('omits a file after its final macro import is removed', () => {
    const project = virtualProject();
    project.files['/virtual/macro.ts'] = 'export const value = "ordinary";';
    expect(
      transformProjectJs({ project }).transformed['/virtual/macro.ts'],
    ).toBeUndefined();
    expect(
      transformProjectNative({ project }).transformed['/virtual/macro.ts'],
    ).toBeUndefined();
  });

  it('does not miss escaped macro module specifiers in the fast path', () => {
    const project = virtualProject();
    project.files['/virtual/macro.ts'] = project.files[
      '/virtual/macro.ts'
    ].replace('@conf-ts/macro', '@conf-ts/\\u006dacro');
    for (const transform of [transformProjectJs, transformProjectNative]) {
      const result = transform(
        { project, files: ['/virtual/macro.ts'] },
        { env: { BATCH_ENV: 'escaped' }, inheritProcessEnv: false },
      );
      expect(result.transformed['/virtual/macro.ts'].code).toContain(
        '"42" + "escaped"',
      );
    }
  });

  it('reuses resolutions for stable overrides and rebuilds changed imports', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'conf-ts-snapshot-'),
    );
    temporaryDirectories.push(directory);
    const entry = path.join(directory, 'entry.ts');
    const value = path.join(directory, 'value.ts');
    const added = path.join(directory, 'added.ts');
    fs.writeFileSync(
      path.join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'esnext', moduleResolution: 'bundler' },
      }),
    );
    fs.writeFileSync(
      entry,
      "import { value } from './value'; export { value };",
    );
    fs.writeFileSync(value, 'export const value = 1;');
    fs.writeFileSync(added, 'export const added = 2;');

    const initial = createMacroProjectSnapshot([entry]);
    const stable = createMacroProjectSnapshot([entry], {
      previous: initial,
      overrides: { [value]: 'export const value = 2;' },
    });
    expect(stable.resolutions).toBe(initial.resolutions);
    expect(stable.files[value]).toContain('= 2');

    const structural = createMacroProjectSnapshot([entry], {
      previous: stable,
      overrides: {
        [entry]: "import { added } from './added'; export { added };",
      },
    });
    expect(structural.resolutions).not.toBe(initial.resolutions);
    expect(structural.resolutions[entry]['./added']).toBe(added);
    expect(structural.referencedModules?.[entry]).toEqual(['./added']);
  });

  it('records unresolved candidates without loading the TypeScript standard library', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'conf-ts-missing-'),
    );
    temporaryDirectories.push(directory);
    const entry = path.join(directory, 'entry.ts');
    const config = path.join(directory, 'tsconfig.json');
    fs.writeFileSync(
      config,
      JSON.stringify({ compilerOptions: { moduleResolution: 'nodenext' } }),
    );
    fs.writeFileSync(entry, "export { missing } from './missing';");

    const snapshot = createMacroProjectSnapshot([entry]);
    expect(snapshot.referencedModules?.[entry]).toEqual(['./missing']);
    expect(snapshot.missingDependencies?.length).toBeGreaterThan(0);
    expect(
      Object.keys(snapshot.files).some(filename =>
        /lib\..*\.d\.ts$/.test(filename),
      ),
    ).toBe(false);
  });

  it('groups path aliases and NodeNext entries by their nearest tsconfig', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'conf-ts-configs-'),
    );
    temporaryDirectories.push(directory);
    const aliasRoot = path.join(directory, 'alias');
    const nodeRoot = path.join(directory, 'node');
    fs.mkdirSync(aliasRoot);
    fs.mkdirSync(nodeRoot);
    const aliasEntry = path.join(aliasRoot, 'entry.ts');
    const aliasValue = path.join(aliasRoot, 'value.ts');
    const nodeEntry = path.join(nodeRoot, 'entry.ts');
    const nodeValue = path.join(nodeRoot, 'value.ts');
    fs.writeFileSync(
      path.join(aliasRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          module: 'esnext',
          moduleResolution: 'bundler',
          paths: { '@value': ['./value.ts'] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(nodeRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
        },
      }),
    );
    fs.writeFileSync(aliasEntry, "export { value } from '@value';");
    fs.writeFileSync(aliasValue, 'export const value = 1;');
    fs.writeFileSync(nodeEntry, "export { value } from './value.js';");
    fs.writeFileSync(nodeValue, 'export const value = 2;');

    const snapshot = createMacroProjectSnapshot([aliasEntry, nodeEntry]);
    expect(snapshot.resolutions[aliasEntry]['@value']).toBe(aliasValue);
    expect(snapshot.resolutions[nodeEntry]['./value.js']).toBe(nodeValue);
    expect(snapshot.dependencies).toContain(
      path.join(aliasRoot, 'tsconfig.json'),
    );
    expect(snapshot.dependencies).toContain(
      path.join(nodeRoot, 'tsconfig.json'),
    );
  });
});
