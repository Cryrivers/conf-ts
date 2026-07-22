import { ConfTSError, FormattedNumber } from '@conf-ts/compiler';
import { evaluate } from '@conf-ts/compiler/internal';
import ts from 'typescript';

import {
  encodeStringLiteral,
  rewriteContextExpression,
} from './expression-rewrite';
import { MACRO_FUNCTION_NAMES } from './macro-names';
import type { MacroEvaluationOptions, QuoteStyle } from './types';

// Macro functions (other than `expr` itself) that can be called inside an
// expr() callback body. A call to one of these is only inlineable when it
// doesn't touch the context parameter, since it must be resolvable entirely
// at compile time.
const EXPR_INLINEABLE_MACROS = new Set<string>(
  MACRO_FUNCTION_NAMES.filter(name => name !== 'expr'),
);

function isInlineableMacroCall(
  node: ts.CallExpression,
  context: ExprReplacementContext,
): boolean {
  const callee = node.expression;
  if (!ts.isIdentifier(callee) || !EXPR_INLINEABLE_MACROS.has(callee.text)) {
    return false;
  }
  const allowedMacroImports =
    context.macroImportsMap[context.sourceFile.fileName] || new Set();
  return allowedMacroImports.has(callee.text);
}

// Type-casting macros have a direct runtime equivalent in the expr DSL, so
// when a call to one of them can't be fully resolved to a compile-time
// constant (because it touches the context parameter), it's kept in the
// output text as a runtime call instead of failing to compile. The other
// inlineable macros (arrayMap/arrayFilter/arrayFlatMap/env) have no runtime
// equivalent, so they must always resolve to a compile-time constant or fail.
//
// This set must stay in sync with its two counterparts, since nothing
// enforces agreement across the language/package boundary between them:
//   - macro-transformer-native/src/transform.rs: runtime fallback macro matching
//   - expression/src/eval.ts: GLOBAL_BUILTINS (the runtime side backing
//     these names — the compiler emits e.g. `Number(x)` as literal runtime
//     call text, so @conf-ts/expression's evaluator must know how to
//     resolve `Number` as a callable, or the compiled output throws
//     "Expression value is not callable" at request time instead of
//     compile time)
const EXPR_RUNTIME_FALLBACK_MACROS = new Set(['String', 'Number', 'Boolean']);

function referencesName(
  node: ts.Node,
  isTargetName: (name: string) => boolean,
): boolean {
  if (ts.isIdentifier(node)) {
    return isTargetName(node.text);
  }
  // Property names/keys are text labels, not value references: `foo.bar` or
  // `{ bar: 1 }` never "reference" a variable named `bar`, even if it's
  // spelled the same as a target name. A generic ts.forEachChild walk would
  // still visit those identifiers as children and false-positive on them,
  // so member/property access is special-cased to only recurse into the
  // actual value-position subtrees (mirroring how collectConstReplacements
  // itself already distinguishes value vs. label positions elsewhere in
  // this file).
  if (ts.isPropertyAccessExpression(node)) {
    return referencesName(node.expression, isTargetName);
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      referencesName(node.expression, isTargetName) ||
      referencesName(node.argumentExpression, isTargetName)
    );
  }
  if (ts.isPropertyAssignment(node)) {
    const keyReferences =
      ts.isComputedPropertyName(node.name) &&
      referencesName(node.name.expression, isTargetName);
    return keyReferences || referencesName(node.initializer, isTargetName);
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    return isTargetName(node.name.text);
  }
  return (
    ts.forEachChild(node, child =>
      referencesName(child, isTargetName) ? true : undefined,
    ) === true
  );
}

// Whether folding `node` to a compile-time literal is even possible: it must
// not touch the context param (a runtime-only value) nor any name bound by
// an enclosing nested callback (e.g. the `row` in
// `ctx.matrix.map(row => row.filter(x => x > 0).length)`, which is just as
// unresolvable at compile time as the context itself).
function referencesUnfoldableName(
  node: ts.Node,
  context: ExprReplacementContext,
): boolean {
  return referencesName(
    node,
    name => name === context.paramName || !!context.boundNames?.has(name),
  );
}

type MacroOptions = MacroEvaluationOptions & { quote?: QuoteStyle };

const FATAL_MACRO_TRANSFORM_ERROR = Symbol('fatalMacroTransformError');

class FatalMacroTransformError extends ConfTSError {
  readonly [FATAL_MACRO_TRANSFORM_ERROR] = true;
}

export function isFatalMacroTransformError(
  error: unknown,
): error is ConfTSError {
  return (
    error instanceof ConfTSError &&
    (error as FatalMacroTransformError)[FATAL_MACRO_TRANSFORM_ERROR] === true
  );
}

type ExprReplacement = [start: number, end: number, value: string];

type ExprReplacementContext = {
  paramName: string;
  paramIdentifier: ts.Identifier;
  bodyStart: number;
  replacements: ExprReplacement[];
  sourceFile: ts.SourceFile;
  typeChecker: ts.TypeChecker;
  enumMap: { [filePath: string]: { [key: string]: any } };
  macroImportsMap: { [filePath: string]: Set<string> };
  evaluatedFiles: Set<string>;
  options?: MacroOptions;
  // Parameter names bound by a nested arrow/function callback (e.g. the `i`
  // in `ctx.queue.filter(i => i < 5)`) that this subtree is nested inside.
  // These are local values scoped to that callback, not compile-time
  // constants and not context access, so identifier-folding must leave them
  // untouched wherever they're referenced.
  boundNames?: Set<string>;
};

const EXPR_CALLBACK_ERROR =
  'expr callback must be an arrow function with a single identifier parameter and expression body';

function getCalleeName(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
) {
  return expression.expression.getText(sourceFile);
}

