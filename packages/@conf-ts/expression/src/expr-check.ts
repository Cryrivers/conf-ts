import {
  ExprSyntaxError,
  forEachChild,
  forEachParamBinding,
  parse,
  tokenize,
  type ArrowFunctionNode,
  type ASTNode,
  type IdentifierNode,
  type LogicalNode,
  type MemberNode,
  type NodeRange,
  type UnaryNode,
} from '@conf-ts/expr-core';

import type { GLOBAL_BUILTINS } from './eval';

/** The `typeof`-style categories a statically analyzed value can fall into. */
export type ValueKind =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'symbol'
  | 'undefined'
  | 'null'
  | 'object'
  | 'function';

/** The kinds a value may have, or `undefined` when it could be anything. */
export type ValueKinds = ReadonlySet<ValueKind> | undefined;

/**
 * Result of resolving a property against a context model: the property's
 * type, the names that do exist (for suggestions) when it is missing, or
 * `undefined` when the model can't tell, which always means "allowed".
 */
export type PropertyLookup<Type> =
  | { readonly found: Type }
  | { readonly missing: readonly string[] }
  | undefined;

/** Static description of the context an expression is evaluated against. */
export interface ContextModel<Type> {
  /** Resolves a root identifier, i.e. an own property of the context. */
  root(name: string): PropertyLookup<Type>;
  /** Resolves `key` on a value of `type`; `key` is undefined when computed at runtime. */
  member(type: Type, key: string | undefined): PropertyLookup<Type>;
  kinds(type: Type): ValueKinds;
}

/** Static description of the values an expression may evaluate to. */
export interface ReturnModel {
  readonly kinds: ValueKinds;
  /** Explains why a statically known result is rejected, if it is. */
  reject(value: unknown): string | undefined;
}

export type ExprProblemReason =
  'syntax' | 'unknown_context_property' | 'unknown_property' | 'return_type';

export interface ExprProblem {
  readonly reason: ExprProblemReason;
  readonly message: string;
  /**
   * Where the problem is in the expression string, `end` exclusive: the
   * offending syntax, unknown identifier, or missing property's name, or the
   * whole expression for its return type.
   */
  readonly start: number;
  readonly end: number;
}

export interface CheckOptions<Type> {
  context?: ContextModel<Type>;
  returns?: ReturnModel;
  /** Member access short-circuits on null/undefined, as with `loose: true`. */
  loose?: boolean;
}

// What calling each of the evaluator's GLOBAL_BUILTINS (the globals it
// resolves when the context doesn't define the name) returns. Typed by that
// object's keys, so a new builtin can't be left out here.
const BUILTIN_RESULTS: Readonly<
  Record<keyof typeof GLOBAL_BUILTINS, ValueKind>
> = {
  String: 'string',
  Number: 'number',
  Boolean: 'boolean',
};

const builtinResult = (name: string): ValueKind | undefined =>
  Object.prototype.hasOwnProperty.call(BUILTIN_RESULTS, name)
    ? BUILTIN_RESULTS[name as keyof typeof BUILTIN_RESULTS]
    : undefined;

/**
 * What the checker knows about a subexpression. Everything is an
 * over-approximation: an expression is only rejected when it is certain to
 * be invalid, never because the analysis lost track of a value.
 */
interface Info<Type> {
  readonly kinds: ValueKinds;
  /** Every possible result, when they are all statically known. */
  readonly values?: readonly unknown[];
  /** Context type the value was read from, so member access can be checked. */
  readonly type?: Type;
  /** Printable context path for messages, e.g. `user.profile`. */
  readonly path?: string;
  /** Result kind when this value is one of the evaluator's builtins. */
  readonly builtin?: ValueKind;
}

const kindSet = (...kinds: ValueKind[]): ReadonlySet<ValueKind> =>
  new Set(kinds);

const STRING = kindSet('string');
const NUMBER = kindSet('number');
const BIGINT = kindSet('bigint');
const BOOLEAN = kindSet('boolean');
const UNDEFINED = kindSet('undefined');
const OBJECT = kindSet('object');
const FUNCTION = kindSet('function');
const NUMERIC = kindSet('number', 'bigint');
const ADDITION = kindSet('string', 'number', 'bigint');
// Operands that `+` turns into a number without concatenating.
const ADDITIVE_NUMBER = kindSet('number', 'boolean', 'null', 'undefined');
// Operands whose numeric conversion can't produce a bigint.
const NUMBER_ONLY = kindSet(
  'number',
  'string',
  'boolean',
  'null',
  'undefined',
  'symbol',
);
const FALSY_CAPABLE = kindSet(
  'boolean',
  'number',
  'bigint',
  'string',
  'null',
  'undefined',
);
const TRUTHY_CAPABLE = kindSet(
  'boolean',
  'number',
  'bigint',
  'string',
  'symbol',
  'object',
  'function',
);
const NOT_NULLISH = kindSet(
  'boolean',
  'number',
  'bigint',
  'string',
  'symbol',
  'object',
  'function',
);
const RELATIONAL_OPERATORS = new Set([
  '<',
  '>',
  '<=',
  '>=',
  '==',
  '!=',
  '===',
  '!==',
  'in',
  'instanceof',
]);

