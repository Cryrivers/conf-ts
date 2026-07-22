import type {
  ArrowFunctionNode,
  ArrowParam,
  ASTNode,
  BinaryNode,
  CallNode,
  ComputedObjectProperty,
  Env,
  IdentifierNode,
  LiteralNode,
  LogicalNode,
  MemberNode,
  ObjectProperty,
  SpreadElement,
  TaggedTemplateNode,
  UnaryNode,
} from '@conf-ts/expr-core';

export type EvalOptions = {
  optionalMemberAccess?: boolean;
};

const CHAIN_SHORT_CIRCUIT = Symbol('chain-short-circuit');

type ChainResult = unknown | typeof CHAIN_SHORT_CIRCUIT;
type Reference = {
  value: unknown;
  object: unknown;
  key: PropertyKey;
};

const toKey = (key: unknown): PropertyKey =>
  typeof key === 'symbol' ? key : String(key);

const propertyKey = (
  node: MemberNode,
  env: Env,
  options?: EvalOptions,
): PropertyKey =>
  node.computed
    ? toKey(evaluate(node.property, env, options))
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
  options?: EvalOptions,
): Reference | typeof CHAIN_SHORT_CIRCUIT => {
  const object = chain
    ? evaluateChainOperand(node.object, env, options)
    : evaluate(node.object, env, options);
  if (object === CHAIN_SHORT_CIRCUIT) {
    return CHAIN_SHORT_CIRCUIT;
  }
  if (object === null || object === undefined) {
    if (node.optional || options?.optionalMemberAccess) {
      return CHAIN_SHORT_CIRCUIT;
    }
    return nullishMemberError();
  }
  const key = propertyKey(node, env, options);
  return {
    value: (object as Record<PropertyKey, unknown>)[key],
    object,
    key,
  };
};

const evaluateChainOperand = (
  node: ASTNode,
  env: Env,
  options?: EvalOptions,
): ChainResult => {
  if (node.type === 'MemberExpression') {
    const reference = memberReference(node, env, true, options);
    return reference === CHAIN_SHORT_CIRCUIT ? reference : reference.value;
  }
  if (node.type === 'CallExpression') {
    return evaluateCall(node, env, true, options);
  }
  return evaluate(node, env, options);
};