function assertMacroImported(
  callee: string,
  sourceFile: ts.SourceFile,
  macroImportsMap: { [filePath: string]: Set<string> },
  expression: ts.CallExpression,
  errorMessage: string,
) {
  const allowedMacroImports = macroImportsMap[sourceFile.fileName] || new Set();
  if (!allowedMacroImports.has(callee)) {
    throw new ConfTSError(errorMessage, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
    });
  }
}

function hasEnumMemberByName(
  fullName: string,
  sourceFile: ts.SourceFile,
  enumMap: { [filePath: string]: { [key: string]: any } },
): boolean {
  if (
    enumMap[sourceFile.fileName] &&
    Object.prototype.hasOwnProperty.call(enumMap[sourceFile.fileName], fullName)
  ) {
    return true;
  }
  for (const filePath of Object.keys(enumMap)) {
    if (Object.prototype.hasOwnProperty.call(enumMap[filePath], fullName)) {
      return true;
    }
  }
  return false;
}

function isEnumPropertyAccessExpression(
  propertyAccess: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
): boolean {
  const fullName = propertyAccess.getText(sourceFile);
  const symbol = typeChecker.getSymbolAtLocation(propertyAccess);
  if (!symbol) {
    return hasEnumMemberByName(fullName, sourceFile, enumMap);
  }
  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) {
    return false;
  }
  const declaration = declarations[0];
  if (!ts.isEnumMember(declaration)) {
    return false;
  }
  const declSourceFile = declaration.getSourceFile();
  const enumName = declaration.parent.name.getText(declSourceFile);
  const memberName = declaration.name.getText(declSourceFile);
  const fullEnumMemberName = `${enumName}.${memberName}`;
  return !!(
    enumMap[declSourceFile.fileName] &&
    Object.prototype.hasOwnProperty.call(
      enumMap[declSourceFile.fileName],
      fullEnumMemberName,
    )
  );
}

function isEnumPropertyAccessIdentifier(
  node: ts.Identifier,
  position: 'expression' | 'name',
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
): boolean {
  if (!node.parent || !ts.isPropertyAccessExpression(node.parent)) {
    return false;
  }
  if (position === 'expression' && node.parent.expression !== node) {
    return false;
  }
  if (position === 'name' && node.parent.name !== node) {
    return false;
  }
  return isEnumPropertyAccessExpression(
    node.parent,
    sourceFile,
    typeChecker,
    enumMap,
  );
}

function isEnumIdentifier(
  node: ts.Identifier,
  typeChecker: ts.TypeChecker,
): boolean {
  const symbol = typeChecker.getSymbolAtLocation(node);
  if (!symbol) {
    return false;
  }
  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) {
    return false;
  }
  return declarations.some(
    declaration =>
      ts.isEnumDeclaration(declaration) || ts.isEnumMember(declaration),
  );
}

// An identifier that resolves to an outer variable/binding declaration is
// allowed through the gate here and left for `evaluate()` to actually
// resolve: `evaluate()` already knows how to fold a `const` (including
// destructured bindings) to a compile-time value, and will throw its own
// descriptive error if the declaration turns out to be a `let`/`var`. This
// mirrors the native (Rust) transformer, which resolves callback bodies with
// the same general-purpose expression evaluator rather than a separate
// allowlist, so both transformers accept the same outer-const captures.
function isVariableReferenceIdentifier(
  node: ts.Identifier,
  typeChecker: ts.TypeChecker,
): boolean {
  const symbol = typeChecker.getSymbolAtLocation(node);
  if (!symbol) {
    return false;
  }
  let resolvedSymbol = symbol;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    resolvedSymbol = typeChecker.getAliasedSymbol(symbol);
  }
  const declaration = resolvedSymbol.valueDeclaration;
  return (
    !!declaration &&
    (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration))
  );
}

function createArrayCallbackChecker(params: {
  sourceFile: ts.SourceFile;
  typeChecker: ts.TypeChecker;
  enumMap: { [filePath: string]: { [key: string]: any } };
  macroImportsMap: { [filePath: string]: Set<string> };
  paramName: string;
  errorMessage: string;
}): (node: ts.Node) => void {
  const { sourceFile, typeChecker, enumMap, macroImportsMap, paramName } =
    params;
  const allowedMacroImports = macroImportsMap[sourceFile.fileName] || new Set();

  function isAllowedIdentifier(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      if (
        node.parent &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node &&
        allowedMacroImports.has(node.text)
      ) {
        return true;
      }
      if (isEnumIdentifier(node, typeChecker)) {
        return true;
      }
      if (
        isEnumPropertyAccessIdentifier(
          node,
          'expression',
          sourceFile,
          typeChecker,
          enumMap,
        )
      ) {
        return true;
      }
      if (
        isEnumPropertyAccessIdentifier(
          node,
          'name',
          sourceFile,
          typeChecker,
          enumMap,
        )
      ) {
        return true;
      }
      if (node.text === paramName) {
        return true;
      }
      if (isVariableReferenceIdentifier(node, typeChecker)) {
        return true;
      }
      if (
        node.parent &&
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node
      ) {
        let expr = node.parent.expression;
        while (ts.isPropertyAccessExpression(expr)) {
          expr = expr.expression;
        }
        if (ts.isIdentifier(expr) && expr.text === paramName) {
          return true;
        }
      }
      if (
        node.parent &&
        ts.isPropertyAssignment(node.parent) &&
        node.parent.name === node
      ) {
        return true;
      }
      return false;
    }
    return true;
  }

  function checkNode(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      if (!isAllowedIdentifier(node)) {
        throw new ConfTSError(params.errorMessage, {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(sourceFile, node.getStart()),
        });
      }
    }
    ts.forEachChild(node, checkNode);
  }

  return checkNode;
}