const ANY: Info<never> = { kinds: undefined };
const OBJECT_INFO: Info<never> = { kinds: OBJECT };
const FUNCTION_INFO: Info<never> = { kinds: FUNCTION };

export const kindOf = (value: unknown): ValueKind =>
  value === null ? 'null' : (typeof value as ValueKind);

const union = (left: ValueKinds, right: ValueKinds): ValueKinds =>
  left && right ? new Set([...left, ...right]) : undefined;

const restrict = (
  kinds: ValueKinds,
  allowed: ReadonlySet<ValueKind>,
): ValueKinds => kinds && new Set([...kinds].filter(kind => allowed.has(kind)));

const within = (kinds: ValueKinds, allowed: ReadonlySet<ValueKind>) =>
  !!kinds && [...kinds].every(kind => allowed.has(kind));

const exactly = (kinds: ValueKinds, kind: ValueKind) =>
  kinds?.size === 1 && kinds.has(kind);

const valuesInfo = (values: readonly unknown[]): Info<never> => ({
  kinds: new Set(values.map(kindOf)),
  values,
});

// Folds literal operands the way the evaluator would; a throwing operation
// (e.g. `-` on a symbol) just leaves the result unknown.
const fold = (compute: () => readonly unknown[]) => {
  try {
    return compute();
  } catch {
    return undefined;
  }
};

const UNARY_VALUES: Record<
  Exclude<UnaryNode['operator'], 'delete'>,
  (value: any) => unknown
> = {
  '!': value => !value,
  '+': value => +value,
  '-': value => -value,
  '~': value => ~value,
  typeof: value => typeof value,
  void: () => undefined,
};

const unaryKinds = (
  operator: UnaryNode['operator'],
  argument: ValueKinds,
): ValueKinds => {
  switch (operator) {
    case '!':
    case 'delete': {
      return BOOLEAN;
    }
    case 'typeof': {
      return STRING;
    }
    case 'void': {
      return UNDEFINED;
    }
    case '+': {
      return NUMBER;
    }
    case '-':
    case '~': {
      return within(argument, NUMBER_ONLY) ? NUMBER : NUMERIC;
    }
  }
};

const binaryKinds = (
  operator: string,
  left: ValueKinds,
  right: ValueKinds,
): ValueKinds => {
  if (RELATIONAL_OPERATORS.has(operator)) {
    return BOOLEAN;
  }
  if (operator === '>>>') {
    return NUMBER;
  }
  if (operator === '+') {
    if (exactly(left, 'string') || exactly(right, 'string')) {
      return STRING;
    }
    if (within(left, ADDITIVE_NUMBER) && within(right, ADDITIVE_NUMBER)) {
      return NUMBER;
    }
  } else if (within(left, NUMBER_ONLY) && within(right, NUMBER_ONLY)) {
    return NUMBER;
  }
  if (exactly(left, 'bigint') && exactly(right, 'bigint')) {
    return BIGINT;
  }
  return operator === '+' ? ADDITION : NUMERIC;
};

const shortCircuits = (operator: LogicalNode['operator'], value: unknown) =>
  operator === '&&'
    ? !value
    : operator === '||'
      ? !!value
      : value !== null && value !== undefined;

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/;
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

const memberPath = (base: string | undefined, key: string | undefined) => {
  if (base === undefined) {
    return undefined;
  }
  if (key === undefined) {
    return `${base}[…]`;
  }
  if (IDENTIFIER_NAME.test(key)) {
    return `${base}.${key}`;
  }
  return ARRAY_INDEX.test(key)
    ? `${base}[${key}]`
    : `${base}[${JSON.stringify(key)}]`;
};

// Optimal string alignment distance: Levenshtein plus adjacent transpositions,
// so a swapped pair like `nmae` → `name` counts as a single edit.
const editDistance = (a: string, b: string): number => {
  const rows = [Array.from({ length: b.length + 1 }, (_, index) => index)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        rows[i - 1][j] + 1,
        row[j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
      }
    }
    rows.push(row);
  }
  return rows[a.length][b.length];
};

