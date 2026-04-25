import ts from 'typescript';

import { MACRO_FUNCTIONS } from './constants';
import { ConfTSError } from './error';
import { evaluateMacro } from './macro';
import { FormattedNumber } from './shared';

const macroModuleSpecifiers = ["'@conf-ts/macro'", '"@conf-ts/macro"'];

function resolveArrayPatternElement(
  sourceArr: unknown,
  pattern: ts.ArrayBindingPattern,
  binding: ts.BindingElement,
): any {
  const arr: any[] = Array.isArray(sourceArr) ? sourceArr : [];
  const index = pattern.elements.indexOf(binding);
  return binding.dotDotDotToken ? arr.slice(index) : arr[index];
}

type EvalResult = { found: true; value: any } | { found: false };

function getPropertyNameText(
  name: ts.PropertyName,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  macro: boolean,
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
): string {
  if (ts.isComputedPropertyName(name)) {
    return String(
      evaluate(
        name.expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        context,
        options,
      ),
    );
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(sourceFile);
}

function getBindingPropertyName(
  binding: ts.BindingElement,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  macro: boolean,
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
): string {
  if (binding.propertyName) {
    return getPropertyNameText(
      binding.propertyName,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
  }
  if (ts.isIdentifier(binding.name)) {
    return binding.name.text;
  }
  return binding.name.getText(sourceFile);
}

function resolveBindingName(
  targetName: string,
  bindingName: ts.BindingName,
  value: any,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  macro: boolean,
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
): EvalResult {
  if (ts.isIdentifier(bindingName)) {
    return bindingName.text === targetName
      ? { found: true, value }
      : { found: false };
  }
  if (ts.isObjectBindingPattern(bindingName)) {
    return resolveObjectBindingPattern(
      targetName,
      bindingName,
      value,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
  }
  return resolveArrayBindingPattern(
    targetName,
    bindingName,
    value,
    sourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    macro,
    evaluatedFiles,
    context,
    options,
  );
}

function resolveObjectBindingPattern(
  targetName: string,
  pattern: ts.ObjectBindingPattern,
  sourceObj: any,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  macro: boolean,
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
): EvalResult {
  const obj = sourceObj && typeof sourceObj === 'object' ? sourceObj : {};

  for (const binding of pattern.elements) {
    let value: any;
    if (binding.dotDotDotToken) {
      const keysToRemove = new Set<string>();
      for (const el of pattern.elements) {
        if (el === binding || el.dotDotDotToken) continue;
        keysToRemove.add(
          getBindingPropertyName(
            el,
            sourceFile,
            typeChecker,
            enumMap,
            macroImportsMap,
            macro,
            evaluatedFiles,
            context,
            options,
          ),
        );
      }
      value = {};
      for (const key of Object.keys(obj)) {
        if (!keysToRemove.has(key)) {
          value[key] = obj[key];
        }
      }
    } else {
      const keyName = getBindingPropertyName(
        binding,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        context,
        options,
      );
      value = obj[keyName];
      if (value === undefined && binding.initializer) {
        value = evaluate(
          binding.initializer,
          sourceFile,
          typeChecker,
          enumMap,
          macroImportsMap,
          macro,
          evaluatedFiles,
          context,
          options,
        );
      }
    }

    const resolved = resolveBindingName(
      targetName,
      binding.name,
      value,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
    if (resolved.found) {
      return resolved;
    }
  }

  return { found: false };
}

function resolveArrayBindingPattern(
  targetName: string,
  pattern: ts.ArrayBindingPattern,
  sourceArr: any,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  macro: boolean,
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
): EvalResult {
  const arr = Array.isArray(sourceArr) ? sourceArr : [];

  for (let index = 0; index < pattern.elements.length; index++) {
    const binding = pattern.elements[index];
    if (!binding || ts.isOmittedExpression(binding)) {
      continue;
    }

    let value = binding.dotDotDotToken ? arr.slice(index) : arr[index];
    if (value === undefined && binding.initializer) {
      value = evaluate(
        binding.initializer,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        context,
        options,
      );
    }

    const resolved = resolveBindingName(
      targetName,
      binding.name,
      value,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
    if (resolved.found) {
      return resolved;
    }
  }

  return { found: false };
}

function resolveBindingElementValue(
  targetName: string,
  binding: ts.BindingElement,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  macro: boolean,
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
): any {
  let root: ts.Node = binding.parent;
  while (ts.isBindingElement(root.parent)) {
    root = root.parent.parent;
  }
  if (
    !(ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) ||
    !ts.isVariableDeclaration(root.parent) ||
    !root.parent.initializer
  ) {
    return undefined;
  }

  const bindingSourceFile = root.parent.getSourceFile();
  const sourceValue = evaluate(
    root.parent.initializer,
    bindingSourceFile,
    typeChecker,
    enumMap,
    macroImportsMap,
    macro,
    evaluatedFiles,
    context,
    options,
  );

  const resolved = ts.isObjectBindingPattern(root)
    ? resolveObjectBindingPattern(
        targetName,
        root,
        sourceValue,
        bindingSourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        context,
        options,
      )
    : resolveArrayBindingPattern(
        targetName,
        root,
        sourceValue,
        bindingSourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        context,
        options,
      );

  return resolved.found ? resolved.value : undefined;
}

function getEnumMemberName(
  name: ts.PropertyName,
  sourceFile: ts.SourceFile,
): string {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return name.getText(sourceFile);
}

function evaluateEnumDeclaration(
  declaration: ts.EnumDeclaration,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  macro: boolean,
  evaluatedFiles: Set<string>,
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
): Record<string, any> {
  const declSourceFile = declaration.getSourceFile();
  const enumName = declaration.name.getText(declSourceFile);
  const fileEnums = enumMap[declSourceFile.fileName] || {};
  const result: Record<string, any> = {};
  evaluatedFiles.add(declSourceFile.fileName);

  for (const member of declaration.members) {
    const memberName = getEnumMemberName(member.name, declSourceFile);
    const fullEnumMemberName = `${enumName}.${memberName}`;
    if (Object.prototype.hasOwnProperty.call(fileEnums, fullEnumMemberName)) {
      result[memberName] = fileEnums[fullEnumMemberName];
    } else if (member.initializer) {
      result[memberName] = evaluate(
        member.initializer,
        declSourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        undefined,
        options,
      );
    }
    const value = result[memberName];
    if (typeof value === 'number' || value instanceof FormattedNumber) {
      result[String(Number(value))] = memberName;
    }
  }

  return result;
}

export function evaluate(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  enumMap: { [filePath: string]: { [key: string]: any } },
  macroImportsMap: { [filePath: string]: Set<string> },
  macro: boolean,
  evaluatedFiles: Set<string>,
  context?: { [name: string]: any },
  options?: { preserveKeyOrder?: boolean; env?: Record<string, string> },
): any {
  evaluatedFiles.add(sourceFile.fileName);
  if (macro) {
    // Populate macroImportsMap for the current sourceFile
    if (!macroImportsMap[sourceFile.fileName]) {
      macroImportsMap[sourceFile.fileName] = new Set<string>();
      sourceFile.statements.forEach(statement => {
        if (ts.isImportDeclaration(statement)) {
          const moduleSpecifier = statement.moduleSpecifier.getText(sourceFile);
          if (macroModuleSpecifiers.includes(moduleSpecifier)) {
            if (
              statement.importClause &&
              statement.importClause.namedBindings
            ) {
              const namedBindings = statement.importClause.namedBindings;
              if (ts.isNamedImports(namedBindings)) {
                namedBindings.elements.forEach(element => {
                  macroImportsMap[sourceFile.fileName].add(
                    element.name.getText(sourceFile),
                  );
                });
              }
            }
          }
        }
      });
    }
  }
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  } else if (ts.isTemplateExpression(expression)) {
    let result = expression.head.text;
    for (const span of expression.templateSpans) {
      result += evaluate(
        span.expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        context,
        options,
      );
      result += span.literal.text;
    }
    return result;
  } else if (ts.isNumericLiteral(expression)) {
    const text = expression.getText(sourceFile);
    if (
      text.includes('.') ||
      text.includes('e') ||
      text.includes('E') ||
      text.startsWith('0x') ||
      text.startsWith('0b') ||
      text.startsWith('0o')
    ) {
      return new FormattedNumber(Number(expression.text), text);
    }
    return Number(expression.text);
  } else if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  } else if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  } else if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  } else if (ts.isObjectLiteralExpression(expression)) {
    const obj: { [key: string]: any } = {};
    expression.properties.forEach(prop => {
      if (ts.isPropertyAssignment(prop)) {
        const name = getPropertyNameText(
          prop.name,
          sourceFile,
          typeChecker,
          enumMap,
          macroImportsMap,
          macro,
          evaluatedFiles,
          context,
          options,
        );
        obj[name] = evaluate(
          prop.initializer,
          sourceFile,
          typeChecker,
          enumMap,
          macroImportsMap,
          macro,
          evaluatedFiles,
          context,
          options,
        );
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name.getText(sourceFile);
        const shorthandSymbol =
          typeChecker.getShorthandAssignmentValueSymbol(prop);
        if (shorthandSymbol) {
          let resolvedSymbol = shorthandSymbol;
          if (shorthandSymbol.flags & ts.SymbolFlags.Alias) {
            resolvedSymbol = typeChecker.getAliasedSymbol(shorthandSymbol);
          }

          if (
            resolvedSymbol.valueDeclaration &&
            ts.isVariableDeclaration(resolvedSymbol.valueDeclaration) &&
            resolvedSymbol.valueDeclaration.initializer
          ) {
            obj[name] = evaluate(
              resolvedSymbol.valueDeclaration.initializer,
              resolvedSymbol.valueDeclaration.getSourceFile(),
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              context,
              options,
            );
          } else if (
            resolvedSymbol.valueDeclaration &&
            ts.isBindingElement(resolvedSymbol.valueDeclaration)
          ) {
            obj[name] = resolveBindingElementValue(
              name,
              resolvedSymbol.valueDeclaration,
              sourceFile,
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              context,
              options,
            );
          } else if (
            resolvedSymbol.valueDeclaration &&
            ts.isEnumDeclaration(resolvedSymbol.valueDeclaration)
          ) {
            obj[name] = evaluateEnumDeclaration(
              resolvedSymbol.valueDeclaration,
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              options,
            );
          } else {
            throw new ConfTSError(
              `Could not resolve shorthand property '${name}' because its declaration is not a variable or has no initializer.`,
              {
                file: sourceFile.fileName,
                ...ts.getLineAndCharacterOfPosition(
                  sourceFile,
                  prop.getStart(),
                ),
              },
            );
          }
        } else {
          throw new ConfTSError(
            `Could not find symbol for shorthand property '${name}'.`,
            {
              file: sourceFile.fileName,
              ...ts.getLineAndCharacterOfPosition(sourceFile, prop.getStart()),
            },
          );
        }
      } else if (ts.isSpreadAssignment(prop)) {
        const spreadObj = evaluate(
          prop.expression,
          sourceFile,
          typeChecker,
          enumMap,
          macroImportsMap,
          macro,
          evaluatedFiles,
          context,
          options,
        );
        if (options?.preserveKeyOrder) {
          for (const k of Object.keys(spreadObj || {})) {
            obj[k] = spreadObj[k];
          }
        } else {
          Object.assign(obj, spreadObj);
        }
      }
    });
    return obj;
  } else if (ts.isArrayLiteralExpression(expression)) {
    const elements: any[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) {
        const spreadElements = evaluate(
          element.expression,
          sourceFile,
          typeChecker,
          enumMap,
          macroImportsMap,
          macro,
          evaluatedFiles,
          context,
          options,
        );
        elements.push(...spreadElements);
      } else if (ts.isOmittedExpression(element)) {
        elements.push(undefined);
      } else {
        elements.push(
          evaluate(
            element,
            sourceFile,
            typeChecker,
            enumMap,
            macroImportsMap,
            macro,
            evaluatedFiles,
            context,
            options,
          ),
        );
      }
    }
    return elements;
  } else if (ts.isIdentifier(expression)) {
    if (expression.text === 'undefined') {
      return undefined;
    }
    if (
      context &&
      Object.prototype.hasOwnProperty.call(context, expression.text)
    ) {
      return context[expression.text];
    }
    const symbol = typeChecker.getSymbolAtLocation(expression);
    if (symbol) {
      let resolvedSymbol = symbol;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        resolvedSymbol = typeChecker.getAliasedSymbol(symbol);
      }

      if (resolvedSymbol.valueDeclaration) {
        if (ts.isVariableDeclaration(resolvedSymbol.valueDeclaration)) {
          const declarationList = resolvedSymbol.valueDeclaration.parent;
          if (!(declarationList.flags & ts.NodeFlags.Const)) {
            const kind =
              declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
            throw new ConfTSError(
              `Failed to evaluate variable "${expression.text}". Only 'const' declarations are supported, but it was declared with '${kind}'.`,
              {
                file: sourceFile.fileName,
                ...ts.getLineAndCharacterOfPosition(
                  sourceFile,
                  expression.getStart(),
                ),
              },
            );
          }
          if (resolvedSymbol.valueDeclaration.initializer) {
            return evaluate(
              resolvedSymbol.valueDeclaration.initializer,
              resolvedSymbol.valueDeclaration.getSourceFile(),
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              context,
              options,
            );
          }
        } else if (ts.isBindingElement(resolvedSymbol.valueDeclaration)) {
          return resolveBindingElementValue(
            expression.text,
            resolvedSymbol.valueDeclaration,
            sourceFile,
            typeChecker,
            enumMap,
            macroImportsMap,
            macro,
            evaluatedFiles,
            context,
            options,
          );
        } else if (ts.isEnumMember(resolvedSymbol.valueDeclaration)) {
          const declSourceFile =
            resolvedSymbol.valueDeclaration.getSourceFile();
          const enumName =
            resolvedSymbol.valueDeclaration.parent.name.getText(declSourceFile);
          const memberName =
            resolvedSymbol.valueDeclaration.name.getText(declSourceFile);
          const fullEnumMemberName = `${enumName}.${memberName}`;
          if (
            enumMap[declSourceFile.fileName] &&
            enumMap[declSourceFile.fileName].hasOwnProperty(fullEnumMemberName)
          ) {
            evaluatedFiles.add(declSourceFile.fileName);
            return enumMap[declSourceFile.fileName][fullEnumMemberName];
          }
        } else if (ts.isEnumDeclaration(resolvedSymbol.valueDeclaration)) {
          return evaluateEnumDeclaration(
            resolvedSymbol.valueDeclaration,
            typeChecker,
            enumMap,
            macroImportsMap,
            macro,
            evaluatedFiles,
            options,
          );
        } else if (ts.isExportAssignment(resolvedSymbol.valueDeclaration)) {
          return evaluate(
            resolvedSymbol.valueDeclaration.expression,
            resolvedSymbol.valueDeclaration.getSourceFile(),
            typeChecker,
            enumMap,
            macroImportsMap,
            macro,
            evaluatedFiles,
            context,
            options,
          );
        }
      }
    }
    throw new ConfTSError(
      `Unsupported variable type for identifier: ${expression.text}`,
      {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
      },
    );
  } else if (ts.isElementAccessExpression(expression)) {
    const obj = evaluate(
      expression.expression,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
    if (expression.questionDotToken && (obj === null || obj === undefined)) {
      return undefined;
    }
    if (obj === null || obj === undefined) {
      throw new ConfTSError(
        `Cannot read property of ${obj === null ? 'null' : 'undefined'}`,
        {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(
            sourceFile,
            expression.getStart(),
          ),
        },
      );
    }
    const key = evaluate(
      expression.argumentExpression,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
    if (Array.isArray(obj)) {
      const idx = Number(key);
      return Number.isInteger(idx) && idx >= 0 ? obj[idx] : undefined;
    }
    if (typeof obj === 'object') {
      return (obj as Record<string, any>)[String(key)];
    }
    if (typeof obj === 'string') {
      const idx = Number(key);
      return Number.isInteger(idx) && idx >= 0 ? obj[idx] : undefined;
    }
    throw new ConfTSError(`Unsupported element access on ${typeof obj}`, {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
    });
  } else if (ts.isPropertyAccessExpression(expression)) {
    try {
      const obj = evaluate(
        expression.expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        context,
        options,
      );
      if (expression.questionDotToken && (obj === null || obj === undefined)) {
        return undefined;
      }
      const propertyName = expression.name.getText(sourceFile);
      if (obj !== null && obj !== undefined && typeof obj === 'object') {
        return obj[propertyName];
      }
      if (typeof obj === 'string' && propertyName === 'length') {
        return obj.length;
      }
    } catch {
      // This can happen when the property access is on an enum,
      // so we fall through to the enum handling logic.
    }

    const name = expression.getText(sourceFile);
    if (
      enumMap[sourceFile.fileName] &&
      enumMap[sourceFile.fileName].hasOwnProperty(name)
    ) {
      return enumMap[sourceFile.fileName][name];
    }
    const symbol =
      typeChecker.getSymbolAtLocation(expression) ||
      typeChecker.getSymbolAtLocation(expression.name);
    if (symbol) {
      let resolvedSymbol = symbol;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        resolvedSymbol = typeChecker.getAliasedSymbol(symbol);
      }
      const declarations =
        resolvedSymbol.getDeclarations() || symbol.getDeclarations();
      if (declarations && declarations.length > 0) {
        const declaration = resolvedSymbol.valueDeclaration || declarations[0];
        if (ts.isEnumMember(declaration)) {
          if (declaration.initializer) {
            return evaluate(
              declaration.initializer,
              declaration.getSourceFile(),
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              context,
              options,
            );
          }
          const declSourceFile = declaration.getSourceFile();
          const enumName = declaration.parent.name.getText(declSourceFile);
          const memberName = declaration.name.getText(declSourceFile);
          const fullEnumMemberName = `${enumName}.${memberName}`;
          if (
            enumMap[declSourceFile.fileName] &&
            enumMap[declSourceFile.fileName].hasOwnProperty(fullEnumMemberName)
          ) {
            evaluatedFiles.add(declSourceFile.fileName);
            return enumMap[declSourceFile.fileName][fullEnumMemberName];
          }
        } else if (ts.isVariableDeclaration(declaration)) {
          const declarationList = declaration.parent;
          if (!(declarationList.flags & ts.NodeFlags.Const)) {
            const kind =
              declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
            throw new ConfTSError(
              `Failed to evaluate variable "${expression.getText(sourceFile)}". Only 'const' declarations are supported, but it was declared with '${kind}'.`,
              {
                file: sourceFile.fileName,
                ...ts.getLineAndCharacterOfPosition(
                  sourceFile,
                  expression.getStart(),
                ),
              },
            );
          }
          if (declaration.initializer) {
            return evaluate(
              declaration.initializer,
              declaration.getSourceFile(),
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              context,
              options,
            );
          }
        } else if (ts.isEnumDeclaration(declaration)) {
          return evaluateEnumDeclaration(
            declaration,
            typeChecker,
            enumMap,
            macroImportsMap,
            macro,
            evaluatedFiles,
            options,
          );
        }
      }
    }
    throw new ConfTSError(
      `Unsupported property access expression: ${expression.getText(sourceFile)}`,
      {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
      },
    );
  } else if (ts.isTypeOfExpression(expression)) {
    // `typeof` on an unresolved identifier should yield "undefined" (matches JS).
    let operand: any;
    try {
      operand = evaluate(
        expression.expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        context,
        options,
      );
    } catch {
      operand = undefined;
    }
    return typeof operand;
  } else if (ts.isPrefixUnaryExpression(expression)) {
    const operand = evaluate(
      expression.operand,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );

    switch (expression.operator) {
      case ts.SyntaxKind.PlusToken:
        return +operand;
      case ts.SyntaxKind.MinusToken:
        return -operand;
      case ts.SyntaxKind.ExclamationToken:
        return !operand;
      case ts.SyntaxKind.TildeToken:
        return ~operand;
      default:
        throw new ConfTSError(
          `Unsupported unary operator: ${ts.SyntaxKind[expression.operator]}`,
          {
            file: sourceFile.fileName,
            ...ts.getLineAndCharacterOfPosition(
              sourceFile,
              expression.getStart(),
            ),
          },
        );
    }
  } else if (ts.isBinaryExpression(expression)) {
    const left = evaluate(
      expression.left,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );

    // Short-circuiting operators: only evaluate the right operand when needed.
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return left
          ? evaluate(
              expression.right,
              sourceFile,
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              context,
              options,
            )
          : left;
      case ts.SyntaxKind.BarBarToken:
        return left
          ? left
          : evaluate(
              expression.right,
              sourceFile,
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              context,
              options,
            );
      case ts.SyntaxKind.QuestionQuestionToken:
        return left !== null && left !== undefined
          ? left
          : evaluate(
              expression.right,
              sourceFile,
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              context,
              options,
            );
    }

    const right = evaluate(
      expression.right,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );

    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.CommaToken:
        return right;
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return left ** right;
      case ts.SyntaxKind.SlashToken:
        return left / right;
      case ts.SyntaxKind.PercentToken:
        return left % right;
      case ts.SyntaxKind.GreaterThanToken:
        return left > right;
      case ts.SyntaxKind.LessThanToken:
        return left < right;
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return left >= right;
      case ts.SyntaxKind.LessThanEqualsToken:
        return left <= right;
      case ts.SyntaxKind.EqualsEqualsToken:
        return left == right;
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return left === right;
      case ts.SyntaxKind.ExclamationEqualsToken:
        return left != right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return left !== right;
      case ts.SyntaxKind.AmpersandToken:
        return left & right;
      case ts.SyntaxKind.BarToken:
        return left | right;
      case ts.SyntaxKind.CaretToken:
        return left ^ right;
      case ts.SyntaxKind.LessThanLessThanToken:
        return left << right;
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
        return left >> right;
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
        return left >>> right;
      case ts.SyntaxKind.InKeyword: {
        if (right === null || right === undefined) {
          throw new ConfTSError(
            "Cannot use 'in' operator on null or undefined",
            {
              file: sourceFile.fileName,
              ...ts.getLineAndCharacterOfPosition(
                sourceFile,
                expression.getStart(),
              ),
            },
          );
        }
        return String(left) in (right as object);
      }
      default:
        throw new ConfTSError(
          `Unsupported binary operator: ${
            ts.SyntaxKind[expression.operatorToken.kind]
          }`,
          {
            file: sourceFile.fileName,
            ...ts.getLineAndCharacterOfPosition(
              sourceFile,
              expression.getStart(),
            ),
          },
        );
    }
  } else if (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression)
  ) {
    throw new ConfTSError('Unsupported type: Function', {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
    });
  } else if (ts.isNewExpression(expression)) {
    if (expression.expression.getText(sourceFile) === 'Date') {
      throw new ConfTSError('Unsupported type: Date', {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
      });
    }
    throw new ConfTSError(
      `Unsupported "new" expression: ${expression.expression.getText(sourceFile)}`,
      {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
      },
    );
  } else if (ts.isCallExpression(expression)) {
    if (expression.questionDotToken) {
      const callee = evaluate(
        expression.expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        macro,
        evaluatedFiles,
        context,
        options,
      );
      if (callee === null || callee === undefined) {
        return undefined;
      }
    }
    if (macro) {
      return evaluateMacro(
        expression,
        sourceFile,
        typeChecker,
        enumMap,
        macroImportsMap,
        evaluatedFiles,
        context,
        options,
      );
    }
    const callee = expression.expression.getText(sourceFile);
    // @ts-expect-error
    if (MACRO_FUNCTIONS.includes(callee)) {
      throw new ConfTSError(
        `Function "${callee}" is only allowed in macro mode`,
        {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(
            sourceFile,
            expression.getStart(),
          ),
        },
      );
    } else {
      throw new ConfTSError(
        `Unsupported call expression: ${expression.getText(sourceFile)}`,
        {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(
            sourceFile,
            expression.getStart(),
          ),
        },
      );
    }
  } else if (ts.isParenthesizedExpression(expression)) {
    return evaluate(
      expression.expression,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
  } else if (ts.isAsExpression(expression)) {
    // Ignore type assertions like `value as T` and `as const`, return the evaluated value
    return evaluate(
      expression.expression,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
  } else if (ts.isRegularExpressionLiteral(expression)) {
    throw new ConfTSError('Unsupported type: RegExp', {
      file: sourceFile.fileName,
      ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
    });
  } else if (ts.isSatisfiesExpression(expression)) {
    return evaluate(
      expression.expression,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
  } else if (ts.isConditionalExpression(expression)) {
    const condition = evaluate(
      expression.condition,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
    return condition
      ? evaluate(
          expression.whenTrue,
          sourceFile,
          typeChecker,
          enumMap,
          macroImportsMap,
          macro,
          evaluatedFiles,
          context,
          options,
        )
      : evaluate(
          expression.whenFalse,
          sourceFile,
          typeChecker,
          enumMap,
          macroImportsMap,
          macro,
          evaluatedFiles,
          context,
          options,
        );
  } else if (ts.isNonNullExpression(expression)) {
    const value = evaluate(
      expression.expression,
      sourceFile,
      typeChecker,
      enumMap,
      macroImportsMap,
      macro,
      evaluatedFiles,
      context,
      options,
    );
    const type = typeChecker.getTypeAtLocation(expression.expression);
    let typeIsStrictNullish = false;
    if (type.flags & ts.TypeFlags.Union) {
      const unionTypes = (type as ts.UnionType).types;
      typeIsStrictNullish = unionTypes.every(
        sub => (sub.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0,
      );
    } else {
      typeIsStrictNullish =
        type.flags === ts.TypeFlags.Null ||
        type.flags === ts.TypeFlags.Undefined;
    }
    if (typeIsStrictNullish) {
      throw new ConfTSError(
        "Non-null assertion applied to value typed as 'null' or 'undefined'",
        {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(
            sourceFile,
            expression.getStart(),
          ),
        },
      );
    }
    if (value === null || value === undefined) {
      throw new ConfTSError(
        'Non-null assertion failed: value is null or undefined',
        {
          file: sourceFile.fileName,
          ...ts.getLineAndCharacterOfPosition(
            sourceFile,
            expression.getStart(),
          ),
        },
      );
    }
    return value;
  } else {
    throw new ConfTSError(
      `Unsupported syntax kind: ${ts.SyntaxKind[expression.kind]}`,
      {
        file: sourceFile.fileName,
        ...ts.getLineAndCharacterOfPosition(sourceFile, expression.getStart()),
      },
    );
  }
}
