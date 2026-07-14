import ts from 'typescript';

import type { CompileOptions } from './shared';

/** @internal Shared constant-evaluation state used by source front-ends. */
export interface EvaluationState {
  typeChecker: ts.TypeChecker;
  enumMap: { [filePath: string]: { [key: string]: any } };
  importBindingsMap: { [filePath: string]: Set<string> };
  evaluatedFiles: Set<string>;
}

/** @internal Extension point for evaluating call expressions. */
export interface EvaluationOptions extends CompileOptions {
  evaluateCallExpression?: (
    expression: ts.CallExpression,
    sourceFile: ts.SourceFile,
    typeChecker: ts.TypeChecker,
    enumMap: { [filePath: string]: { [key: string]: any } },
    importBindingsMap: { [filePath: string]: Set<string> },
    evaluatedFiles: Set<string>,
    context: { [name: string]: any } | undefined,
    options?: EvaluationOptions,
  ) => any;
}
