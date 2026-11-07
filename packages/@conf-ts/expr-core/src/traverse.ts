import type {
  ArrowParam,
  ASTNode,
  IdentifierNode,
  IdentifierParam,
  SpreadElement,
} from './types';

// Default values of an arrow's parameters, in the order they are evaluated:
// each parameter's own (or whole-pattern) default, then those of its pattern
// elements.
const paramDefaults = (params: ArrowParam[]): ASTNode[] => {
  const defaults: ASTNode[] = [];
  for (const param of params) {
    if (param.kind === 'rest') {
      continue;
    }
    if (param.default !== undefined) {
      defaults.push(param.default);
    }
    const elements: Array<IdentifierParam | null> =
      param.kind === 'object'
        ? param.properties.map(property => property.value)
        : param.kind === 'array'
          ? param.elements
          : [];
    for (const element of elements) {
      if (element?.default !== undefined) {
        defaults.push(element.default);
      }
    }
  }
  return defaults;
};

const isSpread = (node: ASTNode | SpreadElement): node is SpreadElement =>
  node.type === 'SpreadElement';

/**
 * Calls `visitor` with each direct child expression of `node`, in evaluation
 * order. The children are the subexpressions the node evaluates, so a few
 * parts of the tree are left out or looked through:
 *
 * - The property of a non-computed member access (`b` in `a.b`) is a name,
 *   not an expression, and is skipped; a computed one (`a[b]`) is visited.
 * - Spread elements (`...x`) are visited as their argument.
 * - A tagged template's children are its tag and then its interpolations.
 * - An arrow function's children are its parameters' default values, then
 *   its body. A destructuring pattern's own default (`= c` in `({a = b} = c)
 *   => a`) comes before its elements' defaults, as it is evaluated first. Use
 *   `collectFreeIdentifiers` for the names an arrow doesn't bind.
 *
 * Array holes are visited as `Elision` nodes.
 */
export const forEachChild = (
  node: ASTNode,
  visitor: (child: ASTNode) => void,
): void => {
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
    case 'Elision':
      return;
    case 'ParenthesizedExpression':
    case 'ChainExpression':
      visitor(node.expression);
      return;
    case 'UnaryExpression':
      visitor(node.argument);
      return;
    case 'BinaryExpression':
    case 'LogicalExpression':
      visitor(node.left);
      visitor(node.right);
      return;
    case 'ConditionalExpression':
      visitor(node.test);
      visitor(node.consequent);
      visitor(node.alternate);
      return;
    case 'MemberExpression':
      visitor(node.object);
      if (node.computed) {
        visitor(node.property);
      }
      return;
    case 'CallExpression':
      visitor(node.callee);
      node.args.forEach(arg => visitor(arg));
      return;
    case 'ArrayExpression':
      for (const element of node.elements) {
        visitor(isSpread(element) ? element.argument : element);
      }
      return;
    case 'ObjectExpression':
      for (const property of node.properties) {
        if ((property as SpreadElement).type === 'SpreadElement') {
          visitor((property as SpreadElement).argument);
        } else if ('key' in property) {
          if (property.computed) {
            visitor(property.key);
          }
          visitor(property.value);
        }
      }
      return;
    case 'TemplateLiteral':
      node.expressions.forEach(expression => visitor(expression));
      return;
    case 'TaggedTemplateExpression':
      visitor(node.tag);
      node.quasi.expressions.forEach(expression => visitor(expression));
      return;
    case 'ArrowFunctionExpression':
      paramDefaults(node.params).forEach(value => visitor(value));
      visitor(node.body);
      return;
    default:
      // Not an expression node (e.g. a SpreadElement passed in directly).
      return;
  }
};

/** The direct child expressions of `node`, as visited by `forEachChild`. */
export const getChildren = (node: ASTNode): ASTNode[] => {
  const children: ASTNode[] = [];
  forEachChild(node, child => {
    children.push(child);
  });
  return children;
};

const collect = (
  node: ASTNode,
  bound: ReadonlySet<string>,
  found: IdentifierNode[],
): void => {
  if (node.type === 'Identifier') {
    if (!bound.has(node.name)) {
      found.push(node);
    }
    return;
  }
  if (node.type !== 'ArrowFunctionExpression') {
    forEachChild(node, child => collect(child, bound, found));
    return;
  }
  // Parameters are bound in order, so a default value only sees the
  // parameters before it; a name it reads that a later parameter binds still
  // refers to the enclosing scope (as when the evaluator runs it).
  const local = new Set(bound);
  const bind = (param: IdentifierParam) => {
    if (param.default !== undefined) {
      collect(param.default, local, found);
    }
    local.add(param.name);
  };
  for (const param of node.params) {
    switch (param.kind) {
      case 'identifier':
        bind(param);
        break;
      case 'rest':
        local.add(param.name);
        break;
      case 'object':
      case 'array':
        if (param.default !== undefined) {
          collect(param.default, local, found);
        }
        for (const element of param.kind === 'object'
          ? param.properties.map(property => property.value)
          : param.elements) {
          if (element) {
            bind(element);
          }
        }
        break;
    }
  }
  collect(node.body, local, found);
};

/**
 * Every identifier in `node` that reads a name from the environment the
 * expression is evaluated with, i.e. one not bound by an enclosing arrow
 * function parameter. Each occurrence is listed, in `forEachChild` order;
 * builtins such as `String` are included, since an environment value of the
 * same name takes precedence over them. Map to `name` (and dedupe) for the
 * set of names.
 */
export const collectFreeIdentifiers = (node: ASTNode): IdentifierNode[] => {
  const found: IdentifierNode[] = [];
  collect(node, new Set(), found);
  return found;
};