function getCallbackBodyExpression(
  callback: ts.ArrowFunction,
  sourceFile: ts.SourceFile,
  checkNode: (node: ts.Node) => void,
  errorMessage: string,
): ts.Expression {
  if (ts.isBlock(callback.body)) {
    const stmts = callback.body.statements;
    if (
      stmts.length !== 1 ||
      !ts.isReturnStatement(stmts[0]) ||
      !stmts[0].expression
    ) {
      throw new ConfTSError(errorMessage, {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(
          sourceFile,
          callback.body.getStart(),
        ),
      });
    }
    const expr = (stmts[0] as ts.ReturnStatement).expression!;
    checkNode(expr);
    return expr;
  }
  checkNode(callback.body);
  return callback.body;
}

function getArrayCallbackDetails(params: {
  callbackExpression: ts.Expression;
  sourceFile: ts.SourceFile;
  typeChecker: ts.TypeChecker;
  enumMap: { [filePath: string]: { [key: string]: any } };
  macroImportsMap: { [filePath: string]: Set<string> };
  arrowErrorMessage: string;
  paramErrorMessage: string;
  bodyErrorMessage: string;
  identifierErrorMessage: string;
}): { paramName: string; bodyExpression: ts.Expression } {
  const {
    callbackExpression,
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    arrowErrorMessage,
    paramErrorMessage,
    bodyErrorMessage,
    identifierErrorMessage,
  } = params;
  if (!ts.isArrowFunction(callbackExpression)) {
    throw new ConfTSError(arrowErrorMessage, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(
        sourceFile,
        callbackExpression.getStart(),
      ),
    });
  }
  if (callbackExpression.parameters.length !== 1) {
    throw new ConfTSError(paramErrorMessage, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(
        sourceFile,
        callbackExpression.getStart(),
      ),
    });
  }
  const paramName = callbackExpression.parameters[0].name.getText(sourceFile);
  const checkNode = createArrayCallbackChecker({
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    paramName,
    errorMessage: identifierErrorMessage,
  });
  const bodyExpression = getCallbackBodyExpression(
    callbackExpression,
    sourceFile,
    checkNode,
    bodyErrorMessage,
  );
  return { paramName, bodyExpression };
}

function isAsyncArrowFunction(callback: ts.ArrowFunction): boolean {
  return (
    callback.modifiers?.some(
      modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ?? false
  );
}

function getExprCallbackDetails(
  callbackExpression: ts.Expression,
  sourceFile: ts.SourceFile,
): {
  paramName: string;
  paramIdentifier: ts.Identifier;
  bodyExpression: ts.Expression;
} {
  if (
    !ts.isArrowFunction(callbackExpression) ||
    isAsyncArrowFunction(callbackExpression)
  ) {
    throw new ConfTSError(EXPR_CALLBACK_ERROR, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(
        sourceFile,
        callbackExpression.getStart(),
      ),
    });
  }

  if (callbackExpression.parameters.length !== 1) {
    throw new ConfTSError(EXPR_CALLBACK_ERROR, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(
        sourceFile,
        callbackExpression.getStart(),
      ),
    });
  }

  const param = callbackExpression.parameters[0];
  if (
    !ts.isIdentifier(param.name) ||
    !!param.dotDotDotToken ||
    !!param.initializer
  ) {
    throw new ConfTSError(EXPR_CALLBACK_ERROR, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, param.getStart()),
    });
  }

  if (ts.isBlock(callbackExpression.body)) {
    throw new ConfTSError(EXPR_CALLBACK_ERROR, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(
        sourceFile,
        callbackExpression.body.getStart(),
      ),
    });
  }

  return {
    paramName: param.name.text,
    paramIdentifier: param.name,
    bodyExpression: callbackExpression.body,
  };
}

function valueToExprLiteral(
  value: any,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  quote: QuoteStyle = 'double',
): string {
  if (typeof value === 'number' || value instanceof FormattedNumber) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new ConfTSError('Cannot inline non-finite number into expr', {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(sourceFile, node.getStart()),
      });
    }
    return Object.is(number, -0) ? '-0' : String(number);
  }
  if (typeof value === 'string') {
    return encodeStringLiteral(value, quote);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  throw new ConfTSError(
    `Cannot inline value of type ${typeof value} into expr`,
    {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, node.getStart()),
    },
  );
}

function unwrapExprSyntax(node: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return unwrapExprSyntax(node.expression);
  }
  return node;
}

function containingImportDeclaration(
  declaration: ts.Declaration,
): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function isImportedExprCall(
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker,
): boolean {
  if (ts.isIdentifier(node.expression)) {
    const symbol = typeChecker.getSymbolAtLocation(node.expression);
    return (
      symbol?.declarations?.some(declaration => {
        if (!ts.isImportSpecifier(declaration)) return false;
        const importedName =
          declaration.propertyName?.text ?? declaration.name.text;
        const importDeclaration = containingImportDeclaration(declaration);
        return (
          importedName === 'expr' &&
          !!importDeclaration &&
          ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === '@conf-ts/macro'
        );
      }) ?? false
    );
  }

  if (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'expr' &&
    ts.isIdentifier(node.expression.expression)
  ) {
    const symbol = typeChecker.getSymbolAtLocation(node.expression.expression);
    return (
      symbol?.declarations?.some(declaration => {
        if (!ts.isNamespaceImport(declaration)) return false;
        const importDeclaration = containingImportDeclaration(declaration);
        return (
          !!importDeclaration &&
          ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === '@conf-ts/macro'
        );
      }) ?? false
    );
  }

  return false;
}

