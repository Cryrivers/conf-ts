import * as z from 'zod';

import {
  checkExpression,
  kindOf,
  type CheckOptions,
  type ContextModel,
  type ExprProblemReason,
  type PropertyLookup,
  type ReturnModel,
  type ValueKind,
} from './expr-check';
import type { Expr, LooseExpr } from './types';

type Schema = z.core.$ZodType;

export type ExprSchemaOptions<Context = unknown, ReturnType = unknown> = {
  /**
   * Schema of the context the expression is evaluated against. Its output
   * type becomes the inferred `Context`, and the root identifiers and
   * property paths the expression reads are checked against it.
   */
  context?: z.core.$ZodType<Context>;
  /**
   * Schema of the value the expression evaluates to. Its output type becomes
   * the inferred `ReturnType`, and results whose type can be determined
   * statically are checked against it.
   */
  returns?: z.core.$ZodType<ReturnType>;
};

export type ExprSchema<Context = unknown, ReturnType = unknown> = z.ZodCustom<
  Expr<Context, ReturnType>,
  Expr<Context, ReturnType>
>;

export type LooseExprSchema<
  Context = unknown,
  ReturnType = unknown,
> = z.ZodCustom<LooseExpr<Context, ReturnType>, LooseExpr<Context, ReturnType>>;

/** `params` of the `custom` issues reported for an invalid expression. */
export type ExprIssueParams = { reason: ExprProblemReason };

/**
 * The structural forms a context value can take once wrappers such as
 * optional, default, or pipe have been unwrapped. `value` covers primitives
 * and built-in objects; its prototype decides which members exist, and
 * null/undefined have none.
 */
type Variant =
  | {
      readonly form: 'object';
      readonly shape: Readonly<Record<string, Schema>>;
      readonly catchall: Schema | undefined;
    }
  | { readonly form: 'record'; readonly value: Schema }
  | { readonly form: 'array'; readonly element: Schema }
  | {
      readonly form: 'tuple';
      readonly items: readonly Schema[];
      readonly rest: Schema | null;
    }
  | {
      readonly form: 'value';
      readonly kind: ValueKind;
      readonly proto: object | undefined;
    };

/**
 * Every form a value may take. Functions producing it return `undefined`
 * instead when a schema's values can't be described statically.
 */
type Variants = readonly Variant[];

const value = (kind: ValueKind, proto?: object): Variant => ({
  form: 'value',
  kind,
  proto,
});

const STRING = value('string', String.prototype);
const NUMBER = value('number', Number.prototype);
const BIGINT = value('bigint', BigInt.prototype);
const BOOLEAN = value('boolean', Boolean.prototype);
const SYMBOL = value('symbol', Symbol.prototype);
const FUNCTION = value('function', Function.prototype);
const NULL = value('null');
const UNDEFINED = value('undefined');

const PRIMITIVES: Partial<Record<ValueKind, Variant>> = {
  string: STRING,
  number: NUMBER,
  bigint: BIGINT,
  boolean: BOOLEAN,
  symbol: SYMBOL,
  null: NULL,
  undefined: UNDEFINED,
};

// Guards against schemas that only ever unwrap into themselves, e.g. a lazy
// schema returning itself.
const MAX_UNWRAP_DEPTH = 64;

