import ts from 'typescript';

import { MACRO_PACKAGE } from './constants';

/**
 * Compile options for both filesystem and in-memory compilation.
 */
export interface CompileOptions {
  preserveKeyOrder?: boolean;
  macro?: boolean;
  env?: Record<string, string>;
}

/**
 * Deep clone an object while preserving key order.
 * Used when `preserveKeyOrder` option is enabled.
 */
export function orderedClone(value: any): any {
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