function expressionOriginatesFromExpr(
  node: ts.Expression,
  typeChecker: ts.TypeChecker,
  visited: Set<ts.Symbol> = new Set(),
): boolean {
  const expression = unwrapExprSyntax(node);
  if (ts.isCallExpression(expression)) {
    return isImportedExprCall(expression, typeChecker);
  }
  if (!ts.isIdentifier(expression)) return false;

  const symbol = typeChecker.getSymbolAtLocation(expression);
  if (!symbol) return false;
  const resolvedSymbol =
    symbol.flags & ts.SymbolFlags.Alias
      ? typeChecker.getAliasedSymbol(symbol)
      : symbol;
  if (visited.has(resolvedSymbol)) return false;
  visited.add(resolvedSymbol);

  const declaration =
    resolvedSymbol.valueDeclaration ?? resolvedSymbol.declarations?.[0];
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isVariableDeclarationList(declaration.parent) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    return expressionOriginatesFromExpr(
      declaration.initializer,
      typeChecker,
      visited,
    );
  }
  if (declaration && ts.isExportAssignment(declaration)) {
    return expressionOriginatesFromExpr(
      declaration.expression,
      typeChecker,
      visited,
    );
  }
  return false;
}

function nestedExprReplacement(
  node: ts.CallExpression,
  context: ExprReplacementContext,
): string | undefined {
  if (
    !ts.isIdentifier(node.expression) ||
    !expressionOriginatesFromExpr(node.expression, context.typeChecker)
  ) {
    return undefined;
  }

  const argument = node.arguments[0];
  const argumentSymbol =
    argument && ts.isIdentifier(argument)
      ? context.typeChecker.getSymbolAtLocation(argument)
      : undefined;
  const parameterSymbol = context.typeChecker.getSymbolAtLocation(
    context.paramIdentifier,
  );
  const isCurrentContext =
    node.arguments.length === 1 &&
    !!argument &&
    ts.isIdentifier(argument) &&
    argument.text === context.paramName &&
    (!argumentSymbol || !parameterSymbol || argumentSymbol === parameterSymbol);
  if (!isCurrentContext) {
    throw new FatalMacroTransformError(
      `Nested Expr '${node.expression.text}' must be called with exactly one argument: the current expr context parameter '${context.paramName}'.`,
      {
        file: context.sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(
          context.sourceFile,
          node.getStart(),
        ),
      },
    );
  }

  const value = evaluate(
    node.expression,
    context.sourceFile,
    context.typeChecker,
    context.enumMap,
    context.macroImportsMap,
    true,
    context.evaluatedFiles,
    undefined,
    context.options,
  );
  if (typeof value !== 'string') {
    throw new ConfTSError(
      `Nested Expr '${node.expression.text}' did not evaluate to an expression string`,
      {
        file: context.sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(
          context.sourceFile,
          node.getStart(),
        ),
      },
    );
  }
  return `(${value})`;
}

function isContextAccess(node: ts.Expression, paramName: string): boolean {
  const expression = unwrapExprSyntax(node);
  if (ts.isIdentifier(expression)) {
    return expression.text === paramName;
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return isContextAccess(expression.expression, paramName);
  }
  return false;
}

function addNodeReplacement(
  node: ts.Node,
  value: string,
  context: ExprReplacementContext,
): void {
  context.replacements.push([
    node.getStart(context.sourceFile) - context.bodyStart,
    node.getEnd() - context.bodyStart,
    value,
  ]);
}

function evaluateNodeLiteral(
  node: ts.Expression,
  context: ExprReplacementContext,
): string {
  const {
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    evaluatedFiles,
    options,
  } = context;
  const value = evaluate(
    node,
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    true,
    evaluatedFiles,
    undefined,
    options,
  );
  return valueToExprLiteral(value, sourceFile, node, options?.quote);
}

function collectContextComputedReplacements(
  node: ts.Expression,
  context: ExprReplacementContext,
): void {
  const expression = unwrapExprSyntax(node);
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    collectContextComputedReplacements(expression.expression, context);
    if (ts.isElementAccessExpression(expression)) {
      collectConstReplacements(expression.argumentExpression, context);
    }
  }
}

const NESTED_CALLBACK_ERROR =
  'expr callback: a nested function passed as a call argument must have parameters that are plain identifiers (optionally defaulted) or a single level of object/array destructuring (optionally defaulted, no computed keys, no nested patterns), with at most one trailing rest parameter; it must not have type annotations, must not be async or a generator, and its body must be a single expression or a single return statement';

// A nested callback (e.g. the predicate in `ctx.queue.filter(i => i < 5)`)
// only ever needs to reach values already available in its own scope: the
// current expr context and its own parameters. So instead of evaluating it
// at compile time, it's down-leveled into the same runtime expr-DSL text as
// the rest of the body — arrow-with-expression-body forms pass through
// almost unchanged, while block-bodied arrows and `function` expressions get
// rewritten into `params => body` text. @conf-ts/expr-core's grammar only
// ever needs to parse the latter (plain expression-bodied arrows), keeping
// the runtime DSL itself free of statements/blocks.
function assertNestedCallbackShape(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile,
): void {
  const isAsync =
    fn.modifiers?.some(
      modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ?? false;
  const isGenerator = ts.isFunctionExpression(fn) && !!fn.asteriskToken;
  if (isAsync || isGenerator || !!fn.typeParameters?.length || !!fn.type) {
    throw new ConfTSError(NESTED_CALLBACK_ERROR, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, fn.getStart()),
    });
  }
}

type NestedCallbackParamInfo = {
  names: string[];
  // Default-value expressions (either a whole parameter's `= expr`, or one
  // destructured element's own `= expr`) that need the same const-folding /
  // context-substitution treatment as the callback body itself, since they
  // become part of the compiled expr-DSL text too.
  defaultExpressions: ts.Expression[];
};

function assertNotShadowingContext(
  identifier: ts.Identifier,
  contextParamName: string,
  sourceFile: ts.SourceFile,
): void {
  if (identifier.text === contextParamName) {
    throw new ConfTSError(
      `expr callback: a nested function's parameter cannot shadow the context parameter '${contextParamName}'`,
      {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(sourceFile, identifier.getStart()),
      },
    );
  }
}

