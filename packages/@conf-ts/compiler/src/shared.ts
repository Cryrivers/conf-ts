import ts from 'typescript';

import { MACRO_PACKAGE } from './constants';

/**
 * Compile options for both filesystem and in-memory compilation.
 */
export interface CompileOptions {
  preserveKeyOrder?: boolean;
  macroMode?: boolean;
  env?: Record<string, string>;
}

/**
 * A wrapper for numbers that preserves their original string representation from the source code.
 * This is used to ensure that formatting like "1.0" is preserved in the output.
 */
export class FormattedNumber {
  public __isFormattedNumber = true;
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
          const items = val
            .map(item => serialize(item, newIndent))
            .filter((item): item is string => item !== undefined);
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

/**
 * Validate and collect macro imports from a source file.
 * Returns a Set of imported macro function names.
 */
export function validateMacroImports(
  sourceFile: ts.SourceFile,
  macro: boolean,
): Set<string> {
  const macroImports = new Set<string>();

  if (!macro) {
    return macroImports;
  }

  ts.forEachChild(sourceFile, node => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const moduleSpecifier = node.moduleSpecifier
        .getText(sourceFile)
        .slice(1, -1); // Remove quotes
      if (moduleSpecifier === MACRO_PACKAGE) {
        if (node.importClause && node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            node.importClause.namedBindings.elements.forEach(
              importSpecifier => {
                const importedName = importSpecifier.name.getText(sourceFile);
                macroImports.add(importedName);
              },
            );
          }
        }
      }
    }
  });

  return macroImports;
}
