import { parse, tokenize, type ASTNode } from '@conf-ts/expr-core';

const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/;

function validateContextNode(
  node: ASTNode,
  contextName: string,
  contextAccess = false,
): void {
  if (node.type === 'Identifier') {
    if (node.name === contextName && !contextAccess) {
      throw new Error(
        'expr callback cannot use the context parameter directly',
      );
    }
    return;
  }

  switch (node.type) {
    case 'Literal':
    case 'Elision':
      return;
    case 'ParenthesizedExpression':
      validateContextNode(node.expression, contextName);
      return;
    case 'ChainExpression':
      validateContextNode(node.expression, contextName, contextAccess);
      return;
    case 'MemberExpression': {
      if (
        node.object.type === 'Identifier' &&
        node.object.name === contextName &&
        node.computed &&
        node.property.type === 'Literal' &&
        (typeof node.property.value !== 'string' ||
          !IDENTIFIER_RE.test(node.property.value))
      ) {
        throw new Error(
          'expr callback can only access context properties with identifier property names',
        );
      }
      validateContextNode(node.object, contextName, true);
      validateContextNode(node.property, contextName);
      return;
    }
    case 'UnaryExpression':
      validateContextNode(node.argument, contextName);
      return;
    case 'BinaryExpression':
    case 'LogicalExpression':
      validateContextNode(node.left, contextName);
      validateContextNode(node.right, contextName);
      return;
    case 'ConditionalExpression':
      validateContextNode(node.test, contextName);
      validateContextNode(node.consequent, contextName);
      validateContextNode(node.alternate, contextName);
      return;
    case 'CallExpression':
      validateContextNode(node.callee, contextName);
      node.args.forEach(arg => validateContextNode(arg, contextName));
      return;
    case 'ArrayExpression':
      node.elements.forEach(element =>
        validateContextNode(element, contextName),
      );
      return;
    case 'ObjectExpression':
      node.properties.forEach(property =>
        validateContextNode(
          'type' in property ? property.argument : property.value,
          contextName,
        ),
      );
      return;
    case 'TemplateLiteral':
      node.expressions.forEach(expression =>
        validateContextNode(expression, contextName),
      );
      return;
    case 'TaggedTemplateExpression':
      validateContextNode(node.tag, contextName);
      validateContextNode(node.quasi, contextName);
  }
}

export function validateContextExpression(
  source: string,
  contextName: string,
): void {
  const ast = parse(tokenize(source), source);
  if (!ast) {
    throw new Error('parse expression error: ' + source);
  }
  validateContextNode(ast, contextName);
}