// Collects every identifier bound by a parameter's binding name, recursing
// one level into an object/array destructuring pattern — never deeper, and
// never through a rest element nested inside a pattern (only a top-level
// trailing parameter may be a rest parameter; see collectNestedCallbackParams).
// Recurses into one destructured property/element's own binding, and (since
// it's a value-position expression too) queues its default for the same
// const-folding/context-substitution treatment as everything else — shared
// by the object- and array-pattern branches below.
function collectPatternElementInfo(
  element: ts.BindingElement,
  contextParamName: string,
  sourceFile: ts.SourceFile,
  info: NestedCallbackParamInfo,
): void {
  collectBindingNameInfo(
    element.name,
    contextParamName,
    sourceFile,
    false,
    info,
  );
  if (element.initializer) {
    info.defaultExpressions.push(element.initializer);
  }
}

function collectBindingNameInfo(
  name: ts.BindingName,
  contextParamName: string,
  sourceFile: ts.SourceFile,
  allowPattern: boolean,
  info: NestedCallbackParamInfo,
): void {
  if (ts.isIdentifier(name)) {
    assertNotShadowingContext(name, contextParamName, sourceFile);
    info.names.push(name.text);
    return;
  }
  if (!allowPattern) {
    throw new ConfTSError(NESTED_CALLBACK_ERROR, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, name.getStart()),
    });
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (
        element.dotDotDotToken ||
        (element.propertyName &&
          ts.isComputedPropertyName(element.propertyName))
      ) {
        throw new ConfTSError(NESTED_CALLBACK_ERROR, {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(sourceFile, element.getStart()),
        });
      }
      collectPatternElementInfo(element, contextParamName, sourceFile, info);
    }
    return;
  }
  if (ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) {
        continue; // hole, e.g. the middle slot in `[a, , b]`
      }
      if (element.dotDotDotToken) {
        throw new ConfTSError(NESTED_CALLBACK_ERROR, {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(sourceFile, element.getStart()),
        });
      }
      collectPatternElementInfo(element, contextParamName, sourceFile, info);
    }
  }
}

// A default referencing an earlier parameter in the same list (real JS
// allows e.g. `(a, b = a + 1) => ...`) isn't supported: default expressions
// are resolved against the enclosing (ancestor) scope only, the same as any
// other expression outside this callback's own body. Referencing a sibling
// parameter surfaces as an ordinary "can't resolve" compile error.
function collectNestedCallbackParams(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  contextParamName: string,
  sourceFile: ts.SourceFile,
): NestedCallbackParamInfo {
  const info: NestedCallbackParamInfo = { names: [], defaultExpressions: [] };
  fn.parameters.forEach((param, index) => {
    if (param.type) {
      throw new ConfTSError(NESTED_CALLBACK_ERROR, {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(sourceFile, param.getStart()),
      });
    }
    if (param.dotDotDotToken) {
      if (
        index !== fn.parameters.length - 1 ||
        !ts.isIdentifier(param.name) ||
        !!param.initializer
      ) {
        throw new ConfTSError(NESTED_CALLBACK_ERROR, {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(sourceFile, param.getStart()),
        });
      }
      assertNotShadowingContext(param.name, contextParamName, sourceFile);
      info.names.push(param.name.text);
      return;
    }
    collectBindingNameInfo(
      param.name,
      contextParamName,
      sourceFile,
      true,
      info,
    );
    if (param.initializer) {
      info.defaultExpressions.push(param.initializer);
    }
  });
  return info;
}

// Finds the parameter list's own parentheses by scanning source text rather
// than walking the TS AST's child list: identifiers/keywords can't contain
// '(' or ')', so the first '(' at/after the function's start is always the
// param list's opening paren (skipping past `function`/a name for a
// FunctionExpression; arrows have nothing before it), and the first ')'
// at/after the last parameter's own end (which already spans past that
// parameter's default value, so a paren inside a string literal there can't
// be mistaken for it) is always the closing one.
function findParamListParens(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile,
): { openPos: number; closePos: number } {
  const text = sourceFile.text;
  const fnStart = fn.getStart(sourceFile);
  const openPos = text.indexOf('(', fnStart);
  const lastParam = fn.parameters[fn.parameters.length - 1];
  const searchFrom = lastParam ? lastParam.getEnd() : openPos + 1;
  const closePos = openPos === -1 ? -1 : text.indexOf(')', searchFrom);
  if (openPos === -1 || closePos === -1) {
    throw new ConfTSError(NESTED_CALLBACK_ERROR, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, fnStart),
    });
  }
  return { openPos, closePos };
}

function getNestedCallbackBodyExpression(
  body: ts.Block | ts.Expression,
  sourceFile: ts.SourceFile,
  errorNode: ts.Node,
): ts.Expression {
  if (ts.isBlock(body)) {
    const stmts = body.statements;
    if (
      stmts.length !== 1 ||
      !ts.isReturnStatement(stmts[0]) ||
      !stmts[0].expression
    ) {
      throw new ConfTSError(NESTED_CALLBACK_ERROR, {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(sourceFile, errorNode.getStart()),
      });
    }
    return (stmts[0] as ts.ReturnStatement).expression!;
  }
  return body;
}

