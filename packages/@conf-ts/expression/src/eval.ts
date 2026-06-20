import type {
  ASTNode,
  BinaryNode,
  CallNode,
  Env,
  IdentifierNode,
  LiteralNode,
  LogicalNode,
  MemberNode,
  ObjectProperty,
  SpreadElement,
  TaggedTemplateNode,
  UnaryNode,
} from './ast/types';

const CHAIN_SHORT_CIRCUIT = Symbol('chain-short-circuit');

type ChainResult = unknown | typeof CHAIN_SHORT_CIRCUIT;
type Reference = {
  value: unknown;
  object: unknown;
  key: PropertyKey;
};

const toKey = (key: unknown): PropertyKey =>
  typeof key === 'symbol' ? key : String(key);

const propertyKey = (node: MemberNode, env: Env): PropertyKey =>
  node.computed
    ? toKey(evaluate(node.property, env))
    : String((node.property as LiteralNode).value);

const nullishMemberError = (): never => {
  throw new TypeError('Cannot read properties of null or undefined');
};

const nonCallableError = (): never => {
  throw new TypeError('Expression value is not callable');
};

const memberReference = (
  node: MemberNode,
  env: Env,
  chain: boolean,
): Reference | typeof CHAIN_SHORT_CIRCUIT => {
  const object = chain
    ? evaluateChainOperand(node.object, env)
    : evaluate(node.object, env);
  if (object === CHAIN_SHORT_CIRCUIT) {
    return CHAIN_SHORT_CIRCUIT;
  }
  if (object === null || object === undefined) {
    if (node.optional) {
      return CHAIN_SHORT_CIRCUIT;
    }
    return nullishMemberError();
  }
  const key = propertyKey(node, env);
  return {
    value: (object as Record<PropertyKey, unknown>)[key],
    object,
    key,
  };
};

const evaluateChainOperand = (node: ASTNode, env: Env): ChainResult => {
  if (node.type === 'MemberExpression') {
    const reference = memberReference(node, env, true);
    return reference === CHAIN_SHORT_CIRCUIT ? reference : reference.value;
  }
  if (node.type === 'CallExpression') {
    return evaluateCall(node, env, true);
  }
  return evaluate(node, env);
};

const evaluateCall = (
  node: CallNode,
  env: Env,
  chain: boolean,
): ChainResult => {
  let value: unknown;
  let thisArg: unknown = undefined;

  if (node.callee.type === 'MemberExpression') {
    const reference = memberReference(node.callee, env, chain);
    if (reference === CHAIN_SHORT_CIRCUIT) {
      return reference;
    }
    value = reference.value;
    thisArg = reference.object;
  } else {
    const callee = chain
      ? evaluateChainOperand(node.callee, env)
      : evaluate(node.callee, env);
    if (callee === CHAIN_SHORT_CIRCUIT) {
      return callee;
    }
    value = callee;
  }

  if (node.optional && (value === null || value === undefined)) {
    return CHAIN_SHORT_CIRCUIT;
  }
  if (typeof value !== 'function') {
    return nonCallableError();
  }

  const args = node.args.map(arg => evaluate(arg, env));
  return Reflect.apply(value, thisArg, args);
};

const evaluateIdentifier = (node: IdentifierNode, env: Env): unknown =>
  env[node.name];

const deleteExpression = (node: ASTNode, env: Env): boolean => {
  if (node.type === 'ParenthesizedExpression') {
    return deleteExpression(node.expression, env);
  }
  if (node.type === 'ChainExpression') {
    const expression = node.expression;
    if (expression.type !== 'MemberExpression') {
      evaluate(expression, env);
      return true;
    }
    const reference = memberReference(expression, env, true);
    if (reference === CHAIN_SHORT_CIRCUIT) {
      return true;
    }
    return delete (reference.object as Record<PropertyKey, unknown>)[
      reference.key
    ];
  }
  if (node.type === 'Identifier') {
    return delete env[node.name];
  }
  if (node.type === 'MemberExpression') {
    const reference = memberReference(node, env, false);
    if (reference === CHAIN_SHORT_CIRCUIT) {
      return true;
    }
    return delete (reference.object as Record<PropertyKey, unknown>)[
      reference.key
    ];
  }
  evaluate(node, env);
  return true;
};

const evaluateUnary = (node: UnaryNode, env: Env): unknown => {
  if (node.operator === 'delete') {
    return deleteExpression(node.argument, env);
  }

  const value = evaluate(node.argument, env);
  switch (node.operator) {
    case '!':
      return !value;
    case '+':
      return +(value as any);
    case '-':
      return -(value as any);
    case '~':
      return ~(value as any);
    case 'void':
      return undefined;
    case 'typeof':
      return typeof value;
  }
};

