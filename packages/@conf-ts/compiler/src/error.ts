export interface SourceLocation {
  line: number;
  character: number;
  file?: string;
  /** The complete source line, used to render an inline code frame. */
  sourceLine?: string;
}

export interface SourceReference {
  location: SourceLocation;
  label?: string;
}

export interface DiagnosticSuggestion {
  message: string;
}

/** Return concise, actionable fixes for common configuration failures. */
export function suggestionsForError(message: string): DiagnosticSuggestion[] {
  const suggest = (...messages: string[]): DiagnosticSuggestion[] =>
    messages.map(value => ({ message: value }));

  if (message.includes('Could not find a tsconfig.json file')) {
    return suggest(
      'Add a tsconfig.json next to the configuration file or in one of its parent directories.',
      'If the file is generated or virtual, pass a project snapshot with compiler options instead.',
    );
  }
  if (
    message.includes('Failed to parse file') ||
    message.includes('parse expression error') ||
    message.includes('Failed to read tsconfig.json') ||
    message.includes('Invalid tsconfig.json') ||
    message.includes('Failed to parse tsconfig.json')
  ) {
    return suggest(
      'Check the highlighted line for a missing or extra comma, bracket, brace, parenthesis, or quote.',
      'Fix the first reported syntax error before retrying; later errors may be caused by it.',
    );
  }
  if (message.includes('No default export found')) {
    return suggest(
      'Export the final configuration with `export default { ... }`.',
      'If the value lives in another file, re-export it with `export { default } from "./file"`.',
    );
  }
  if (message.includes('Unsupported type: Date')) {
    return suggest(
      'Replace `new Date(...)` with an ISO date string or a numeric timestamp.',
      'If the date must be created at runtime, keep only its static input in the configuration.',
    );
  }
  if (message.includes('Unsupported type: Function')) {
    return suggest(
      'Configuration output cannot contain functions; export the function’s static result instead.',
      'For runtime conditions, use a supported `expr(...)` macro.',
    );
  }
  if (message.includes('Unsupported type: RegExp')) {
    return suggest(
      'Store the regular-expression pattern as a string and construct the RegExp at runtime.',
    );
  }
  if (
    message.includes("Only 'const' declarations are supported") ||
    message.includes('aliases must use const declarations')
  ) {
    return suggest(
      'Change the declaration to `const` and give it a statically evaluable initializer.',
    );
  }
  if (
    message.includes('Unsupported variable type for identifier') ||
    message.includes('Could not find symbol') ||
    message.includes('Could not resolve shorthand property')
  ) {
    return suggest(
      'Check the identifier spelling and the import path shown in the reference chain.',
      'Declare the value with `const` and initialize it with literals or other statically evaluable values.',
    );
  }
  if (
    message.includes("must be imported from '@conf-ts/macro'") ||
    message.includes('only allowed in macro mode')
  ) {
    return suggest(
      'Import the function from `@conf-ts/macro`.',
      'Enable the conf-ts macro transformer before running the compiler.',
    );
  }
  if (
    message.includes('callback must be an arrow function') ||
    message.includes('callback must be a synchronous arrow function') ||
    message.includes('expr callback must be an arrow function')
  ) {
    return suggest(
      'Replace the callback with a synchronous arrow function that has the parameter shape described by the error.',
      'Keep the callback body to a single expression when static transformation is required.',
    );
  }
  if (
    message.includes(
      "a nested function's parameter cannot shadow the context parameter",
    )
  ) {
    return suggest(
      'Rename the nested callback parameter so it differs from the outer expression context, for example `item => item < 5`.',
    );
  }
  if (
    message.includes(
      'a nested function passed as a call argument must have parameters',
    )
  ) {
    return suggest(
      'Rewrite the nested callback as a synchronous arrow function with a single-expression body, for example `item => item.id`.',
      'Use plain identifier parameters or one level of destructuring, and remove type annotations, `async`, generators, and nested patterns.',
    );
  }
  if (
    message.includes('exprTemplate arguments must be statically analyzable') ||
    message.includes('static argument')
  ) {
    return suggest(
      'Pass literals, imported constants, or values derived only from other static constants.',
      'Move runtime-dependent values into the generated expression context instead of template arguments.',
    );
  }
  if (message.includes('exprTemplate values are compile-time-only')) {
    return suggest(
      'Invoke the template directly, assign it to a `const` alias, or forward it through import/export.',
      'Do not place the template function itself in the generated configuration output.',
    );
  }
  if (message.includes('Non-null assertion')) {
    return suggest(
      'Provide a static fallback with `value ?? fallback` or remove the non-null assertion.',
      'Ensure the referenced constant cannot evaluate to `null` or `undefined`.',
    );
  }
  if (
    message.includes('env macro argument must be a string') ||
    message.includes('env macro default value must be a string')
  ) {
    return suggest(
      'Pass string literals for the environment-variable name and optional default, for example `env("PORT", "3000")`.',
    );
  }
  if (
    message.includes('expr callback cannot use the context parameter directly')
  ) {
    return suggest(
      'Access a property of the context, such as `ctx.userId`, instead of returning `ctx` itself.',
    );
  }
  if (message.includes('Cannot read property of')) {
    return suggest(
      'Use optional chaining and a fallback, for example `value?.property ?? fallback`.',
    );
  }
  if (message.includes('Unsupported "new" expression')) {
    return suggest(
      'Construct runtime objects outside the configuration and store only their serializable inputs here.',
    );
  }
  if (
    message.includes('Cannot inline non-finite number') ||
    message.includes('Cannot transform macro value of type')
  ) {
    return suggest(
      'Replace the value with a finite number, string, boolean, null, array, or plain object.',
    );
  }
  if (message.includes('cyclic')) {
    return suggest(
      'Remove the circular reference; configuration values must form a tree that can be serialized.',
    );
  }
  if (message.includes('quote must be')) {
    return suggest('Set `quote` to either `"single"` or `"double"`.');
  }
  if (message.includes('Unsupported format')) {
    return suggest('Use either `"json"` or `"yaml"` as the output format.');
  }
  if (message.includes('Unsupported call expression')) {
    return suggest(
      'Precompute the call result in a static `const`, or replace the call with a supported `@conf-ts/macro` function.',
      'If this is a macro call, verify that macro transformation runs before compilation.',
    );
  }
  if (
    message.includes('Unsupported syntax') ||
    message.includes('Unsupported binary operator') ||
    message.includes('Unsupported unary operator') ||
    message.includes('Unsupported property access') ||
    message.includes('Unsupported element access')
  ) {
    return suggest(
      'Rewrite the highlighted expression using literals, static constants, arrays, plain objects, and supported operators.',
      'Move runtime-only logic out of the configuration or express it with a supported macro.',
    );
  }

  return suggest(
    'Review the highlighted expression and replace it with a statically evaluable, JSON/YAML-compatible value.',
  );
}

