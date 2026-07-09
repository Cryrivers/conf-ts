import ts from 'typescript';

import { MACRO_FUNCTIONS } from './constants';
import { ConfTSError } from './error';
import { evaluate } from './eval';
import {
  encodeStringLiteral,
  rewriteContextExpression,
} from './expression-rewrite';
import { FormattedNumber, type QuoteStyle } from './shared';

// Macro functions (other than `expr` itself) that can be called inside an
// expr() callback body. A call to one of these is only inlineable when it
// doesn't touch the context parameter, since it must be resolvable entirely
// at compile time.
const EXPR_INLINEABLE_MACROS = new Set<string>(
  MACRO_FUNCTIONS.filter(name => name !== 'expr'),
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
//   - compiler-native/src/macro_eval.rs: EXPR_RUNTIME_FALLBACK_MACROS
//   - expression/src/eval.ts: GLOBAL_BUILTINS (the runtime side backing
//     these names — the compiler emits e.g. `Number(x)` as literal runtime
//     call text, so @conf-ts/expression's evaluator must know how to
//     resolve `Number` as a callable, or the compiled output throws
//     "Expression value is not callable" at request time instead of
//     compile time)
const EXPR_RUNTIME_FALLBACK_MACROS = new Set(['String', 'Number', 'Boolean']);

function referencesContextParam(node: ts.Node, paramName: string): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === paramName;
  }
  // Property names/keys are text labels, not value references: `foo.bar` or
  // `{ bar: 1 }` never "reference" a variable named `bar`, even if it's
  // spelled the same as paramName. A generic ts.forEachChild walk would
  // still visit those identifiers as children and false-positive on them,
  // so member/property access is special-cased to only recurse into the
  // actual value-position subtrees (mirroring how collectConstReplacements
  // itself already distinguishes value vs. label positions elsewhere in
  // this file).
  if (ts.isPropertyAccessExpression(node)) {
    return referencesContextParam(node.expression, paramName);
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      referencesContextParam(node.expression, paramName) ||
      referencesContextParam(node.argumentExpression, paramName)
    );
  }
  if (ts.isPropertyAssignment(node)) {
    const keyReferences =
      ts.isComputedPropertyName(node.name) &&
      referencesContextParam(node.name.expression, paramName);
    return keyReferences || referencesContextParam(node.initializer, paramName);
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    return node.name.text === paramName;
  }
  return (
    ts.forEachChild(node, child =>
      referencesContextParam(child, paramName) ? true : undefined,
    ) === true
  );
}

type MacroOptions = {
  preserveKeyOrder?: boolean;
  env?: Record<string, string>;
  quote?: QuoteStyle;
};

type ExprReplacement = [start: number, end: number, value: string];

type ExprReplacementContext = {
  paramName: string;
  bodyStart: number;
  replacements: ExprReplacement[];
  sourceFile: ts.SourceFile;
  typeChecker: ts.TypeChecker;
  enumMap: { [filePath: string]: { [key: string]: any } };
  macroImportsMap: { [filePath: string]: Set<string> };
  evaluatedFiles: Set<string>;
  options?: MacroOptions;
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
): { paramName: string; bodyExpression: ts.Expression } {
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
    addNodeReplacement(node, evaluateNodeLiteral(node, context), context);
    return;
  }

  if (ts.isCallExpression(node) && isInlineableMacroCall(node, context)) {
    const calleeName = (node.expression as ts.Identifier).text;
    if (
      EXPR_RUNTIME_FALLBACK_MACROS.has(calleeName) &&
      node.arguments.length === 1 &&
      referencesContextParam(node, paramName)
    ) {
      node.arguments.forEach(arg => collectConstReplacements(arg, context));
      return;
    }
    addNodeReplacement(node, evaluateNodeLiteral(node, context), context);
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

  if (ts.isIdentifier(node) && node.text !== paramName) {
    addNodeReplacement(node, evaluateNodeLiteral(node, context), context);
    return;
  }

  ts.forEachChild(node, child => collectConstReplacements(child, context));
}

function collectTypeSyntaxErasures(
  node: ts.Node,
  bodyStart: number,
  replacements: ExprReplacement[],
  sourceFile: ts.SourceFile,
): void {
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

  const { paramName, bodyExpression } = getExprCallbackDetails(
    expression.arguments[0],
    sourceFile,
  );

  let bodyText = bodyExpression.getText(sourceFile);
  const bodyStart = bodyExpression.getStart(sourceFile);

  const replacements: ExprReplacement[] = [];
  collectConstReplacements(bodyExpression, {
    paramName,
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
): any {
  const callee = getCalleeName(expression, sourceFile);

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
