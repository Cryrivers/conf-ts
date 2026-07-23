import { stringify as yamlStringify } from 'yaml';

import { ConfTSError } from './error';

/**
 * Compile options for both filesystem and in-memory compilation.
 */
export interface CompileOptions {
  preserveKeyOrder?: boolean;
}

export type InMemoryFiles = { [fileName: string]: string };

/** A serializable TypeScript project supplied by a build tool or editor. */
export interface SourceProject {
  files: Record<string, string>;
  resolutions?: Record<string, Record<string, string>>;
  compilerOptions?: Record<string, unknown>;
}

/** Source-first compiler input. `code` always wins over the project snapshot. */
export interface SourceCompileInput {
  filename: string;
  code: string;
  project?: SourceProject;
}

export type CompileInput = string | SourceCompileInput;

/**
 * A wrapper for numbers that preserves their original string representation from the source code.
 * This is used to ensure that formatting like "1.0" is preserved in the output.
 */
export class FormattedNumber {
  constructor(
    public value: number,
    public text: string,
  ) {}
  valueOf() {
    return this.value;
  }
  toString() {
    return this.text;
  }
}

/**
 * Deep clone an object while preserving key order.
 * Used when `preserveKeyOrder` option is enabled.
 */
export function orderedClone(value: any): any {
  if (value instanceof FormattedNumber) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(v => orderedClone(v));
  }
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const k of Object.keys(value)) {
      out[k] = orderedClone(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * A robust JSON stringifier that preserves custom number formatting.
 * This avoids the need for unstable placeholder string replacement hacks.
 */
export function jsonStringify(value: any, space: number | string = 2): string {
  const gap = typeof space === 'number' ? ' '.repeat(space) : space;

  function serialize(val: any, indent: string): string | undefined {
    if (val === undefined) {
      return undefined;
    }

    if (val && typeof val === 'object' && typeof val.toJSON === 'function') {
      val = val.toJSON();
    }

    if (val instanceof FormattedNumber) {
      return val.text;
    }

    if (val === null) return 'null';

    switch (typeof val) {
      case 'string':
        return JSON.stringify(val);
      case 'number':
        return isFinite(val) ? String(val) : 'null';
      case 'boolean':
        return String(val);
      case 'object':
        if (Array.isArray(val)) {
          if (val.length === 0) return '[]';
          const newIndent = indent + gap;
          const items = val.map(item => serialize(item, newIndent) ?? 'null');
          if (items.length === 0) return '[]';
          return `[\n${newIndent}${items.join(`,\n${newIndent}`)}\n${indent}]`;
        } else {
          const keys = Object.keys(val);
          if (keys.length === 0) return '{}';
          const newIndent = indent + gap;
          const items = keys
            .map(key => {
              const v = serialize(val[key], newIndent);
              if (v === undefined) return undefined;
              return `${JSON.stringify(key)}: ${v}`;
            })
            .filter((item): item is string => item !== undefined);
          if (items.length === 0) return '{}';
          return `{\n${newIndent}${items.join(`,\n${newIndent}`)}\n${indent}}`;
        }
      default:
        throw new Error(`Unsupported type: ${typeof val}`);
    }
  }

  return serialize(value, '') ?? 'null';
}

/** Serialize evaluated config output to JSON or YAML text. */
export function serializeOutput(
  output: object,
  format: 'json' | 'yaml',
  dependencies: string[],
  options?: CompileOptions,
): { output: string; dependencies: string[] } {
  const customTags = [
    {
      identify: (v: any) => v instanceof FormattedNumber,
      default: true,
      tag: 'tag:yaml.org,2002:float',
      resolve: (v: string) => parseFloat(v),
      stringify: ({ value }: any) => (value as FormattedNumber).text,
    },
  ];

  if (format === 'json') {
    const jsonSource = options?.preserveKeyOrder
      ? jsonStringify(orderedClone(output), 2)
      : jsonStringify(output, 2);
    return { output: jsonSource, dependencies };
  } else if (format === 'yaml') {
    const yamlOptions = { customTags, indentSeq: false };
    const yamlSource = options?.preserveKeyOrder
      ? yamlStringify(orderedClone(output), yamlOptions)
      : yamlStringify(output, yamlOptions);
    return { output: yamlSource, dependencies };
  } else {
    throw new ConfTSError(`Unsupported format: ${format}`, {
      file: 'unknown',
      line: 1,
      character: 1,
    });
  }
}
