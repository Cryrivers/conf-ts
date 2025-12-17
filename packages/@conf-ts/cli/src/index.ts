import { compile } from '@conf-ts/compiler';
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
  .action((fileEntry, options) => {
    const { format, macro, preserveOrder } = options;

    if (format !== 'json' && format !== 'yaml') {
      console.error(
        'Error: Invalid format. Supported formats are "json" and "yaml".',
      );
      process.exit(1);
    }

    try {
      const { output: result } = compile(fileEntry, format, {
        macro,
        preserveKeyOrder: preserveOrder,
      });
      console.log(result);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
