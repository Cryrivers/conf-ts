import { compile } from '@conf-ts/compiler';

interface WorkerInput {
  resourcePath: string;
  format: 'json' | 'yaml';
  options: {
    macro?: boolean;
    preserveKeyOrder?: boolean;
  };
}

export default function (message: WorkerInput) {
  const { resourcePath, format, options } = message;
  return compile(resourcePath, format, options);
}
