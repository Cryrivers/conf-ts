import ts from 'typescript';

import { MACRO_FUNCTIONS } from './constants';
import { ConfTSError } from './error';
import { evaluate } from './eval';

type MacroFunction = {
  name: (typeof MACRO_FUNCTIONS)[number];
  argLength: number;
};

type MacroOptions = {
  preserveKeyOrder?: boolean;
  env?: Record<string, string>;
};

const TYPE_CASTING_FUNCTIONS = [
  { name: 'String', argLength: 1 },
  { name: 'Number', argLength: 1 },
  { name: 'Boolean', argLength: 1 },
] satisfies MacroFunction[];

const ARRAY_MACRO_FUNCTIONS = [
  { name: 'arrayMap', argLength: 2 },
  { name: 'arrayFilter', argLength: 2 },
] satisfies MacroFunction[];

const ENV_MACRO_FUNCTIONS = [
  { name: 'env', argLength: 1 },
] satisfies MacroFunction[];

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
/**
 * Evaluate env macro. Supports nested macros in the argument by evaluating in macro mode
 * and propagating the current context to ensure correct scope handling.
 */
function evaluateEnv(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
) {
  const callee = getCalleeName(expression, sourceFile);
  const macroFunction = ENV_MACRO_FUNCTIONS.find(
    macro => macro.name === callee,
  );
  if (
    macroFunction &&
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
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: { preserveKeyOrder?: boolean },
) {
  const callee = getCalleeName(expression, sourceFile);
  const macroFunction = TYPE_CASTING_FUNCTIONS.find(
    macro => macro.name === callee,
  );
  if (
    macroFunction &&
    expression.arguments.length === macroFunction.argLength
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

/**
 * Evaluate arrayMap macro.
 * - Allows nested macros both in the array argument and within the callback body.
 * - Propagates context so that callback parameter is correctly scoped in nested calls.
 */
function evaluateArrayMap(
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
  if (callee !== 'arrayMap' || expression.arguments.length !== 2) {
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
    true, // Allow nested macros inside the array argument
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
    arrowErrorMessage: 'arrayMap: callback must be an arrow function',
    paramErrorMessage: 'arrayMap: callback must have exactly one parameter',
    bodyErrorMessage:
      'arrayMap: callback body must be a single return statement',
    identifierErrorMessage:
      'arrayMap: callback can only use its parameter and literals',
  });
  return arr.map((item: any) => {
    return evaluate(
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
  });
}

/**
 * Evaluate arrayFilter macro.
 * - Allows nested macros both in the array argument and within the predicate body.
 * - Propagates context for correct identifier resolution in nested calls.
 */
function evaluateArrayFilter(
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
  if (callee !== 'arrayFilter' || expression.arguments.length !== 2) {
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
    true, // Allow nested macros inside the array argument
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
    arrowErrorMessage: 'arrayFilter: callback must be an arrow function',
    paramErrorMessage: 'arrayFilter: callback must have exactly one parameter',
    bodyErrorMessage:
      'arrayFilter: callback body must be a single return statement',
    identifierErrorMessage:
      'arrayFilter: callback can only use its parameter and literals',
  });
  return arr.filter((item: any) => {
    const result = evaluate(
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
    return Boolean(result);
  });
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
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
): any {
  let result = evaluateTypeCasting(
    expression,
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    evaluatedFiles,
    context,
    options,
  );
  if (result !== undefined) {
    return result;
  }
  result = evaluateArrayMap(
    expression,
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    evaluatedFiles,
    context,
    options,
  );
  if (result !== undefined) {
    return result;
  }
  result = evaluateArrayFilter(
    expression,
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    evaluatedFiles,
    context,
    options,
  );
  if (result !== undefined) {
    return result;
  }
  result = evaluateEnv(
    expression,
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    evaluatedFiles,
    context,
    options,
  );
  if (result !== undefined) {
    return result;
  }
  throw new ConfTSError(
    `Unsupported call expression in macro mode: ${expression.getText(sourceFile)}`,
    {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
    },
  );
}