const evaluateBinary = (node: BinaryNode, env: Env): unknown => {
  const left = evaluate(node.left, env);
  const right = evaluate(node.right, env);
  switch (node.operator) {
    case '+':
      return (left as any) + (right as any);
    case '-':
      return (left as any) - (right as any);
    case '*':
      return (left as any) * (right as any);
    case '**':
      return (left as any) ** (right as any);
    case '/':
      return (left as any) / (right as any);
    case '%':
      return (left as any) % (right as any);
    case '&':
      return (left as any) & (right as any);
    case '|':
      return (left as any) | (right as any);
    case '^':
      return (left as any) ^ (right as any);
    case '<<':
      return (left as any) << (right as any);
    case '>>':
      return (left as any) >> (right as any);
    case '>>>':
      return (left as any) >>> (right as any);
    case '>':
      return (left as any) > (right as any);
    case '<':
      return (left as any) < (right as any);
    case '>=':
      return (left as any) >= (right as any);
    case '<=':
      return (left as any) <= (right as any);
    case '==':
      return left == right;
    case '!=':
      return left != right;
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case 'instanceof':
      return (left as any) instanceof (right as any);
    case 'in':
      return (left as any) in (right as any);
  }
};

const evaluateLogical = (node: LogicalNode, env: Env): unknown => {
  const left = evaluate(node.left, env);
  if (node.operator === '&&') {
    return left ? evaluate(node.right, env) : left;
  }
  if (node.operator === '||') {
    return left ? left : evaluate(node.right, env);
  }
  return left === null || left === undefined ? evaluate(node.right, env) : left;
};

const copySpread = (target: object, source: unknown): void => {
  if (source === null || source === undefined) {
    return;
  }
  const boxed = Object(source);
  for (const key of Reflect.ownKeys(boxed)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(boxed, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: Reflect.get(boxed, key),
      writable: true,
    });
  }
};

const evaluateTaggedTemplate = (
  node: TaggedTemplateNode,
  env: Env,
): unknown => {
  let tag: unknown;
  let thisArg: unknown;
  if (node.tag.type === 'MemberExpression') {
    const reference = memberReference(node.tag, env, false);
    if (reference === CHAIN_SHORT_CIRCUIT) {
      return undefined;
    }
    tag = reference.value;
    thisArg = reference.object;
  } else {
    tag = evaluate(node.tag, env);
  }
  if (typeof tag !== 'function') {
    return nonCallableError();
  }

  const raw = Object.freeze([...node.quasi.rawQuasis]);
  const strings = [...node.quasi.quasis] as string[] & {
    raw: readonly string[];
  };
  Object.defineProperty(strings, 'raw', {
    value: raw,
  });
  Object.freeze(strings);

  return Reflect.apply(tag, thisArg, [
    strings,
    ...node.quasi.expressions.map(expression => evaluate(expression, env)),
  ]);
};

export const evaluate = (node: ASTNode, env: Env): unknown => {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      return evaluateIdentifier(node, env);
    case 'Elision':
      return undefined;
    case 'ParenthesizedExpression':
      return evaluate(node.expression, env);
    case 'ChainExpression': {
      const result = evaluateChainOperand(node.expression, env);
      return result === CHAIN_SHORT_CIRCUIT ? undefined : result;
    }
    case 'UnaryExpression':
      return evaluateUnary(node, env);
    case 'BinaryExpression':
      return evaluateBinary(node, env);
    case 'LogicalExpression':
      return evaluateLogical(node, env);
    case 'ConditionalExpression':
      return evaluate(node.test, env)
        ? evaluate(node.consequent, env)
        : evaluate(node.alternate, env);
    case 'MemberExpression': {
      const reference = memberReference(node, env, false);
      return reference === CHAIN_SHORT_CIRCUIT ? undefined : reference.value;
    }
    case 'CallExpression': {
      const result = evaluateCall(node, env, false);
      return result === CHAIN_SHORT_CIRCUIT ? undefined : result;
    }
    case 'ArrayExpression': {
      const array: unknown[] = [];
      for (const element of node.elements) {
        if (element.type === 'Elision') {
          array.length += 1;
        } else {
          array.push(evaluate(element, env));
        }
      }
      return array;
    }
    case 'ObjectExpression': {
      const object: Record<PropertyKey, unknown> = {};
      for (const property of node.properties) {
        if ((property as SpreadElement).type === 'SpreadElement') {
          copySpread(
            object,
            evaluate((property as SpreadElement).argument, env),
          );
        } else {
          const item = property as ObjectProperty;
          object[item.key] = evaluate(item.value, env);
        }
      }
      return object;
    }
    case 'TemplateLiteral': {
      let output = node.quasis[0] ?? '';
      for (let index = 0; index < node.expressions.length; index++) {
        output +=
          String(evaluate(node.expressions[index], env)) +
          (node.quasis[index + 1] ?? '');
      }
      return output;
    }
    case 'TaggedTemplateExpression':
      return evaluateTaggedTemplate(node, env);
  }
};