const suggestion = (name: string, candidates: readonly string[]): string => {
  const lowered = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(name.length / 4)) + 1;
  for (const candidate of new Set(candidates)) {
    const other = candidate.toLowerCase();
    // The distance is at least the difference in length.
    if (Math.abs(other.length - lowered.length) >= bestDistance) {
      continue;
    }
    const distance = editDistance(lowered, other);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best === undefined ? '' : ` (did you mean "${best}"?)`;
};

const formatKinds = (kinds: ReadonlySet<ValueKind>) =>
  kinds.size === 0 ? 'never' : [...kinds].join(' | ');

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  return Object.is(value, -0) ? '-0' : String(value);
};

class Checker<Type> {
  readonly problems: ExprProblem[] = [];

  constructor(
    private readonly context: ContextModel<Type> | undefined,
    private readonly loose: boolean,
  ) {}

  visit(node: ASTNode, scope: ReadonlySet<string>): Info<Type> {
    switch (node.type) {
      case 'Literal': {
        return valuesInfo([node.value]);
      }
      case 'Identifier': {
        return this.identifier(node, scope);
      }
      case 'Elision': {
        return { kinds: UNDEFINED, values: [undefined] };
      }
      case 'ParenthesizedExpression': {
        return this.visit(node.expression, scope);
      }
      case 'ChainExpression': {
        // An interrupted optional chain evaluates to undefined.
        const { kinds, type, path } = this.visit(node.expression, scope);
        return { kinds: union(kinds, UNDEFINED), type, path };
      }
      case 'UnaryExpression': {
        const { operator } = node;
        const argument = this.visit(node.argument, scope);
        const values =
          operator !== 'delete' &&
          argument.values &&
          fold(() => argument.values!.map(UNARY_VALUES[operator]));
        return values
          ? valuesInfo(values)
          : { kinds: unaryKinds(operator, argument.kinds) };
      }
      case 'BinaryExpression': {
        const left = this.visit(node.left, scope);
        const right = this.visit(node.right, scope);
        return { kinds: binaryKinds(node.operator, left.kinds, right.kinds) };
      }
      case 'LogicalExpression': {
        return this.logical(
          node.operator,
          this.visit(node.left, scope),
          this.visit(node.right, scope),
        );
      }
      case 'ConditionalExpression': {
        this.visit(node.test, scope);
        const consequent = this.visit(node.consequent, scope);
        const alternate = this.visit(node.alternate, scope);
        return consequent.values && alternate.values
          ? valuesInfo([...consequent.values, ...alternate.values])
          : { kinds: union(consequent.kinds, alternate.kinds) };
      }
      case 'MemberExpression': {
        return this.member(node, scope);
      }
      case 'CallExpression': {
        const callee = this.visit(node.callee, scope);
        for (const argument of node.args) {
          this.visit(argument, scope);
        }
        return callee.builtin ? { kinds: kindSet(callee.builtin) } : ANY;
      }
      case 'ArrayExpression':
      case 'ObjectExpression': {
        this.visitChildren(node, scope);
        return OBJECT_INFO;
      }
      case 'TemplateLiteral': {
        const parts = node.expressions.map(part => this.visit(part, scope));
        const values =
          parts.every(part => part.values?.length === 1) &&
          fold(() => [
            parts.reduce(
              (text, part, index) =>
                text + String(part.values![0]) + (node.quasis[index + 1] ?? ''),
              node.quasis[0] ?? '',
            ),
          ]);
        return values ? valuesInfo(values) : { kinds: STRING };
      }
      case 'TaggedTemplateExpression': {
        this.visitChildren(node, scope);
        return ANY;
      }
      case 'ArrowFunctionExpression': {
        return this.arrow(node, scope);
      }
    }
  }

  // Checks the children of a node whose own result doesn't depend on them.
  private visitChildren(node: ASTNode, scope: ReadonlySet<string>): void {
    forEachChild(node, child => {
      this.visit(child, scope);
    });
  }

  checkReturn(
    info: Info<Type>,
    returns: ReturnModel,
    expression: NodeRange,
  ): void {
    if (info.values) {
      const values = [...new Set(info.values)];
      for (const value of values) {
        const reason = returns.reject(value);
        if (reason !== undefined) {
          this.report(
            'return_type',
            `Expression ${values.length > 1 ? 'can evaluate' : 'evaluates'} to ${formatValue(value)}, which the return schema rejects: ${reason}`,
            expression,
          );
        }
      }
      return;
    }
    const { kinds } = info;
    const expected = returns.kinds;
    // An empty set is a value of type `never`, which fits any return type.
    if (
      kinds &&
      expected &&
      kinds.size > 0 &&
      ![...kinds].some(kind => expected.has(kind))
    ) {
      this.report(
        'return_type',
        `Expression evaluates to ${formatKinds(kinds)}, but the return schema expects ${formatKinds(expected)}`,
        expression,
      );
    }
  }