function formatLocation(location: SourceLocation, prefix: string): string {
  const { file, line, character, sourceLine } = location;
  let result = `    ${prefix} ${file || 'unknown'}:${line}:${character}`;
  if (sourceLine !== undefined) {
    const gutter = String(line);
    result += `\n      ${gutter} | ${sourceLine}`;
    result += `\n      ${' '.repeat(gutter.length)} | ${' '.repeat(
      Math.max(0, character - 1),
    )}^`;
  }
  return result;
}

function sourceLineAt(source: string, line: number): string | undefined {
  return source.split(/\r?\n/)[line - 1];
}

/** Convert TypeScript's zero-based line/character pair into a user-facing location. */
export function getSourceLocation(
  file: string,
  source: string,
  line: number,
  character: number,
): SourceLocation {
  const displayLine = line + 1;
  return {
    file,
    line: displayLine,
    character: character + 1,
    sourceLine: sourceLineAt(source, displayLine),
  };
}

export class ConfTSError extends Error {
  constructor(
    message: string,
    public location: SourceLocation,
    public references: SourceReference[] = [],
    public suggestions: DiagnosticSuggestion[] = suggestionsForError(message),
  ) {
    super(message);
    this.name = 'ConfTSError';
    Object.setPrototypeOf(this, ConfTSError.prototype);
    const internalStack = this.stack?.split('\n').slice(1).join('\n');
    Object.defineProperty(this, 'stack', {
      configurable: true,
      get: () =>
        `${this.toString()}${internalStack ? `\n${internalStack}` : ''}`,
    });
  }

  addReference(location: SourceLocation, label = 'referenced from'): this {
    const duplicate = [
      this.location,
      ...this.references.map(ref => ref.location),
    ].some(existing => existing.file === location.file);
    if (!duplicate) {
      this.references.push({ location, label });
    }
    return this;
  }

  addSource(file: string, source: string): this {
    const add = (location: SourceLocation): void => {
      if (location.file === file && location.sourceLine === undefined) {
        location.sourceLine = sourceLineAt(source, location.line);
      }
    };
    add(this.location);
    for (const reference of this.references) add(reference.location);
    return this;
  }

  toString(): string {
    const references = this.references
      .map(reference =>
        formatLocation(
          reference.location,
          reference.label ?? 'referenced from',
        ),
      )
      .join('\n');
    const suggestions = this.suggestions
      .map((suggestion, index) => `      ${index + 1}. ${suggestion.message}`)
      .join('\n');
    return `${this.name}: ${this.message}\n${formatLocation(
      this.location,
      'at',
    )}${references ? `\n${references}` : ''}${
      suggestions ? `\n\n    Suggested fixes:\n${suggestions}` : ''
    }`;
  }
}
