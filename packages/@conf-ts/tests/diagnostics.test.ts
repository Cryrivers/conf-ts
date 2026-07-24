import path from 'path';
import {
  compileInMemory as compileInMemoryTs,
  compile as compileTs,
  ConfTSError,
  suggestionsForError,
} from '@conf-ts/compiler';
import {
  compileInMemory as compileInMemoryNative,
  compile as compileNative,
} from '@conf-ts/compiler-native';
import {
  transformProject as transformProjectTs,
  type MacroProjectSnapshot,
} from '@conf-ts/macro-transformer';
import { transformProject as transformProjectNative } from '@conf-ts/macro-transformer-native';
import { describe, expect, it } from 'vitest';

const FIXTURE = path.resolve(__dirname, 'fixtures/diagnostics');
const ENTRY = path.join(FIXTURE, 'entry.ts');
const BROKEN = path.join(FIXTURE, 'broken.ts');
const LAYER_ONE = path.join(FIXTURE, 'layer-one.ts');
const LAYER_TWO = path.join(FIXTURE, 'layer-two.ts');

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to throw');
}

describe('Detailed diagnostics', () => {
  it('reports the root source line and the complete re-export chain in TS and native', () => {
    const tsError = thrown(() => compileTs(ENTRY, 'json'));
    expect(tsError).toBeInstanceOf(ConfTSError);
    const diagnostic = tsError as ConfTSError;
    expect(diagnostic.location).toMatchObject({
      file: BROKEN,
      line: 5,
      character: 12,
      sourceLine: "    value: new Date('2026-01-01'),",
    });
    expect(diagnostic.references.map(reference => reference.location)).toEqual([
      expect.objectContaining({ file: LAYER_TWO, line: 1 }),
      expect.objectContaining({ file: LAYER_ONE, line: 1 }),
      expect.objectContaining({ file: ENTRY, line: 4, character: 12 }),
    ]);
    expect(diagnostic.toString()).toContain(`at ${BROKEN}:5:12`);
    expect(diagnostic.toString()).toContain('5 |     value: new Date');
    expect(diagnostic.toString()).toContain(`referenced from ${ENTRY}:4:12`);
    expect(diagnostic.suggestions.map(value => value.message)).toContain(
      'Replace `new Date(...)` with an ISO date string or a numeric timestamp.',
    );
    expect(
      suggestionsForError(
        "expr callback: a nested function's parameter cannot shadow the context parameter 'ctx'",
      ).map(value => value.message),
    ).toContain(
      'Rename the nested callback parameter so it differs from the outer expression context, for example `item => item < 5`.',
    );
    expect(diagnostic.toString()).toContain('Suggested fixes:');
    expect(diagnostic.toString()).toContain('1. Replace `new Date(...)`');
    expect(diagnostic.stack).toContain(`referenced from ${ENTRY}:4:12`);

    const nativeError = thrown(() => compileNative(ENTRY, 'json'));
    expect(nativeError).toBeInstanceOf(Error);
    const nativeMessage = (nativeError as Error).message;
    expect(nativeMessage).toContain(`at ${BROKEN}:5:12`);
    expect(nativeMessage).toContain(`referenced from ${LAYER_TWO}:1:`);
    expect(nativeMessage).toContain(`referenced from ${LAYER_ONE}:1:`);
    expect(nativeMessage).toContain(`referenced from ${ENTRY}:4:12`);
    expect(nativeMessage).toContain('5 |     value: new Date');
    expect(nativeMessage).toContain('Suggested fixes:');
    expect(nativeMessage).toContain('1. Replace `new Date(...)`');
  });

  it('reports parser details and the exact source line in both compilers', () => {
    const files = {
      '/invalid.ts': [
        'export default {',
        '  nested: {',
        '    value:,',
        '  },',
        '};',
      ].join('\n'),
    };

    const tsError = thrown(() =>
      compileInMemoryTs(files, '/invalid.ts', 'json'),
    );
    expect(tsError).toBeInstanceOf(ConfTSError);
    expect((tsError as ConfTSError).toString()).toContain(
      'Failed to parse file:',
    );
    expect((tsError as ConfTSError).toString()).toContain('at /invalid.ts:3:');
    expect((tsError as ConfTSError).toString()).toContain('3 |     value:,');
    expect((tsError as ConfTSError).toString()).toContain(
      'Check the highlighted line for a missing or extra comma',
    );

    const nativeError = thrown(() =>
      compileInMemoryNative(files, '/invalid.ts', 'json'),
    );
    expect((nativeError as Error).message).toContain('Failed to parse file:');
    expect((nativeError as Error).message).toContain('at /invalid.ts:3:');
    expect((nativeError as Error).message).toContain('3 |     value:,');
    expect((nativeError as Error).message).toContain(
      'Check the highlighted line for a missing or extra comma',
    );
  });

  it('preserves detailed parser diagnostics in both macro transformers', () => {
    const filename = '/invalid-macro.ts';
    const source = [
      "import { String } from '@conf-ts/macro';",
      'export default {',
      '  value:,',
      '};',
    ].join('\n');
    const project: MacroProjectSnapshot = {
      files: { [filename]: source },
      resolutions: {},
      compilerOptions: {},
      entryFiles: [filename],
      dependencies: [filename],
    };

    const tsError = thrown(() =>
      transformProjectTs({ project, files: [filename] }),
    );
    expect(tsError).toBeInstanceOf(ConfTSError);
    expect((tsError as ConfTSError).toString()).toContain(
      'at /invalid-macro.ts:3:',
    );
    expect((tsError as ConfTSError).toString()).toContain('3 |   value:,');

    const nativeError = thrown(() =>
      transformProjectNative({ project, files: [filename] }),
    );
    expect((nativeError as Error).message).toContain('at /invalid-macro.ts:3:');
    expect((nativeError as Error).message).toContain('3 |   value:,');
  });

  it('reports an indirect exprTemplate definition chain in both transformers', () => {
    const entry = '/project/entry.ts';
    const layerOne = '/project/layer-one.ts';
    const layerTwo = '/project/layer-two.ts';
    const definition = '/project/template.ts';
    const files = {
      [entry]: [
        "import { template } from './layer-one';",
        '',
        'export default {',
        '  value: template(1),',
        '};',
      ].join('\n'),
      [layerOne]: "export { template } from './layer-two';",
      [layerTwo]: "export { template } from './template';",
      [definition]: [
        "import { exprTemplate } from '@conf-ts/macro';",
        '',
        'export const template = exprTemplate(',
        '  ({ value }, amount) => value + amount,',
        ');',
      ].join('\n'),
    };
    const project: MacroProjectSnapshot = {
      files,
      resolutions: {
        [entry]: { './layer-one': layerOne },
        [layerOne]: { './layer-two': layerTwo },
        [layerTwo]: { './template': definition },
      },
      compilerOptions: {},
      entryFiles: [entry],
      dependencies: Object.keys(files),
    };

    const tsError = thrown(() =>
      transformProjectTs({ project, files: [entry] }),
    );
    expect(tsError).toBeInstanceOf(ConfTSError);
    const tsMessage = (tsError as ConfTSError).toString();
    expect(tsMessage).toContain(`at ${definition}:4:`);
    expect(tsMessage).toContain(`referenced from ${layerTwo}:1:`);
    expect(tsMessage).toContain(`referenced from ${layerOne}:1:`);
    expect(tsMessage).toContain(`referenced from ${entry}:4:10`);
    expect(tsMessage).toContain(
      'Replace the callback with a synchronous arrow function',
    );

    const nativeError = thrown(() =>
      transformProjectNative({ project, files: [entry] }),
    );
    const nativeMessage = (nativeError as Error).message;
    expect(nativeMessage).toContain(`at ${definition}:4:`);
    expect(nativeMessage).toContain(`referenced from ${layerTwo}:1:`);
    expect(nativeMessage).toContain(`referenced from ${layerOne}:1:`);
    expect(nativeMessage).toContain(`referenced from ${entry}:4:10`);
    expect(nativeMessage).toContain(
      'Replace the callback with a synchronous arrow function',
    );
  });
});
