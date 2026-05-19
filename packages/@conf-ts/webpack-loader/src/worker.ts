import { compile, type CompileOptions } from '@conf-ts/compiler';

interface WorkerInput {
  resourcePath: string;
  format: 'json' | 'yaml';
  options: CompileOptions;
}

export default function (message: WorkerInput) {
  const { resourcePath, format, options } = message;
  return compile(resourcePath, format, options);
}