const hasOwn = (object: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(object, key);

const builtin = (constructor: { prototype: object } | undefined) =>
  constructor ? [value('object', constructor.prototype)] : undefined;

const fromValues = (values: ReadonlySet<unknown> | undefined) => {
  if (!values) {
    return undefined;
  }
  const variants = new Set<Variant>();
  for (const literal of values) {
    const variant = PRIMITIVES[kindOf(literal)];
    if (!variant) {
      return undefined;
    }
    variants.add(variant);
  }
  return [...variants];
};

const combine = (list: readonly (Variants | undefined)[]) =>
  list.every(variants => variants !== undefined)
    ? [...new Set(list.flat())]
    : undefined;

const without = (variants: Variants | undefined, excluded: Variant) =>
  variants?.filter(variant => variant !== excluded);

/** Describes the output values of `schema`, the way `z.infer` does. */
function variantsOf(schema: Schema, depth = 0): Variants | undefined {
  if (depth > MAX_UNWRAP_DEPTH) {
    return undefined;
  }
  const inner = (next: Schema) => variantsOf(next, depth + 1);
  // Values without Zod 4 internals, such as `z.function()` before Zod 4.1
  // made it a schema, fall through to the opaque default.
  const def = (schema as z.core.$ZodTypes)._zod?.def;
  switch (def?.type) {
    case 'object': {
      return [{ form: 'object', shape: def.shape, catchall: def.catchall }];
    }
    case 'record': {
      return [{ form: 'record', value: def.valueType }];
    }
    case 'array': {
      return [{ form: 'array', element: def.element }];
    }
    case 'tuple': {
      return [{ form: 'tuple', items: def.items, rest: def.rest }];
    }
    case 'string':
    case 'template_literal': {
      return [STRING];
    }
    case 'number':
    case 'nan': {
      return [NUMBER];
    }
    case 'bigint': {
      return [BIGINT];
    }
    case 'boolean':
    case 'success': {
      return [BOOLEAN];
    }
    case 'symbol': {
      return [SYMBOL];
    }
    case 'null': {
      return [NULL];
    }
    case 'undefined':
    case 'void': {
      return [UNDEFINED];
    }
    case 'never': {
      return [];
    }
    case 'literal':
    case 'enum': {
      return fromValues(schema._zod.values);
    }
    case 'function': {
      return [FUNCTION];
    }
    case 'date': {
      return builtin(Date);
    }
    case 'map': {
      return builtin(Map);
    }
    case 'set': {
      return builtin(Set);
    }
    case 'promise': {
      return builtin(Promise);
    }
    case 'file': {
      return builtin((globalThis as { File?: { prototype: object } }).File);
    }
    case 'optional': {
      const variants = inner(def.innerType);
      return variants && [...variants, UNDEFINED];
    }
    case 'nullable': {
      const variants = inner(def.innerType);
      return variants && [...variants, NULL];
    }
    // These replace an undefined input, so their output never includes it.
    case 'default':
    case 'prefault':
    case 'nonoptional': {
      return without(inner(def.innerType), UNDEFINED);
    }
    case 'catch':
    case 'readonly': {
      return inner(def.innerType);
    }
    case 'lazy': {
      return inner(def.getter());
    }
    case 'pipe': {
      return inner(def.out);
    }
    case 'union': {
      return combine(def.options.map(inner));
    }
    case 'intersection': {
      return combine([inner(def.left), inner(def.right)]);
    }
    default: {
      // any, unknown, custom, transform, and schema types added later.
      return undefined;
    }
  }
}

const kindOfVariant = (variant: Variant): ValueKind =>
  variant.form === 'value' ? variant.kind : 'object';

// Every property name reachable through `proto`, for "did you mean" hints.
const prototypeKeys = (proto: object | null): string[] =>
  proto
    ? [
        ...Object.getOwnPropertyNames(proto),
        ...prototypeKeys(Object.getPrototypeOf(proto)),
      ]
    : [];

// A canonical numeric property name, i.e. what `String(number)` produces.
const isNumericKey = (key: string) => key === String(Number(key));

const isArrayIndex = (key: string) =>
  isNumericKey(key) && Number.isInteger(Number(key)) && Number(key) >= 0;

/**
 * Resolves `key` on a value that may be any of `variants`. The key exists if
 * any variant has it, because the expression may have narrowed the value with
 * a guard this analysis doesn't follow; for the same reason null/undefined
 * never decide the outcome. Root lookups (`root: true`) only see the context's
 * own properties, like the evaluator.
 */
function lookup(
  variants: Variants,
  key: string | undefined,
  root: boolean,
): PropertyLookup<Variants> {
  const found: Variant[] = [];
  const known: string[] = [];
  const prototypes: object[] = [];
  let decided = false;
  let matched = false;
  for (const variant of variants) {
    let next: Schema | null | undefined;
    switch (variant.form) {
      case 'object': {
        decided = true;
        if (key === undefined) {
          return undefined;
        }
        if (hasOwn(variant.shape, key)) {
          next = variant.shape[key];
        } else if (
          variant.catchall &&
          variant.catchall._zod.def.type !== 'never'
        ) {
          next = variant.catchall;
        } else if (!root && key in Object.prototype) {
          return undefined;
        } else {
          known.push(...Object.keys(variant.shape));
        }
        break;
      }
      case 'record': {
        decided = true;
        next = variant.value;
        break;
      }
      case 'array': {
        if (root) {
          return undefined;
        }
        decided = true;
        if (key === undefined || isNumericKey(key)) {
          next = variant.element;
        } else if (key in Array.prototype) {
          return undefined;
        } else {
          prototypes.push(Array.prototype);
        }
        break;
      }
      case 'tuple': {
        if (root || key === undefined) {
          return undefined;
        }
        decided = true;
        if (isArrayIndex(key)) {
          next = variant.items[Number(key)] ?? variant.rest;
        } else if (isNumericKey(key) || key in Array.prototype) {
          return undefined;
        } else {
          prototypes.push(Array.prototype);
        }
        break;
      }
      case 'value': {
        if (!variant.proto) {
          break;
        }
        if (
          root ||
          key === undefined ||
          key in variant.proto ||
          (variant.kind === 'string' && isNumericKey(key))
        ) {
          return undefined;
        }
        decided = true;
        prototypes.push(variant.proto);
        break;
      }
    }
    if (next) {
      const resolved = variantsOf(next);
      if (!resolved) {
        return undefined;
      }
      matched = true;
      found.push(...resolved);
    }
  }
  if (matched) {
    return { found: [...new Set(found)] };
  }
  return decided
    ? { missing: [...known, ...prototypes.flatMap(prototypeKeys)] }
    : undefined;
}

function contextModel(schema: Schema): ContextModel<Variants> {
  let rootVariants: Variants | null | undefined;
  return {
    root(name) {
      if (rootVariants === undefined) {
        rootVariants = variantsOf(schema) ?? null;
      }
      return rootVariants ? lookup(rootVariants, name, true) : undefined;
    },
    member: (variants, key) => lookup(variants, key, false),
    kinds: variants => new Set(variants.map(kindOfVariant)),
  };
}

function returnModel(schema: Schema): ReturnModel {
  const variants = variantsOf(schema);
  return {
    kinds: variants && new Set(variants.map(kindOfVariant)),
    reject(result) {
      let parsed: z.ZodSafeParseResult<unknown>;
      try {
        parsed = z.safeParse(schema, result);
      } catch {
        // e.g. an async refinement; nothing can be concluded synchronously.
        return undefined;
      }
      return parsed.success
        ? undefined
        : (parsed.error.issues[0]?.message ?? 'invalid value');
    },
  };
}

function assertSchema(
  factory: string,
  name: string,
  option: unknown,
): asserts option is Schema | undefined {
  if (
    option !== undefined &&
    (typeof option !== 'object' || option === null || !('_zod' in option))
  ) {
    throw new TypeError(`${factory}(): \`${name}\` must be a Zod 4 schema`);
  }
}

function createExprSchema<Output>(
  factory: string,
  options: ExprSchemaOptions | undefined,
  loose: boolean,
): z.ZodCustom<Output, Output> {
  const context = options?.context;
  const returns = options?.returns;
  assertSchema(factory, 'context', context);
  assertSchema(factory, 'returns', returns);
  // Built on first use: lazy and getter-based schemas may reference
  // declarations that aren't initialized yet when the schema is created.
  let models: CheckOptions<Variants> | undefined;
  return z.custom<Output>().check(payload => {
    const input: unknown = payload.value;
    if (typeof input !== 'string') {
      payload.issues.push({ code: 'invalid_type', expected: 'string', input });
      return;
    }
    models ??= {
      context: context && contextModel(context),
      returns: returns && returnModel(returns),
      loose,
    };
    for (const problem of checkExpression(input, models)) {
      const params: ExprIssueParams = { reason: problem.reason };
      payload.issues.push({
        code: 'custom',
        input,
        message: problem.message,
        params,
      });
    }
  });
}

/**
 * Zod schema for a serialized `Expr`, as emitted by the `expr()` macro. Parsed
 * values are checked to be valid expressions and, given `context`/`returns`
 * schemas, to only read existing context properties and to evaluate to an
 * acceptable type. `z.infer` yields `Expr<Context, ReturnType>`.
 */
export function exprSchema<Context = unknown, ReturnType = unknown>(
  options?: ExprSchemaOptions<Context, ReturnType>,
): ExprSchema<Context, ReturnType> {
  return createExprSchema('exprSchema', options, false);
}

/**
 * Zod schema for a serialized `LooseExpr`: validated like `exprSchema()`, for
 * expressions evaluated with `loose: true`, so `z.infer` yields
 * `LooseExpr<Context, ReturnType>`.
 */
export function looseExprSchema<Context = unknown, ReturnType = unknown>(
  options?: ExprSchemaOptions<Context, ReturnType>,
): LooseExprSchema<Context, ReturnType> {
  return createExprSchema('looseExprSchema', options, true);
}