function processNestedCallback(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  context: ExprReplacementContext,
): void {
  const { sourceFile, bodyStart } = context;
  assertNestedCallbackShape(fn, sourceFile);
  const { names: paramNames, defaultExpressions } = collectNestedCallbackParams(
    fn,
    context.paramName,
    sourceFile,
  );
  const bodyExpr = getNestedCallbackBodyExpression(fn.body, sourceFile, fn);

  // Default-value expressions can reference outer consts/context, so they
  // need the same treatment as the body — resolved against the ancestor
  // scope, since they run before any of this callback's own params exist.
  for (const defaultExpr of defaultExpressions) {
    collectConstReplacements(defaultExpr, context);
  }

  const isConciseArrow = ts.isArrowFunction(fn) && !ts.isBlock(fn.body);
  if (!isConciseArrow) {
    const isSimpleSingleParam =
      fn.parameters.length === 1 &&
      ts.isIdentifier(fn.parameters[0].name) &&
      !fn.parameters[0].initializer &&
      !fn.parameters[0].dotDotDotToken;
    if (isSimpleSingleParam) {
      // Nothing in the param list to preserve — synthesize a minimal bare
      // `name => ` prefix rather than copying source text verbatim.
      const paramName = (fn.parameters[0].name as ts.Identifier).text;
      context.replacements.push([
        fn.getStart(sourceFile) - bodyStart,
        bodyExpr.getStart(sourceFile) - bodyStart,
        `${paramName} => `,
      ]);
    } else {
      // Anything more than a single plain identifier (destructuring,
      // defaults, rest, multiple params) always needs real parentheses in
      // valid JS, so keep that original `(...)` text — including whatever
      // nested replacements collectConstReplacements below adds inside it —
      // instead of trying to reconstruct it from scratch.
      const { openPos, closePos } = findParamListParens(fn, sourceFile);
      const fnStart = fn.getStart(sourceFile);
      if (openPos > fnStart) {
        context.replacements.push([
          fnStart - bodyStart,
          openPos - bodyStart,
          '',
        ]);
      }
      context.replacements.push([
        closePos + 1 - bodyStart,
        bodyExpr.getStart(sourceFile) - bodyStart,
        ' => ',
      ]);
    }
    context.replacements.push([
      bodyExpr.getEnd() - bodyStart,
      fn.getEnd() - bodyStart,
      '',
    ]);
  }

  const nestedContext: ExprReplacementContext = {
    ...context,
    boundNames: new Set([...(context.boundNames ?? []), ...paramNames]),
  };
  collectConstReplacements(bodyExpr, nestedContext);
}

// The callee of a call is never itself invoked at compile time (the
// compiler has no general facility for executing arbitrary functions), so a
// member-access callee like `[1, 2].includes` or `someArray.includes` must be
// kept intact as runtime call syntax instead of being folded to a value the
// way a plain property-access value position would be. Only the non-member
// base of the chain (and any computed keys) still need the normal
// constant-folding / context-substitution treatment, mirroring how
// collectContextComputedReplacements already walks context-rooted chains
// without touching the property names.
function collectCallCalleeReplacements(
  node: ts.Expression,
  context: ExprReplacementContext,
): void {
  const expression = unwrapExprSyntax(node);
  if (ts.isPropertyAccessExpression(expression)) {
    collectCallCalleeReplacements(expression.expression, context);
    return;
  }
  if (ts.isElementAccessExpression(expression)) {
    collectCallCalleeReplacements(expression.expression, context);
    collectConstReplacements(expression.argumentExpression, context);
    return;
  }
  collectConstReplacements(node, context);
}

function collectConstReplacements(
  node: ts.Node,
  context: ExprReplacementContext,
): void {
  const { paramName } = context;

  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    isContextAccess(node, paramName)
  ) {
    collectContextComputedReplacements(node, context);
    return;
  }

  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    // A base that touches the context param, or a name bound by an
    // enclosing nested callback, somewhere further down (e.g. a call chain
    // like `ctx.queue.filter(...).length`) can't be resolved to a
    // compile-time value — keep the member-access chain as runtime source
    // text instead, the same way a call's callee already is.
    if (referencesUnfoldableName(node, context)) {
      collectCallCalleeReplacements(node, context);
      return;
    }
    addNodeReplacement(node, evaluateNodeLiteral(node, context), context);
    return;
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    processNestedCallback(node, context);
    return;
  }

  if (ts.isCallExpression(node)) {
    const replacement = nestedExprReplacement(node, context);
    if (replacement !== undefined) {
      addNodeReplacement(node, replacement, context);
      return;
    }
  }

  if (ts.isCallExpression(node) && isInlineableMacroCall(node, context)) {
    const calleeName = (node.expression as ts.Identifier).text;
    if (
      EXPR_RUNTIME_FALLBACK_MACROS.has(calleeName) &&
      node.arguments.length === 1 &&
      referencesUnfoldableName(node, context)
    ) {
      node.arguments.forEach(arg => collectConstReplacements(arg, context));
      return;
    }
    addNodeReplacement(node, evaluateNodeLiteral(node, context), context);
    return;
  }

  // Type arguments are compile-time-only metadata. Walk only the runtime
  // portions of a call so identifiers inside e.g. `fn<Result>(value)` are
  // never mistaken for captured constants.
  if (ts.isCallExpression(node)) {
    collectCallCalleeReplacements(node.expression, context);
    node.arguments.forEach(argument =>
      collectConstReplacements(argument, context),
    );
    return;
  }

  if (ts.isExpressionWithTypeArguments(node)) {
    collectConstReplacements(node.expression, context);
    return;
  }

  if (ts.isTaggedTemplateExpression(node)) {
    collectConstReplacements(node.tag, context);
    collectConstReplacements(node.template, context);
    return;
  }

  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    collectConstReplacements(node.expression, context);
    return;
  }

  if (ts.isPropertyAssignment(node)) {
    collectConstReplacements(node.initializer, context);
    return;
  }

  if (ts.isShorthandPropertyAssignment(node)) {
    const literal = evaluateNodeLiteral(node.name, context);
    addNodeReplacement(node, node.name.text + ': ' + literal, context);
    return;
  }

  if (
    ts.isIdentifier(node) &&
    node.text !== paramName &&
    !context.boundNames?.has(node.text)
  ) {
    addNodeReplacement(node, evaluateNodeLiteral(node, context), context);
    return;
  }

  ts.forEachChild(node, child => collectConstReplacements(child, context));
}

type ExpressionWithTypeArguments =
  | ts.CallExpression
  | ts.ExpressionWithTypeArguments
  | ts.TaggedTemplateExpression;

