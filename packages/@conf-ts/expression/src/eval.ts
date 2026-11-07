import type {
  ArrowFunctionNode,
  ArrowParam,
  ASTNode,
  BinaryNode,
  CallNode,
  Env,
  IdentifierNode,
  LiteralNode,
  LogicalNode,
  MemberNode,
  TaggedTemplateNode,
  UnaryNode,
} from '@conf-ts/expr-core';

import type { Compiled } from './types';

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

// --- Runtime helpers, shared with the code that compile.ts generates ---

export const toKey = (key: unknown): PropertyKey =>
  typeof key === 'symbol' ? key : String(key);

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

export const nullishMemberError = (): never => {
  throw new TypeError('Cannot read properties of null or undefined');
};

export const nonCallableError = (): never => {
  throw new TypeError('Expression value is not callable');
};

export const destructureError = (): never => {
  throw new TypeError('Cannot destructure null or undefined');
};

// Globals available to compiled expr text even when absent from env. These
// back the @conf-ts/macro type-casting macros (String/Number/Boolean) that
// the compiler keeps as runtime calls (e.g. `Number(a + 1)`) when they
// can't be folded to a compile-time constant. An env value of the same name
// always takes precedence.
//
// This must stay in sync with its counterparts, since nothing enforces
// agreement between them (@conf-ts/expression has no dependency on the macro
// transformer packages):
//   - macro-transformer/src/macro.ts: EXPR_RUNTIME_FALLBACK_MACROS
//   - macro-transformer-native/src/transform.rs: runtime fallback macro matching
// expr-check.ts's BUILTIN_RESULTS (the names @conf-ts/expression/zod accepts
// even when a context schema lacks them) is typed by this object's keys, and
// compile.ts uses this object itself.
// If a name is added to the transformers but not here, the compiler emits
// runtime call text for it that this evaluator can't resolve, and it throws
// "Expression value is not callable" at request time instead of compile time.
export const GLOBAL_BUILTINS = {
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
export const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

export const copySpread = (target: object, source: unknown): void => {
  if (isNullish(source)) {
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

/** The frozen strings array (with `raw`) a template tag is called with. */
export const templateStrings = (
  quasis: string[],
  rawQuasis: string[],
): TemplateStringsArray => {
  const raw = Object.freeze([...rawQuasis]);
  const strings = [...quasis] as string[] & { raw: readonly string[] };
  Object.defineProperty(strings, 'raw', { value: raw });
  return Object.freeze(strings) as unknown as TemplateStringsArray;
};

// --- Interpreter ---

const propertyKey = (
  node: MemberNode,
  env: Env,
  options?: EvalOptions,
): PropertyKey =>
  node.computed
    ? toKey(evaluate(node.property, env, options))
    : String((node.property as LiteralNode).value);

// The object a member access reads from, or CHAIN_SHORT_CIRCUIT when the
// access is skipped; a non-optional access on null/undefined throws.
const memberObject = (
  node: MemberNode,
  env: Env,
  chain: boolean,
  options?: EvalOptions,
): ChainResult => {
  const object = chain
    ? evaluateChainOperand(node.object, env, options)
    : evaluate(node.object, env, options);
  if (object === CHAIN_SHORT_CIRCUIT || !isNullish(object)) {
    return object;
  }
  return node.optional || options?.optionalMemberAccess
    ? CHAIN_SHORT_CIRCUIT
    : nullishMemberError();
};

// Reads a member without building a Reference; keys are evaluated only once
// the object is known to be readable.
const memberValue = (
  node: MemberNode,
  env: Env,
  chain: boolean,
  options?: EvalOptions,
): ChainResult => {
  const object = memberObject(node, env, chain, options);
  return object === CHAIN_SHORT_CIRCUIT
    ? object
    : (object as Record<PropertyKey, unknown>)[propertyKey(node, env, options)];
};

// The object and key as well, for calls (`this`), tags, and `delete`.
const memberReference = (
  node: MemberNode,
  env: Env,
  chain: boolean,
  options?: EvalOptions,
): Reference | typeof CHAIN_SHORT_CIRCUIT => {
  const object = memberObject(node, env, chain, options);
  if (object === CHAIN_SHORT_CIRCUIT) {
    return object;
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
    return memberValue(node, env, true, options);
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

  if (node.optional && isNullish(value)) {
    return CHAIN_SHORT_CIRCUIT;
  }
  if (typeof value !== 'function') {
    return nonCallableError();
  }

  const args: unknown[] = [];
  for (const arg of node.args) {
    args.push(evaluate(arg, env, options));
  }
  return Reflect.apply(value, thisArg, args);
};

const evaluateIdentifier = (node: IdentifierNode, env: Env): unknown =>
  hasOwn(env, node.name)
    ? env[node.name]
    : hasOwn(GLOBAL_BUILTINS, node.name)
      ? (GLOBAL_BUILTINS as Env)[node.name]
      : undefined;

const deleteReference = (
  reference: Reference | typeof CHAIN_SHORT_CIRCUIT,
): boolean =>
  reference === CHAIN_SHORT_CIRCUIT ||
  delete (reference.object as Record<PropertyKey, unknown>)[reference.key];

const deleteExpression = (
  node: ASTNode,
  env: Env,
  options?: EvalOptions,
): boolean => {
  switch (node.type) {
    case 'ParenthesizedExpression':
      return deleteExpression(node.expression, env, options);
    case 'ChainExpression':
      if (node.expression.type !== 'MemberExpression') {
        evaluate(node.expression, env, options);
        return true;
      }
      return deleteReference(
        memberReference(node.expression, env, true, options),
      );
    case 'Identifier':
      return delete env[node.name];
    case 'MemberExpression':
      return deleteReference(memberReference(node, env, false, options));
    default:
      evaluate(node, env, options);
      return true;
  }
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

const BINARY_OPS: Record<
  BinaryNode['operator'],
  (left: any, right: any) => unknown
> = {
  '+': (left, right) => left + right,
  '-': (left, right) => left - right,
  '*': (left, right) => left * right,
  '**': (left, right) => left ** right,
  '/': (left, right) => left / right,
  '%': (left, right) => left % right,
  '&': (left, right) => left & right,
  '|': (left, right) => left | right,
  '^': (left, right) => left ^ right,
  '<<': (left, right) => left << right,
  '>>': (left, right) => left >> right,
  '>>>': (left, right) => left >>> right,
  '>': (left, right) => left > right,
  '<': (left, right) => left < right,
  '>=': (left, right) => left >= right,
  '<=': (left, right) => left <= right,
  '==': (left, right) => left == right,
  '!=': (left, right) => left != right,
  '===': (left, right) => left === right,
  '!==': (left, right) => left !== right,
  instanceof: (left, right) => left instanceof right,
  in: (left, right) => left in right,
};

const evaluateBinary = (
  node: BinaryNode,
  env: Env,
  options?: EvalOptions,
): unknown => {
  const left = evaluate(node.left, env, options);
  const right = evaluate(node.right, env, options);
  return BINARY_OPS[node.operator](left, right);
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
  return isNullish(left) ? evaluate(node.right, env, options) : left;
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
const requireDestructurable = (source: unknown): unknown =>
  isNullish(source) ? destructureError() : source;

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
      const { elements } = param;
      for (let index = 0; index < elements.length; index++) {
        const element = elements[index];
        // `null` is a hole, e.g. the middle slot in `[a, , b]`
        if (element !== null) {
          bindArrowParam(element, source[index], env, options);
        }
      }
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
    const { params } = node;
    for (let index = 0; index < params.length; index++) {
      const param = params[index];
      if (param.kind === 'rest') {
        localEnv[param.name] = args.slice(index);
      } else {
        bindArrowParam(param, args[index], localEnv, options);
      }
    }
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

  const args: unknown[] = [
    templateStrings(node.quasi.quasis, node.quasi.rawQuasis),
  ];
  for (const expression of node.quasi.expressions) {
    args.push(evaluate(expression, env, options));
  }
  return Reflect.apply(tag, thisArg, args);
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
      const result = memberValue(node, env, false, options);
      return result === CHAIN_SHORT_CIRCUIT ? undefined : result;
    }
    case 'CallExpression': {
      const result = evaluateCall(node, env, false, options);
      return result === CHAIN_SHORT_CIRCUIT ? undefined : result;
    }
    case 'ArrayExpression': {
      const array: unknown[] = [];
      for (const element of node.elements) {
        if (element.type === 'SpreadElement') {
          spreadIntoArray(array, evaluate(element.argument, env, options));
        } else if (element.type === 'Elision') {
          array.length += 1;
        } else {
          array.push(evaluate(element, env, options));
        }
      }
      return array;
    }
    case 'ObjectExpression': {
      const object: Record<PropertyKey, unknown> = {};
      for (const property of node.properties) {
        if ('type' in property) {
          copySpread(object, evaluate(property.argument, env, options));
        } else {
          const key = property.computed
            ? toKey(evaluate(property.key, env, options))
            : property.key;
          object[key] = evaluate(property.value, env, options);
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

const LOOSE: EvalOptions = { optionalMemberAccess: true };

/** An interpreter-backed function evaluating `ast` against its argument. */
export const interpret = <Context, ReturnType>(
  ast: ASTNode,
  optionalMemberAccess: boolean,
): Compiled<Context, ReturnType> => {
  const options = optionalMemberAccess ? LOOSE : undefined;
  return (env: Context) => evaluate(ast, env as Env, options) as ReturnType;
};
