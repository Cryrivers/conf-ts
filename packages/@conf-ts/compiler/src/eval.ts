import ts from 'typescript';

import { MACRO_FUNCTIONS } from './constants';
import { ConfTSError, SourceLocation } from './error';
import { evaluateMacro } from './macro';

const macroModuleSpecifiers = ["'@conf-ts/macro'", '"@conf-ts/macro"'];

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
        let name: string;
        if (ts.isComputedPropertyName(prop.name)) {
          name = evaluate(
            prop.name.expression,
            sourceFile,
            typeChecker,
            enumMap,
            macroImportsMap,
            macro,
            evaluatedFiles,
            context,
            options,
          );
        } else if (ts.isIdentifier(prop.name)) {
          name = prop.name.text;
        } else if (ts.isStringLiteral(prop.name)) {
          name = prop.name.text;
        } else {
          name = prop.name.getText(sourceFile);
        }
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
            );
          } else if (
            resolvedSymbol.valueDeclaration &&
            ts.isBindingElement(resolvedSymbol.valueDeclaration)
          ) {
            const binding = resolvedSymbol.valueDeclaration;
            const pattern = binding.parent;
            const varDeclParent = pattern.parent;
            if (
              ts.isObjectBindingPattern(pattern) &&
              ts.isVariableDeclaration(varDeclParent) &&
              varDeclParent.initializer
            ) {
              const sourceObj = evaluate(
                varDeclParent.initializer,
                varDeclParent.getSourceFile(),
                typeChecker,
                enumMap,
                macroImportsMap,
                macro,
                evaluatedFiles,
                context,
                options,
              );

              if (binding.dotDotDotToken) {
                const keysToRemove = new Set<string>();
                for (const el of pattern.elements) {
                  if (el === binding) continue;
                  if (el.dotDotDotToken) continue;
                  let keyName: string;
                  if (el.propertyName) {
                    if (ts.isIdentifier(el.propertyName)) {
                      keyName = el.propertyName.text;
                    } else if (ts.isStringLiteral(el.propertyName)) {
                      keyName = el.propertyName.text;
                    } else {
                      keyName = el.propertyName.getText(
                        varDeclParent.getSourceFile(),
                      );
                    }
                  } else if (ts.isIdentifier(el.name)) {
                    keyName = el.name.text;
                  } else {
                    keyName = el.name.getText(varDeclParent.getSourceFile());
                  }
                  keysToRemove.add(keyName);
                }
                const restObj: any = {};
                for (const key of Object.keys(sourceObj || {})) {
                  if (!keysToRemove.has(key)) {
                    restObj[key] = sourceObj[key];
                  }
                }
                obj[name] = restObj;
              } else {
                let keyName: string;
                if (binding.propertyName) {
                  if (ts.isIdentifier(binding.propertyName)) {
                    keyName = binding.propertyName.text;
                  } else if (ts.isStringLiteral(binding.propertyName)) {
                    keyName = binding.propertyName.text;
                  } else {
                    keyName = binding.propertyName.getText(
                      varDeclParent.getSourceFile(),
                    );
                  }
                } else if (ts.isIdentifier(binding.name)) {
                  keyName = binding.name.text;
                } else {
                  keyName = binding.name.getText(varDeclParent.getSourceFile());
                }
                obj[name] = sourceObj ? sourceObj[keyName] : undefined;
              }
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
          const binding = resolvedSymbol.valueDeclaration;
          const pattern = binding.parent;
          const varDeclParent = pattern.parent;
          if (
            ts.isObjectBindingPattern(pattern) &&
            ts.isVariableDeclaration(varDeclParent) &&
            varDeclParent.initializer
          ) {
            const sourceObj = evaluate(
              varDeclParent.initializer,
              varDeclParent.getSourceFile(),
              typeChecker,
              enumMap,
              macroImportsMap,
              macro,
              evaluatedFiles,
              context,
              options,
            );

            if (binding.dotDotDotToken) {
              const keysToRemove = new Set<string>();
              for (const el of pattern.elements) {
                if (el === binding) continue;
                if (el.dotDotDotToken) continue;
                let keyName: string;
                if (el.propertyName) {
                  if (ts.isIdentifier(el.propertyName)) {
                    keyName = el.propertyName.text;
                  } else if (ts.isStringLiteral(el.propertyName)) {
                    keyName = el.propertyName.text;
                  } else {
                    keyName = el.propertyName.getText(
                      varDeclParent.getSourceFile(),
                    );
                  }
                } else if (ts.isIdentifier(el.name)) {
                  keyName = el.name.text;
                } else {
                  keyName = el.name.getText(varDeclParent.getSourceFile());
                }
                keysToRemove.add(keyName);
              }
              const restObj: any = {};
              for (const key of Object.keys(sourceObj || {})) {
                if (!keysToRemove.has(key)) {
                  restObj[key] = sourceObj[key];
                }
              }
              return restObj;
            } else {
              let keyName: string;
              if (binding.propertyName) {
                if (ts.isIdentifier(binding.propertyName)) {
                  keyName = binding.propertyName.text;
                } else if (ts.isStringLiteral(binding.propertyName)) {
                  keyName = binding.propertyName.text;
                } else {
                  keyName = binding.propertyName.getText(
                    varDeclParent.getSourceFile(),
                  );
                }
              } else if (ts.isIdentifier(binding.name)) {
                keyName = binding.name.text;
              } else {
                keyName = binding.name.getText(varDeclParent.getSourceFile());
              }
              return sourceObj ? sourceObj[keyName] : undefined;
            }
          }
        } else if (ts.isEnumMember(resolvedSymbol.valueDeclaration)) {
          const enumName = resolvedSymbol.valueDeclaration.parent.name.getText(
            resolvedSymbol.valueDeclaration.getSourceFile(),
          );
          const memberName = resolvedSymbol.valueDeclaration.name.getText(
            resolvedSymbol.valueDeclaration.getSourceFile(),
          );
          const fullEnumMemberName = `${enumName}.${memberName}`;
          if (
            enumMap[sourceFile.fileName] &&
            enumMap[sourceFile.fileName].hasOwnProperty(fullEnumMemberName)
          ) {
            return enumMap[sourceFile.fileName][fullEnumMemberName];
          }
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
      const propertyName = expression.name.getText(sourceFile);
      if (obj && typeof obj === 'object' && propertyName in obj) {
        return obj[propertyName];
      }
    } catch (error) {
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
    const symbol = typeChecker.getSymbolAtLocation(expression);
    if (symbol) {
      const declarations = symbol.getDeclarations();
      if (declarations && declarations.length > 0) {
        const declaration = declarations[0];
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
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
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
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return left && right;
      case ts.SyntaxKind.BarBarToken:
        return left || right;
      case ts.SyntaxKind.QuestionQuestionToken:
        return left ?? right;
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
