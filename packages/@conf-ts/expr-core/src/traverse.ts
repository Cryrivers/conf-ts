import type {
  ArrowParam,
  ASTNode,
  IdentifierNode,
  IdentifierParam,
} from './types';

const ignore = () => {};

/**
 * Walks how an arrow function binds `params`, in the order its evaluation
 * does: `onDefault` gets each default value as it would be evaluated, and
 * `onBind` each name as it becomes bound. A destructuring pattern's own
 * default (`= c` in `({a = b} = c) => a`) comes first, then each element's
 * default and name, so a default only sees the names bound before it.
 */
export const forEachParamBinding = (
  params: readonly ArrowParam[],
  onDefault: (value: ASTNode) => void,
  onBind: (name: string) => void,
): void => {
  const bind = (element: IdentifierParam | null) => {
    if (element) {
      if (element.default !== undefined) {
        onDefault(element.default);
      }
      onBind(element.name);
    }
  };
  for (const param of params) {
    switch (param.kind) {
      case 'identifier':
        bind(param);
        break;
      case 'rest':
        onBind(param.name);
        break;
      case 'object':
      case 'array':
        if (param.default !== undefined) {
          onDefault(param.default);
        }
        if (param.kind === 'object') {
          for (const property of param.properties) {
            bind(property.value);
          }
        } else {
          for (const element of param.elements) {
            bind(element);
          }
        }
        break;
    }
  }
};

/**
 * Calls `visitor` with each direct child expression of `node`, in evaluation
 * order. The children are the subexpressions the node evaluates, so a few
 * parts of the tree are left out or looked through:
 *
 * - The property of a non-computed member access (`b` in `a.b`) is a name,
 *   not an expression, and is skipped; a computed one (`a[b]`) is visited.
 * - Spread elements (`...x`) are visited as their argument.
 * - A tagged template's children are its tag and then its interpolations.
 * - An arrow function's children are its parameters' default values, in
 *   `forEachParamBinding` order, then its body. Use `collectFreeIdentifiers`
 *   for the names an arrow doesn't bind.
 *
 * Array holes are visited as `Elision` nodes.
 */
export const forEachChild = (
  node: ASTNode,
  visitor: (child: ASTNode) => void,
): void => {
  switch (node.type) {
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
      for (const arg of node.args) {
        visitor(arg);
      }
      return;
    case 'ArrayExpression':
      for (const element of node.elements) {
        visitor(element.type === 'SpreadElement' ? element.argument : element);
      }
      return;
    case 'ObjectExpression':
      for (const property of node.properties) {
        if ('type' in property) {
          visitor(property.argument);
        } else {
          if (property.computed) {
            visitor(property.key);
          }
          visitor(property.value);
        }
      }
      return;
    case 'TemplateLiteral':
      for (const expression of node.expressions) {
        visitor(expression);
      }
      return;
    case 'TaggedTemplateExpression':
      visitor(node.tag);
      for (const expression of node.quasi.expressions) {
        visitor(expression);
      }
      return;
    case 'ArrowFunctionExpression':
      forEachParamBinding(node.params, value => visitor(value), ignore);
      visitor(node.body);
      return;
    default:
      // Literal, Identifier, Elision, or something that is not an expression
      // node (e.g. a SpreadElement passed in directly): no children.
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
  } else if (node.type === 'ArrowFunctionExpression') {
    const local = new Set(bound);
    forEachParamBinding(
      node.params,
      value => collect(value, local, found),
      name => local.add(name),
    );
    collect(node.body, local, found);
  } else {
    forEachChild(node, child => collect(child, bound, found));
  }
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
