#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';

import { diff, policyFails } from './index.js';
import { renderSarif, renderTerminal } from './renderers.js';
import { renderHtml } from './report.js';
import type { DiffOptions, DiffSource } from './types.js';

interface ConfigFile extends DiffOptions {
  failOn?: 'none' | 'semantic' | 'any';
}

const TERMINAL_REVEAL = Symbol.for('@conf-ts/diff/terminal-reveal');

function collect(value: string, previous: string[]) {
  return [...previous, value];
}

function loadConfig(): ConfigFile {
  const filename = path.resolve('.conf-ts-diff.json');
  if (!fs.existsSync(filename)) return {};
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8')) as ConfigFile;
  } catch (error) {
    throw new Error(
      `Could not parse ${filename}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assignments(values: string[], name: string): Record<string, string> {
  return Object.fromEntries(
    values.map(value => {
      const separator = value.indexOf('=');
      if (separator <= 0) {
        throw new Error(`${name} must use KEY=VALUE syntax: ${value}`);
      }
      return [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
}

function parseEnvFile(filename: string | undefined): Record<string, string> {
  if (!filename) return {};
  const result: Record<string, string> = {};
  const text = fs.readFileSync(path.resolve(filename), 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function openFile(filename: string) {
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [filename]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', filename]]
        : ['xdg-open', [filename]];
  execFile(command[0], command[1], () => {});
}

function sourcePair(
  files: string[],
  from: string,
  to: string,
): [DiffSource, DiffSource] {
  if (files.length === 2) {
    return [
      { kind: 'file', path: files[0] },
      { kind: 'file', path: files[1] },
    ];
  }
  if (files.length === 1) {
    return [
      {
        kind: 'git',
        path: files[0],
        ref: from,
        label: `${from}:${files[0]}`,
      },
      {
        kind: 'git',
        path: files[0],
        ref: to,
        label: `${to}:${files[0]}`,
      },
    ];
  }
  throw new Error('Pass two files, or one repository path with --from/--to.');
}

const program = new Command()
  .name('conf-ts-diff')
  .description('Structural and evaluated diffing for conf.ts source.')
  .version('0.0.17')
  .argument('<files...>', 'Two files, or one path compared across Git refs')
  .option('--from <ref>', 'Left Git source', 'HEAD')
  .option('--to <ref>', 'Right Git source', 'worktree')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['terminal', 'json', 'sarif', 'html'])
      .default('terminal'),
  )
  .option('-o, --output <file>', 'Write output to a file')
  .option('--open', 'Open a generated HTML report')
  .addOption(
    new Option('--macro <mode>', 'Macro handling').choices([
      'auto',
      'never',
      'always',
    ]),
  )
  .option('--env <KEY=VALUE>', 'Explicit macro environment value', collect, [])
  .option('--env-file <file>', 'Load explicit macro environment values')
  .option(
    '--array-key <POINTER=FIELD>',
    'Identity field for an array path',
    collect,
    [],
  )
  .option('--ignore <pointer>', 'Ignore a JSON Pointer glob', collect, [])
  .option('--redact <pointer>', 'Redact a JSON Pointer glob', collect, [])
  .addOption(
    new Option('--fail-on <policy>', 'Exit-code policy').choices([
      'none',
      'semantic',
      'any',
    ]),
  )
  .option(
    '--allow-partial',
    'Do not fail only because evaluation is incomplete',
  )
  .option('--omit-source', 'Do not embed source in the report')
  .option(
    '--reveal-sensitive',
    'Reveal env-derived values in interactive terminal output only',
  )
  .option('--show-ignored', 'Show ignored changes in terminal output')
  .action(async (files: string[], cli) => {
    try {
      const config = loadConfig();
      if (cli.revealSensitive && cli.format !== 'terminal') {
        throw new Error(
          '--reveal-sensitive is only valid with --format terminal.',
        );
      }
      if (cli.revealSensitive && !process.stdout.isTTY) {
        throw new Error('--reveal-sensitive requires an interactive terminal.');
      }
      const env = {
        ...parseEnvFile(cli.envFile),
        ...assignments(cli.env, '--env'),
      };
      const arrayKeys = {
        ...(config.arrayKeys ?? {}),
        ...assignments(cli.arrayKey, '--array-key'),
      };
      const options: DiffOptions = {
        ...config,
        macro: {
          ...(config.macro ?? {}),
          mode: cli.macro ?? config.macro?.mode ?? 'auto',
          env: {
            ...(config.macro?.env ?? {}),
            ...env,
          },
        },
        arrayKeys,
        ignore: [...(config.ignore ?? []), ...cli.ignore],
        redact: [...(config.redact ?? []), ...cli.redact],
        includeSource: !cli.omitSource,
      };
      if (cli.revealSensitive) {
        Object.defineProperty(options, TERMINAL_REVEAL, { value: true });
      }
      const [left, right] = sourcePair(files, cli.from, cli.to);
      const report = await diff(left, right, options);
      let output: string;
      if (cli.format === 'json') {
        output = JSON.stringify(report, undefined, 2);
      } else if (cli.format === 'sarif') {
        output = renderSarif(report);
      } else if (cli.format === 'html') {
        output = renderHtml(report);
      } else {
        output = renderTerminal(report, {
          showIgnored: cli.showIgnored,
        });
      }
      let outputFile = cli.output as string | undefined;
      if (cli.format === 'html' && !outputFile) {
        outputFile = path.resolve('conf-ts-diff.html');
      }
      if (outputFile) {
        fs.writeFileSync(path.resolve(outputFile), output);
        process.stdout.write(`${path.resolve(outputFile)}\n`);
        if (cli.open && cli.format === 'html')
          openFile(path.resolve(outputFile));
      } else {
        process.stdout.write(`${output}\n`);
      }

      const hasOperationalError =
        report.diagnostics.some(item => item.severity === 'error') ||
        report.summary.evaluationStatus !== 'complete';
      if (hasOperationalError && !cli.allowPartial) {
        process.exitCode = 2;
      } else if (
        policyFails(
          report,
          cli.failOn ?? config.failOn ?? 'any',
          options.policies,
        )
      ) {
        process.exitCode = 1;
      }
    } catch (error) {
      process.stderr.write(
        `conf-ts-diff: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    }
  });

program.parseAsync(process.argv).catch(error => {
  process.stderr.write(
    `conf-ts-diff: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
