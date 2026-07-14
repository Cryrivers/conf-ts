#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { compile } from '@conf-ts/compiler';
import {
  createMacroProjectSnapshot,
  transform,
} from '@conf-ts/macro-transformer';
import { Command } from 'commander';

const program = new Command();

function snapshotEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

program
  .name('conf-ts')
  .description(
    'A command-line tool to compile a subset of TypeScript files into JSON or YAML.',
  )
  .version('0.0.1');

program
  .argument('<fileEntry>', 'Path to the TypeScript configuration file.')
  .option('-f, --format <type>', 'Output format: json or yaml', 'json')
  .option(
    '-m, --macro',
    'Expand @conf-ts/macro calls before ordinary compilation.',
    false,
  )
  .option('-p, --preserve-order', 'Preserve object key order in output.', false)
  .option('--jsx', 'Enable JSX support.', false)
  .option('--quote <style>', 'String quote style for expr output.', 'double')
  .option(
    '--jsx-output <json>',
    'Configure JSX output fields as a JSON object.',
  )
  .action((fileEntry, options) => {
    const { format, macro, preserveOrder, quote, jsx, jsxOutput } = options;

    if (format !== 'json' && format !== 'yaml') {
      console.error(
        'Error: Invalid format. Supported formats are "json" and "yaml".',
      );
      process.exit(1);
    }

    try {
      const parsedJsxOutput =
        jsxOutput === undefined ? undefined : JSON.parse(jsxOutput);
      if (
        parsedJsxOutput !== undefined &&
        (parsedJsxOutput === null ||
          typeof parsedJsxOutput !== 'object' ||
          Array.isArray(parsedJsxOutput))
      ) {
        throw new Error('jsx-output must be a JSON object.');
      }
      const compileOptions = {
        preserveKeyOrder: preserveOrder,
        jsx,
        jsxOutput: parsedJsxOutput,
      };
      let result: string;
      if (macro) {
        const filename = path.resolve(fileEntry);
        const code = fs.readFileSync(filename, 'utf8');
        const project = createMacroProjectSnapshot([filename]);
        let transformedProject = {
          ...project,
          files: {
            ...project.files,
            [filename]: code,
          },
        };
        const transformOptions = {
          env: snapshotEnvironment(),
          preserveKeyOrder: preserveOrder,
          jsx,
          quote,
          jsxOutput: parsedJsxOutput,
        };
        let transformedEntry = code;
        const files = Object.entries(transformedProject.files).sort(
          ([left], [right]) =>
            Number(left === filename) - Number(right === filename),
        );
        for (const [projectFilename, projectCode] of files) {
          if (projectFilename.endsWith('.d.ts')) {
            continue;
          }
          const transformed = transform(
            {
              filename: projectFilename,
              code: projectCode,
              project: transformedProject,
            },
            transformOptions,
          );
          transformedProject = {
            ...transformedProject,
            files: {
              ...transformedProject.files,
              [projectFilename]: transformed.code,
            },
          };
          if (projectFilename === filename) {
            transformedEntry = transformed.code;
          }
        }
        result = compile(
          {
            filename,
            code: transformedEntry,
            project: transformedProject,
          },
          format,
          compileOptions,
        ).output;
      } else {
        result = compile(fileEntry, format, compileOptions).output;
      }
      console.log(result);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