const evaluateCall = (
  node: CallNode,
  env: Env,
  chain: boolean,
  options?: EvalOptions,
): ChainResult => {
  let value: unknown;
  let thisArg: unknown = undefined;

  if (node.callee.type === 'MemberExpression') {
    const reference = memberReference(node.callee, env, chain, options);
    if (reference === CHAIN_SHORT_CIRCUIT) {
      return reference;
    }
    value = reference.value;
    thisArg = reference.object;
  } else {
    const callee = chain
      ? evaluateChainOperand(node.callee, env, options)
      : evaluate(node.callee, env, options);
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

  const args = node.args.map(arg => evaluate(arg, env, options));
  return Reflect.apply(value, thisArg, args);
};

// Globals available to compiled expr text even when absent from env. These
// back the @conf-ts/macro type-casting macros (String/Number/Boolean) that
// the compiler keeps as runtime calls (e.g. `Number(a + 1)`) when they
// can't be folded to a compile-time constant. An env value of the same name
// always takes precedence.
//
// This must stay in sync with its two counterparts, since nothing enforces
// agreement across the package boundary between them (@conf-ts/expression
// has no dependency on the macro transformer packages):
//   - macro-transformer/src/macro.ts: EXPR_RUNTIME_FALLBACK_MACROS
//   - macro-transformer-native/src/transform.rs: runtime fallback macro matching
// If a name is added to those two but not here, the compiler emits runtime
// call text for it that this evaluator can't resolve, and it throws
// "Expression value is not callable" at request time instead of compile time.
const GLOBAL_BUILTINS: Env = {
  String,
  Number,
  Boolean,
};

// Both env and GLOBAL_BUILTINS are looked up by own-property only, never via
// the prototype chain. Every plain JS object inherits Object.prototype, so an
// unguarded lookup (`env[name]`) lets a compiled or hand-written expr string
// resolve names like `constructor`/`toString` to real Object.prototype
// members — `constructor.constructor(...)` reaches the Function constructor,
// letting arbitrary expr text execute arbitrary JS. Own-property-only lookup
// closes that off for both env and the new builtins object.
//
// Uses Object.prototype.hasOwnProperty.call rather than the newer
// Object.hasOwn for wider runtime compatibility.
const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const evaluateIdentifier = (node: IdentifierNode, env: Env): unknown =>
  hasOwn(env, node.name)
    ? env[node.name]
    : hasOwn(GLOBAL_BUILTINS, node.name)
      ? GLOBAL_BUILTINS[node.name]
      : undefined;

const deleteExpression = (
  node: ASTNode,
  env: Env,
  options?: EvalOptions,
): boolean => {
  if (node.type === 'ParenthesizedExpression') {
    return deleteExpression(node.expression, env, options);
  }
  if (node.type === 'ChainExpression') {
    const expression = node.expression;
    if (expression.type !== 'MemberExpression') {
      evaluate(expression, env, options);
      return true;
    }
    const reference = memberReference(expression, env, true, options);
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
    const reference = memberReference(node, env, false, options);
    if (reference === CHAIN_SHORT_CIRCUIT) {
      return true;
    }
    return delete (reference.object as Record<PropertyKey, unknown>)[
      reference.key
    ];
  }
  evaluate(node, env, options);
  return true;
};

const evaluateUnary = (
  node: UnaryNode,
  env: Env,
  options?: EvalOptions,
): unknown => {
  if (node.operator === 'delete') {
    return deleteExpression(node.argument, env, options);
  }

  const value = evaluate(node.argument, env, options);
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

const evaluateBinary = (
  node: BinaryNode,
  env: Env,
  options?: EvalOptions,
): unknown => {
  const left = evaluate(node.left, env, options);
  const right = evaluate(node.right, env, options);
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

const evaluateLogical = (
  node: LogicalNode,
  env: Env,
  options?: EvalOptions,
): unknown => {
  const left = evaluate(node.left, env, options);
  if (node.operator === '&&') {
    return left ? evaluate(node.right, env, options) : left;
  }
  if (node.operator === '||') {
    return left ? left : evaluate(node.right, env, options);
  }
  return left === null || left === undefined
    ? evaluate(node.right, env, options)
    : left;
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

// Spreads any iterable (arrays, strings, Sets, Maps, generators, ...) into
// target, via the iterator protocol — same as native `[...source]`. A
// non-iterable/nullish source throws a TypeError through the `for...of`
// itself, matching what real array spread does.
const spreadIntoArray = (target: unknown[], source: unknown): void => {
  for (const item of source as Iterable<unknown>) {
    target.push(item);
  }
};

const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

// A default only kicks in when the argument is strictly `undefined` —
// shared by all three param kinds below (a plain identifier's own default,
// or the whole-pattern default on `({a} = {...}) => ...` / `([a] = [...]) => ...`).
const resolveWithDefault = (
  arg: unknown,
  defaultNode: ASTNode | undefined,
  env: Env,
  options?: EvalOptions,
): unknown =>
  arg === undefined && defaultNode !== undefined
    ? evaluate(defaultNode, env, options)
    : arg;

// Destructuring `null`/`undefined` (once any default has already been
// applied) throws, just like `const {a} = null` would.
const requireDestructurable = (source: unknown): unknown => {
  if (isNullish(source)) {
    throw new TypeError('Cannot destructure null or undefined');
  }
  return source;
};

// Binds one parameter (which may itself be a one-level destructuring
// pattern) against an incoming argument, writing directly into `env`.
const bindArrowParam = (
  param: ArrowParam,
  arg: unknown,
  env: Env,
  options?: EvalOptions,
): void => {
  switch (param.kind) {
    case 'identifier': {
      env[param.name] = resolveWithDefault(arg, param.default, env, options);
      return;
    }
    case 'object': {
      const source = requireDestructurable(
        resolveWithDefault(arg, param.default, env, options),
      ) as Record<PropertyKey, unknown>;
      for (const property of param.properties) {
        bindArrowParam(property.value, source[property.key], env, options);
      }
      return;
    }
    case 'array': {
      const source = requireDestructurable(
        resolveWithDefault(arg, param.default, env, options),
      ) as ArrayLike<unknown>;
      param.elements.forEach((element, index) => {
        if (element === null) return; // hole, e.g. the middle slot in `[a, , b]`
        bindArrowParam(element, source[index], env, options);
      });
      return;
    }
  }
};

// Params shadow the outer scope: the merge always starts from a fresh plain
// object with the outer env's own properties, then overwrites param names —
// never mutates `env` itself, since it may be the caller's shared context.
const evaluateArrowFunction =
  (node: ArrowFunctionNode, env: Env, options?: EvalOptions) =>
  (...args: unknown[]): unknown => {
    const localEnv: Env = { ...env };
    node.params.forEach((param, index) => {
      if (param.kind === 'rest') {
        localEnv[param.name] = args.slice(index);
        return;
      }
      bindArrowParam(param, args[index], localEnv, options);
    });
    return evaluate(node.body, localEnv, options);
  };

const evaluateTaggedTemplate = (
  node: TaggedTemplateNode,
  env: Env,
  options?: EvalOptions,
): unknown => {
  let tag: unknown;
  let thisArg: unknown;
  if (node.tag.type === 'MemberExpression') {
    const reference = memberReference(node.tag, env, false, options);
    if (reference === CHAIN_SHORT_CIRCUIT) {
      return undefined;
    }
    tag = reference.value;
    thisArg = reference.object;
  } else {
    tag = evaluate(node.tag, env, options);
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
    ...node.quasi.expressions.map(expression =>
      evaluate(expression, env, options),
    ),
  ]);
};

export const evaluate = (
  node: ASTNode,
  env: Env,
  options?: EvalOptions,
): unknown => {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      return evaluateIdentifier(node, env);
    case 'Elision':
      return undefined;
    case 'ParenthesizedExpression':
      return evaluate(node.expression, env, options);
    case 'ChainExpression': {
      const result = evaluateChainOperand(node.expression, env, options);
      return result === CHAIN_SHORT_CIRCUIT ? undefined : result;
    }
    case 'UnaryExpression':
      return evaluateUnary(node, env, options);
    case 'BinaryExpression':
      return evaluateBinary(node, env, options);
    case 'LogicalExpression':
      return evaluateLogical(node, env, options);
    case 'ConditionalExpression':
      return evaluate(node.test, env, options)
        ? evaluate(node.consequent, env, options)
        : evaluate(node.alternate, env, options);
    case 'MemberExpression': {
      const reference = memberReference(node, env, false, options);
      return reference === CHAIN_SHORT_CIRCUIT ? undefined : reference.value;
    }
    case 'CallExpression': {
      const result = evaluateCall(node, env, false, options);
      return result === CHAIN_SHORT_CIRCUIT ? undefined : result;
    }
    case 'ArrayExpression': {
      const array: unknown[] = [];
      for (const element of node.elements) {
        if ((element as SpreadElement).type === 'SpreadElement') {
          spreadIntoArray(
            array,
            evaluate((element as SpreadElement).argument, env, options),
          );
        } else if ((element as ASTNode).type === 'Elision') {
          array.length += 1;
        } else {
          array.push(evaluate(element as ASTNode, env, options));
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
            evaluate((property as SpreadElement).argument, env, options),
          );
        } else {
          const item = property as ObjectProperty | ComputedObjectProperty;
          const key = item.computed
            ? toKey(evaluate(item.key, env, options))
            : item.key;
          object[key] = evaluate(item.value, env, options);
        }
      }
      return object;
    }
    case 'TemplateLiteral': {
      let output = node.quasis[0] ?? '';
      for (let index = 0; index < node.expressions.length; index++) {
        output +=
          String(evaluate(node.expressions[index], env, options)) +
          (node.quasis[index + 1] ?? '');
      }
      return output;
    }
    case 'TaggedTemplateExpression':
      return evaluateTaggedTemplate(node, env, options);
    case 'ArrowFunctionExpression':
      return evaluateArrowFunction(node, env, options);
  }
};
