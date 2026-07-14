import { compile } from '@conf-ts/compiler';
import { compile as compileWithMacro } from '@conf-ts/macro-transformer';
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
    'Enable macro mode for compile-time transformations.',
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
        quote,
        jsxOutput: parsedJsxOutput,
      };
      const { output: result } = macro
        ? compileWithMacro(fileEntry, format, compileOptions)
        : compile(fileEntry, format, compileOptions);
      console.log(result);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
