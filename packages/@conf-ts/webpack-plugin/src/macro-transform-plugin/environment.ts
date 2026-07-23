import { createHash } from 'crypto';
import type { Compiler } from 'webpack';

const environmentsByCompiler = new WeakMap<object, Record<string, string>>();

// Deliberately does not import @conf-ts/macro-transformer's equivalent
// helper: this module must stay free of that (and its TypeScript)
// dependency so the native loader path doesn't pull in the JS transformer.
function processEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function freezeCompilerEnvironment(compiler: Compiler): string {
  const environment = processEnvironment();
  environmentsByCompiler.set(compiler, environment);
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(environment).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    )
    .digest('hex');
}

export function environmentForCompiler(
  compiler: object | undefined,
): Record<string, string> {
  return (
    (compiler && environmentsByCompiler.get(compiler)) ?? processEnvironment()
  );
}