function collectTypeArgumentErasure(
  node: ExpressionWithTypeArguments,
  bodyStart: number,
  replacements: ExprReplacement[],
  sourceFile: ts.SourceFile,
): void {
  const { typeArguments } = node;
  if (!typeArguments?.length) return;

  // NodeArray.pos/end excludes the angle brackets (and can also exclude
  // trivia before the closing bracket). The concrete children retain the
  // exact source span, including comments contained in the type arguments.
  const children = node.getChildren(sourceFile);
  const listIndex = children.findIndex(
    child =>
      child.kind === ts.SyntaxKind.SyntaxList &&
      child.pos === typeArguments.pos &&
      child.end === typeArguments.end,
  );
  const open = children[listIndex - 1];
  const close = children[listIndex + 1];
  if (
    listIndex < 1 ||
    open.kind !== ts.SyntaxKind.LessThanToken ||
    close?.kind !== ts.SyntaxKind.GreaterThanToken
  ) {
    return;
  }

  replacements.push([
    open.getStart(sourceFile) - bodyStart,
    close.getEnd() - bodyStart,
    '',
  ]);
}

function collectTypeSyntaxErasures(
  node: ts.Node,
  bodyStart: number,
  replacements: ExprReplacement[],
  sourceFile: ts.SourceFile,
): void {
  const nodeStart = node.getStart(sourceFile) - bodyStart;
  const nodeEnd = node.getEnd() - bodyStart;
  if (
    replacements.some(
      ([replacementStart, replacementEnd]) =>
        replacementStart <= nodeStart && nodeEnd <= replacementEnd,
    )
  ) {
    return;
  }

  if (ts.isCallExpression(node)) {
    collectTypeArgumentErasure(node, bodyStart, replacements, sourceFile);
    collectTypeSyntaxErasures(
      node.expression,
      bodyStart,
      replacements,
      sourceFile,
    );
    node.arguments.forEach(argument =>
      collectTypeSyntaxErasures(argument, bodyStart, replacements, sourceFile),
    );
    return;
  }

  if (ts.isExpressionWithTypeArguments(node)) {
    collectTypeArgumentErasure(node, bodyStart, replacements, sourceFile);
    collectTypeSyntaxErasures(
      node.expression,
      bodyStart,
      replacements,
      sourceFile,
    );
    return;
  }

  if (ts.isTaggedTemplateExpression(node)) {
    collectTypeArgumentErasure(node, bodyStart, replacements, sourceFile);
    collectTypeSyntaxErasures(node.tag, bodyStart, replacements, sourceFile);
    collectTypeSyntaxErasures(
      node.template,
      bodyStart,
      replacements,
      sourceFile,
    );
    return;
  }

  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    replacements.push([
      node.expression.getEnd() - bodyStart,
      node.getEnd() - bodyStart,
      '',
    ]);
    collectTypeSyntaxErasures(
      node.expression,
      bodyStart,
      replacements,
      sourceFile,
    );
    return;
  }

  if (ts.isTypeAssertionExpression(node)) {
    replacements.push([
      node.getStart(sourceFile) - bodyStart,
      node.expression.getStart(sourceFile) - bodyStart,
      '',
    ]);
    collectTypeSyntaxErasures(
      node.expression,
      bodyStart,
      replacements,
      sourceFile,
    );
    return;
  }

  ts.forEachChild(node, child =>
    collectTypeSyntaxErasures(child, bodyStart, replacements, sourceFile),
  );
}