  private report(
    reason: ExprProblemReason,
    message: string,
    at: NodeRange,
  ): void {
    // Parsed nodes always have a range; the fallback is for the type only.
    this.problems.push({
      reason,
      message,
      start: at.start ?? 0,
      end: at.end ?? 0,
    });
  }

  // Root identifiers are own properties of the context (the evaluator never
  // consults its prototype), falling back to the evaluator's builtins.
  private identifier(
    node: IdentifierNode,
    scope: ReadonlySet<string>,
  ): Info<Type> {
    const { name } = node;
    if (scope.has(name)) {
      return ANY;
    }
    const builtin = builtinResult(name);
    if (!this.context) {
      return builtin ? { kinds: FUNCTION, builtin } : ANY;
    }
    const lookup = this.context.root(name);
    if (!lookup) {
      return ANY;
    }
    if ('found' in lookup) {
      return {
        kinds: this.context.kinds(lookup.found),
        type: lookup.found,
        path: name,
      };
    }
    // A builtin the context doesn't define resolves to the builtin.
    if (builtin) {
      return { kinds: FUNCTION, builtin };
    }
    this.report(
      'unknown_context_property',
      `Unknown context property "${name}"${suggestion(name, lookup.missing)}`,
      node,
    );
    return ANY;
  }

  private member(node: MemberNode, scope: ReadonlySet<string>): Info<Type> {
    const object = this.visit(node.object, scope);
    let key: string | undefined;
    if (node.property.type === 'Literal') {
      key = String(node.property.value);
    } else {
      this.visit(node.property, scope);
    }
    if (!this.context || object.type === undefined) {
      return ANY;
    }
    const lookup = this.context.member(object.type, key);
    if (!lookup) {
      return ANY;
    }
    if ('missing' in lookup) {
      this.report(
        'unknown_property',
        `Property "${key}" does not exist on "${object.path}"${suggestion(key!, lookup.missing)}`,
        node.property,
      );
      return ANY;
    }
    const kinds = this.context.kinds(lookup.found);
    // Loose evaluation turns access through null/undefined into undefined.
    const shortCircuit =
      this.loose &&
      (!object.kinds ||
        object.kinds.has('null') ||
        object.kinds.has('undefined'));
    return {
      kinds: shortCircuit ? union(kinds, UNDEFINED) : kinds,
      type: lookup.found,
      path: memberPath(object.path, key),
    };
  }

  private logical(
    operator: LogicalNode['operator'],
    left: Info<Type>,
    right: Info<Type>,
  ): Info<Type> {
    if (left.values) {
      const results = left.values.filter(value =>
        shortCircuits(operator, value),
      );
      if (results.length === left.values.length) {
        return valuesInfo(results);
      }
      if (right.values) {
        return valuesInfo([...results, ...right.values]);
      }
      return { kinds: union(new Set(results.map(kindOf)), right.kinds) };
    }
    const kept = restrict(
      left.kinds,
      operator === '&&'
        ? FALSY_CAPABLE
        : operator === '||'
          ? TRUTHY_CAPABLE
          : NOT_NULLISH,
    );
    return { kinds: union(kept, right.kinds) };
  }

  // Parameters shadow outer names; defaults are evaluated in order, so each
  // one sees the parameters bound before it (as in the evaluator).
  private arrow(
    node: ArrowFunctionNode,
    scope: ReadonlySet<string>,
  ): Info<Type> {
    const local = new Set(scope);
    forEachParamBinding(
      node.params,
      value => this.visit(value, local),
      name => local.add(name),
    );
    this.visit(node.body, local);
    return FUNCTION_INFO;
  }
}

/**
 * Statically validates a serialized expression: its syntax, the context
 * properties it reads (when a context model is given), and its result type
 * (when a return model is given). Returns every problem found.
 */
export function checkExpression<Type>(
  source: string,
  options: CheckOptions<Type> = {},
): ExprProblem[] {
  let ast: ASTNode;
  try {
    ast = parse(tokenize(source), source);
  } catch (error) {
    // Anything but an ExprSyntaxError (e.g. a stack overflow on deeply
    // nested input) covers the whole source.
    const syntax = error instanceof ExprSyntaxError ? error : undefined;
    const detail =
      syntax?.detail ??
      (error instanceof Error ? error.message : String(error));
    return [
      {
        reason: 'syntax',
        message: `Invalid expression syntax: ${detail}`,
        start: syntax?.start ?? 0,
        end: syntax?.end ?? source.length,
      },
    ];
  }
  const checker = new Checker(options.context, options.loose === true);
  const info = checker.visit(ast, new Set());
  if (options.returns) {
    checker.checkReturn(info, options.returns, ast);
  }
  return checker.problems;
}
