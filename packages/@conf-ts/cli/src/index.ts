#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { compile } from '@conf-ts/compiler';
import {
  createMacroProjectSnapshot,
  transformProject,
} from '@conf-ts/macro-transformer';
import { Command } from 'commander';

const program = new Command();

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
  .option('--quote <style>', 'String quote style for expr output.', 'double')
  .action((fileEntry, options) => {
    const { format, macro, preserveOrder, quote } = options;

    if (format !== 'json' && format !== 'yaml') {
      console.error(
        'Error: Invalid format. Supported formats are "json" and "yaml".',
      );
      process.exit(1);
    }

    try {
      const compileOptions = {
        preserveKeyOrder: preserveOrder,
      };
      let result: string;
      if (macro) {
        const filename = path.resolve(fileEntry);
        const code = fs.readFileSync(filename, 'utf8');
        const project = createMacroProjectSnapshot([filename]);
        const projectWithInput = {
          ...project,
          files: {
            ...project.files,
            [filename]: code,
          },
        };
        const transformOptions = {
          preserveKeyOrder: preserveOrder,
          quote,
        };
        const batch = transformProject(
          { project: projectWithInput },
          transformOptions,
        );
        const transformedFiles = { ...projectWithInput.files };
        for (const [projectFilename, transformed] of Object.entries(
          batch.transformed,
        )) {
          transformedFiles[projectFilename] = transformed.code;
        }
        const transformedProject = {
          ...projectWithInput,
          files: transformedFiles,
        };
        result = compile(
          {
            filename,
            code: transformedFiles[filename],
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