function collectCommentErasures(
  node: ts.Node,
  bodyStart: number,
  replacements: ExprReplacement[],
  sourceFile: ts.SourceFile,
): void {
  const bodyEnd = node.getEnd();
  const seen = new Set<string>();

  const visit = (current: ts.Node): void => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(sourceFile.text, current.getFullStart()) ??
        []),
      ...(ts.getTrailingCommentRanges(sourceFile.text, current.getEnd()) ?? []),
    ];
    for (const range of ranges) {
      if (range.pos < bodyStart || range.end > bodyEnd) continue;
      const key = `${range.pos}:${range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const start = range.pos - bodyStart;
      const end = range.end - bodyStart;
      const covered = replacements.some(
        ([replacementStart, replacementEnd]) =>
          replacementStart <= start && end <= replacementEnd,
      );
      if (!covered) replacements.push([start, end, '']);
    }
    current.getChildren(sourceFile).forEach(visit);
  };

  visit(node);
}

function evaluateExpr(
  callee: string,
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  evaluatedFiles: Set<string>,
  options?: MacroOptions,
): string | undefined {
  if (callee !== 'expr') {
    return undefined;
  }

  assertMacroImported(
    callee,
    sourceFile,
    macroImportsMap,
    expression,
    `Macro function '${callee}' must be imported from '@conf-ts/macro' to use in macro mode`,
  );

  if (expression.arguments.length !== 1) {
    throw new ConfTSError(EXPR_CALLBACK_ERROR, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
    });
  }

  const { paramName, paramIdentifier, bodyExpression } = getExprCallbackDetails(
    expression.arguments[0],
    sourceFile,
  );

  let bodyText = bodyExpression.getText(sourceFile);
  const bodyStart = bodyExpression.getStart(sourceFile);

  const replacements: ExprReplacement[] = [];
  collectConstReplacements(bodyExpression, {
    paramName,
    paramIdentifier,
    bodyStart,
    replacements,
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    evaluatedFiles,
    options,
  });
  collectTypeSyntaxErasures(
    bodyExpression,
    bodyStart,
    replacements,
    sourceFile,
  );
  collectCommentErasures(bodyExpression, bodyStart, replacements, sourceFile);

  replacements.sort((a, b) => b[0] - a[0]);
  for (const [start, end, literal] of replacements) {
    bodyText = bodyText.slice(0, start) + literal + bodyText.slice(end);
  }

  try {
    return rewriteContextExpression(bodyText, paramName, {
      quote: options?.quote,
    });
  } catch (error) {
    throw new ConfTSError(
      error instanceof Error ? error.message : String(error),
      {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(
          sourceFile,
          bodyExpression.getStart(),
        ),
      },
    );
  }
}
/**
 * Evaluate env macro. Supports nested macros in the argument by evaluating in macro mode
 * and propagating the current context to ensure correct scope handling.
 */
function evaluateEnv(
  callee: string,
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: MacroOptions,
) {
  if (
    callee === 'env' &&
    (expression.arguments.length === 1 || expression.arguments.length === 2)
  ) {
    assertMacroImported(
      callee,
      sourceFile,
      macroImportsMap,
      expression,
      `Macro function '${callee}' must be imported from '@conf-ts/macro' to use in macro mode`,
    );

    const argument = evaluate(
      expression.arguments[0],
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      true, // Allow nested macros inside env arguments
      evaluatedFiles,
      context,
      options,
    );
    if (typeof argument !== 'string') {
      throw new ConfTSError('env macro argument must be a string', {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(
          sourceFile,
          expression.arguments[0].getStart(),
        ),
      });
    }

    let defaultValue: string | undefined;
    if (expression.arguments.length === 2) {
      defaultValue = evaluate(
        expression.arguments[1],
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        true, // Allow nested macros inside env arguments
        evaluatedFiles,
        context,
        options,
      );
      if (typeof defaultValue !== 'string' && defaultValue !== undefined) {
        throw new ConfTSError('env macro default value must be a string', {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(
            sourceFile,
            expression.arguments[1].getStart(),
          ),
        });
      }
    }

    // Support injected env, Node and browser environments
    if (
      options?.env &&
      Object.prototype.hasOwnProperty.call(options.env, argument)
    ) {
      return options.env[argument] ?? defaultValue;
    }
    // eslint-disable-next-line no-undef
    const proc: any = typeof process !== 'undefined' ? process : undefined;
    return proc?.env?.[argument] ?? defaultValue;
  }
  return undefined;
}

/**
 * Evaluate type casting macros (String, Number, Boolean).
 * Nested macros inside the argument are supported by evaluating in macro mode
 * and passing through current context for proper identifier resolution.
 */
function evaluateTypeCasting(
  callee: string,
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: MacroOptions,
) {
  if (
    (callee === 'String' || callee === 'Number' || callee === 'Boolean') &&
    expression.arguments.length === 1
  ) {
    assertMacroImported(
      callee,
      sourceFile,
      macroImportsMap,
      expression,
      `Type casting function '${callee}' must be imported from '@conf-ts/macro' to use in macro mode`,
    );

    const argument = evaluate(
      expression.arguments[0],
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      true, // Enable nested macros within type casting arguments
      evaluatedFiles,
      context,
      options,
    );
    if (callee === 'String') {
      return String(argument);
    }
    if (callee === 'Number') {
      return Number(argument);
    }
    if (callee === 'Boolean') {
      return Boolean(argument);
    }
  }
  return undefined;
}

type ArrayMacroMethod = 'map' | 'flatMap' | 'filter';

const ARRAY_MACRO_METHODS: Record<string, ArrayMacroMethod> = {
  arrayMap: 'map',
  arrayFlatMap: 'flatMap',
  arrayFilter: 'filter',
};

function evaluateArrayMacro(
  callee: string,
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: MacroOptions,
): any {
  const method = ARRAY_MACRO_METHODS[callee];
  if (!method || expression.arguments.length !== 2) {
    return undefined;
  }
  assertMacroImported(
    callee,
    sourceFile,
    macroImportsMap,
    expression,
    `Macro function '${callee}' must be imported from '@conf-ts/macro' to use in macro mode`,
  );
  const arr = evaluate(
    expression.arguments[0],
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    true,
    evaluatedFiles,
    context,
    options,
  );
  const { paramName, bodyExpression } = getArrayCallbackDetails({
    callbackExpression: expression.arguments[1],
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    arrowErrorMessage: `${callee}: callback must be an arrow function`,
    paramErrorMessage: `${callee}: callback must have exactly one parameter`,
    bodyErrorMessage: `${callee}: callback body must be a single return statement`,
    identifierErrorMessage: `${callee}: callback can only use its parameter and literals`,
  });
  if (!Array.isArray(arr)) {
    return [];
  }
  const evalItem = (item: any) =>
    evaluate(
      bodyExpression,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      true,
      evaluatedFiles,
      { [paramName]: item },
      options,
    );
  switch (method) {
    case 'map':
      return arr.map((item: any) => evalItem(item));
    case 'flatMap':
      return arr.flatMap((item: any) => evalItem(item));
    case 'filter':
      return arr.filter((item: any) => Boolean(evalItem(item)));
  }
}

/**
 * Entry point for evaluating macros.
 * Accepts current evaluation context to support nested macros with correct scoping.
 */
export function evaluateMacro(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: MacroOptions,
  importedName?: string,
): any {
  const callee = importedName ?? getCalleeName(expression, sourceFile);

  const handlers = [
    () =>
      evaluateExpr(
        callee,
        expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        evaluatedFiles,
        options,
      ),
    () =>
      evaluateTypeCasting(
        callee,
        expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        evaluatedFiles,
        context,
        options,
      ),
    () =>
      evaluateArrayMacro(
        callee,
        expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        evaluatedFiles,
        context,
        options,
      ),
    () =>
      evaluateEnv(
        callee,
        expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        evaluatedFiles,
        context,
        options,
      ),
  ];

  for (const handler of handlers) {
    const result = handler();
    if (result !== undefined) {
      return result;
    }
  }

  throw new ConfTSError(
    `Unsupported call expression in macro mode: ${expression.getText(sourceFile)}`,
    {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
    },
  );
}
