import {
  formatInvalid,
  type ArrowFunctionNode,
  type ArrowParam,
  type ASTNode,
  type CallNode,
  type IdentifierParam,
  type MemberNode,
  type ObjectNode,
  type TaggedTemplateNode,
} from '@conf-ts/expr-core';
import type { Expr, LooseExpr } from '@conf-ts/macro';

import { evaluate, type EvalOptions } from './eval';
import { parseSource } from './parse';
import type { Compiled, CompileOptions } from './types';

const MAX_CACHE_SIZE = 1000;
const cache = new Map<string, Compiled>();

const cacheSet = (key: string, value: Compiled<any, any>): void => {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) {
      cache.delete(firstKey);
    }
  }
  cache.set(key, value);
};

const cacheGet = (key: string): Compiled | undefined => {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
};

export class ExpressionCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionCompileError';
  }
}

const GLOBAL_BUILTINS: Record<string, unknown> = {
  String,
  Number,
  Boolean,
};

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

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

const template = (
  quasis: string[],
  rawQuasis: string[],
): TemplateStringsArray => {
  const raw = Object.freeze([...rawQuasis]);
  const strings = [...quasis] as string[] & { raw: readonly string[] };
  Object.defineProperty(strings, 'raw', { value: raw });
  return Object.freeze(strings) as unknown as TemplateStringsArray;
};

// Values generated functions close over. The keys double as the factory's
// parameter names, so generated code calls them as plain local identifiers
// (cheap context loads that TurboFan can specialize on through call feedback)
// instead of through property loads on a shared object. Each factory only
// declares the helpers its code uses; every extra parameter slows down
// `new Function`.
const HELPERS = {
  // Own-property guard for environment lookups (see eval.ts GLOBAL_BUILTINS).
  O: Object.prototype.hasOwnProperty,
  // Arrow scopes copy the environment with `{...env}` in the interpreter, which
  // only sees own *enumerable* properties.
  E: Object.prototype.propertyIsEnumerable,
  // Calls `fn` with an explicit receiver: C(fn, thisArg, ...args). Unlike
  // Reflect.apply it needs no argument array, and V8 reduces the bound
  // Function.prototype.call down to a direct call that can be inlined.
  C: Function.prototype.call.bind(Function.prototype.call),
  G: GLOBAL_BUILTINS,
  S: String,
  K: (key: unknown): PropertyKey =>
    typeof key === 'symbol' ? key : String(key),
  // Chain guards, small enough for TurboFan to inline: N passes a value whose
  // properties can be read, F a value that can be called, U tests for nullish.
  // Passing values through keeps the generated code short, which matters
  // because `new Function` cost grows with every token.
  N: <Value>(value: Value): Value => {
    if (value === null || value === undefined) {
      throw new TypeError('Cannot read properties of null or undefined');
    }
    return value;
  },
  F: <Value>(value: Value): Value => {
    if (typeof value !== 'function') {
      throw new TypeError('Expression value is not callable');
    }
    return value;
  },
  U: (value: unknown): boolean => value === null || value === undefined,
  DE: (): never => {
    throw new TypeError('Cannot destructure null or undefined');
  },
  CS: copySpread,
  T: template,
};

type Helper = keyof typeof HELPERS;

/** Thrown when lexical arrow scopes cannot represent the expression. */
class ScopeObjectsRequired extends Error {}

// Generated names are a lowercase prefix plus a counter, so they never collide
// with each other, with HELPERS, or with `env`. Source identifiers are never
// emitted as JavaScript identifiers; they only ever appear as quoted strings.
const SIMPLE_VARIABLE = /^[a-z]\d+$/;
const LINE_SEPARATORS = /[\u2028\u2029]/g;
const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/;

type ScopeKind = 'root' | 'lexical' | 'dynamic';

class Scope {
  /** `let` declarations emitted at the top of this function. */
  readonly locals: string[] = [];
  /** lexical: source name -> generated variable holding its current value. */
  readonly bindings = new Map<string, string>();
  /** Outermost lexical arrow: root names copied from `env` on entry. */
  readonly snapshots = new Map<string, string>();

  constructor(
    readonly kind: ScopeKind,
    readonly parent: Scope | null,
    /** root/dynamic: the object identifiers are looked up on. */
    readonly object: string,
  ) {}
}

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

const forEachChild = (node: ASTNode, visit: (child: ASTNode) => void): void => {
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
    case 'Elision':
      return;
    case 'ParenthesizedExpression':
    case 'ChainExpression':
      visit(node.expression);
      return;
    case 'UnaryExpression':
      visit(node.argument);
      return;
    case 'BinaryExpression':
    case 'LogicalExpression':
      visit(node.left);
      visit(node.right);
      return;
    case 'ConditionalExpression':
      visit(node.test);
      visit(node.consequent);
      visit(node.alternate);
      return;
    case 'MemberExpression':
      visit(node.object);
      if (node.computed) {
        visit(node.property);
      }
      return;
    case 'CallExpression':
      visit(node.callee);
      node.args.forEach(visit);
      return;
    case 'ArrayExpression':
      for (const element of node.elements) {
        visit(element.type === 'SpreadElement' ? element.argument : element);
      }
      return;
    case 'ObjectExpression':
      for (const property of node.properties) {
        if ('type' in property) {
          visit(property.argument);
        } else {
          if (property.computed) {
            visit(property.key);
          }
          visit(property.value);
        }
      }
      return;
    case 'TemplateLiteral':
      node.expressions.forEach(visit);
      return;
    case 'TaggedTemplateExpression':
      visit(node.tag);
      node.quasi.expressions.forEach(visit);
      return;
    case 'ArrowFunctionExpression':
      paramDefaults(node.params).forEach(visit);
      visit(node.body);
      return;
    default:
      return node satisfies never;
  }
};

const collectIdentifiers = (node: ASTNode, names: Set<string>): void => {
  if (node.type === 'Identifier') {
    names.add(node.name);
    return;
  }
  forEachChild(node, child => collectIdentifiers(child, names));
};

/**
 * Whether `node` compiles to code that needs no parentheses as an operand.
 * Generated code is otherwise only guaranteed to be an AssignmentExpression;
 * every redundant parenthesis costs V8 parse time in `new Function`.
 */
const isAtomic = (node: ASTNode): boolean => {
  switch (node.type) {
    case 'UnaryExpression':
      return node.operator === 'delete';
    case 'BinaryExpression':
    case 'LogicalExpression':
    case 'ConditionalExpression':
    case 'Elision':
      return false;
    case 'Literal':
      // `void 0`, `-0`, and `-Infinity` are unary expressions.
      return (
        node.value !== undefined &&
        !((node.value as number) < 0 || Object.is(node.value, -0))
      );
    default:
      return true;
  }
};

const boundNames = (param: ArrowParam): string[] => {
  switch (param.kind) {
    case 'identifier':
    case 'rest':
      return [param.name];
    case 'object':
      return param.properties.map(property => property.value.name);
    case 'array': {
      const names: string[] = [];
      for (const element of param.elements) {
        if (element !== null) {
          names.push(element.name);
        }
      }
      return names;
    }
  }
};

/**
 * Names an arrow binds that one of its own defaults can read (directly, or
 * through a closure created there) before their first binding, so they have to
 * start out holding their outer value.
 */
const earlyNames = (params: ArrowParam[]): Set<string> => {
  const all = new Set<string>();
  for (const param of params) {
    boundNames(param).forEach(name => all.add(name));
  }
  const bound = new Set<string>();
  const early = new Set<string>();
  const read = (node: ASTNode | undefined): void => {
    if (node === undefined) {
      return;
    }
    const names = new Set<string>();
    collectIdentifiers(node, names);
    names.forEach(name => {
      if (all.has(name) && !bound.has(name)) {
        early.add(name);
      }
    });
  };
  for (const param of params) {
    if (param.kind === 'rest' || param.kind === 'identifier') {
      read(param.kind === 'identifier' ? param.default : undefined);
      bound.add(param.name);
      continue;
    }
    read(param.default);
    const elements: Array<IdentifierParam | null> =
      param.kind === 'object'
        ? param.properties.map(property => property.value)
        : param.elements;
    for (const element of elements) {
      if (element !== null) {
        read(element.default);
        bound.add(element.name);
      }
    }
  }
  return early;
};

/**
 * Emits one JavaScript expression per AST node: native operators, property
 * reads, calls, and literals, with only inlinable guards (N, F, U) in between,
 * instead of runtime helper calls and per-evaluation closures. Values that are
 * read twice (a method receiver, an optional link) go into function-local
 * temporaries (`let t0,t1,...`).
 *
 * Arrow scopes are resolved at compile time. The interpreter gives each arrow
 * call a scope object `{...outer}` and writes parameters into it; here every
 * name an arrow binds is a generated variable that holds exactly what that
 * object would hold (the outer value until the parameter is bound), and the
 * outermost arrow copies the root names it uses from `env` on entry, the same
 * moment the interpreter spreads `env`. `delete name` inside an arrow mutates
 * that scope object, so such expressions are regenerated with real scope
 * objects (`dynamicScopes`).
 */
class Generator {
  private counter = 0;
  private readonly root: Scope;
  private scope: Scope;
  /** Root name -> per-evaluation cache of its enumerability, for snapshots. */
  private readonly enumerable = new Map<string, string>();
  /** Helpers referenced by the generated code, in first-use order. */
  readonly helpers = new Set<Helper>();

  constructor(
    private readonly loose: boolean,
    private readonly dynamicScopes: boolean,
  ) {
    this.root = new Scope('root', null, 'env');
    this.scope = this.root;
  }

  build(node: ASTNode): string {
    const body = this.generate(node);
    return `function compiledExpression(env){${this.declare(this.root.locals)}return ${body};}`;
  }

  private h(name: Helper): Helper {
    this.helpers.add(name);
    return name;
  }

  private fresh(prefix: string): string {
    return `${prefix}${this.counter++}`;
  }

  private local(prefix: string, scope: Scope = this.scope): string {
    const name = this.fresh(prefix);
    scope.locals.push(name);
    return name;
  }

  private declare(names: string[]): string {
    return names.length > 0 ? `let ${names.join(',')};` : '';
  }

  private quote(value: string): string {
    return JSON.stringify(value).replace(LINE_SEPARATORS, separator =>
      separator === '\u2028' ? '\\u2028' : '\\u2029',
    );
  }

  private stringArray(values: string[]): string {
    return `[${values.map(value => this.quote(value)).join(',')}]`;
  }

  private literal(value: unknown): string {
    if (value === undefined) {
      return 'void 0';
    }
    if (typeof value === 'number') {
      if (Number.isNaN(value)) {
        return 'NaN';
      }
      if (value === Infinity) {
        return 'Infinity';
      }
      if (value === -Infinity) {
        return '-Infinity';
      }
      if (Object.is(value, -0)) {
        return '-0';
      }
      return String(value);
    }
    if (value === null || typeof value === 'boolean') {
      return JSON.stringify(value);
    }
    if (typeof value === 'string') {
      return this.quote(value);
    }
    if (typeof value === 'bigint') {
      return `${value}n`;
    }
    throw new ExpressionCompileError(
      `Cannot compile a literal of type ${typeof value}`,
    );
  }

  private builtin(name: string): string {
    return hasOwn(GLOBAL_BUILTINS, name)
      ? `${this.h('G')}[${this.quote(name)}]`
      : 'void 0';
  }

  /** `.key` when `key` is an identifier name, `["key"]` otherwise. */
  private property(key: string): string {
    return IDENTIFIER_NAME.test(key) ? `.${key}` : `[${this.quote(key)}]`;
  }

  private lookup(object: string, name: string): string {
    return `(${this.h('O')}.call(${object},${this.quote(name)})?${object}${this.property(name)}:${this.builtin(name)})`;
  }

  /**
   * Binds `code` to a variable that can be read repeatedly. The assignment is
   * unparenthesized, for use as a call argument.
   */
  private hold(code: string): [variable: string, assignment: string] {
    if (SIMPLE_VARIABLE.test(code)) {
      return [code, code];
    }
    const variable = this.local('t');
    return [variable, `${variable}=${code}`];
  }

  /** `N(code)`, held in a variable when it is not one already. */
  private holdGuarded(code: string): [variable: string, expression: string] {
    const guarded = `${this.h('N')}(${code})`;
    if (SIMPLE_VARIABLE.test(code)) {
      return [code, guarded];
    }
    const variable = this.local('t');
    return [variable, `(${variable}=${guarded})`];
  }

  private identifier(name: string): string {
    let scope = this.scope;
    while (scope.kind === 'lexical') {
      const bound = scope.bindings.get(name);
      if (bound !== undefined) {
        return bound;
      }
      if (scope.parent!.kind === 'root') {
        return this.snapshot(scope, name);
      }
      scope = scope.parent!;
    }
    return this.lookup(scope.object, name);
  }

  private snapshot(scope: Scope, name: string): string {
    let variable = scope.snapshots.get(name);
    if (variable === undefined) {
      variable = this.fresh('s');
      scope.snapshots.set(name, variable);
    }
    return variable;
  }

  /**
   * The value `{...env}` would give `name`. Enumerability is sampled once
   * per evaluation and shared by every arrow call in it; the own-property
   * check and the read stay per call.
   */
  private snapshotValue(name: string): string {
    let cache = this.enumerable.get(name);
    if (cache === undefined) {
      cache = this.local('c', this.root);
      this.enumerable.set(name, cache);
    }
    const key = this.quote(name);
    return `!${this.h('U')}(env)&&${this.h('O')}.call(env,${key})&&(${cache}===void 0?(${cache}=${this.h('E')}.call(env,${key})):${cache})?env${this.property(name)}:${this.builtin(name)}`;
  }

  private generate(node: ASTNode): string {
    switch (node.type) {
      case 'Literal': {
        return this.literal(node.value);
      }
      case 'Identifier': {
        return this.identifier(node.name);
      }
      case 'Elision': {
        return 'void 0';
      }
      case 'ParenthesizedExpression': {
        return this.operand(node.expression);
      }
      case 'ChainExpression': {
        const expression = node.expression;
        return expression.type === 'MemberExpression' ||
          expression.type === 'CallExpression'
          ? this.generateChain(expression, 'void 0', false)
          : this.generate(expression);
      }
      case 'UnaryExpression': {
        if (node.operator === 'delete') {
          return this.generateDelete(node.argument);
        }
        return `${node.operator} ${this.operand(node.argument)}`;
      }
      case 'BinaryExpression':
      case 'LogicalExpression': {
        return `${this.operand(node.left)} ${node.operator} ${this.operand(node.right)}`;
      }
      case 'ConditionalExpression': {
        return `${this.operand(node.test)}?${this.generate(node.consequent)}:${this.generate(node.alternate)}`;
      }
      case 'MemberExpression':
      case 'CallExpression': {
        return this.generateChain(node, 'void 0', false);
      }
      case 'ArrayExpression': {
        const elements = node.elements.map(element =>
          element.type === 'SpreadElement'
            ? `...${this.generate(element.argument)}`
            : element.type === 'Elision'
              ? ''
              : this.generate(element),
        );
        // A trailing hole needs its own comma: `[a,,]` has length 2.
        const last = node.elements[node.elements.length - 1];
        return `[${elements.join(',')}${last?.type === 'Elision' ? ',' : ''}]`;
      }
      case 'ObjectExpression': {
        return this.generateObject(node);
      }
      case 'TemplateLiteral': {
        const parts: string[] = [];
        node.quasis.forEach((quasi, index) => {
          if (quasi !== '') {
            parts.push(this.quote(quasi));
          }
          const expression = node.expressions[index];
          if (expression !== undefined) {
            parts.push(`${this.h('S')}(${this.generate(expression)})`);
          }
        });
        return parts.length > 1 ? `(${parts.join('+')})` : (parts[0] ?? '""');
      }
      case 'TaggedTemplateExpression': {
        return this.generateTaggedTemplate(node);
      }
      case 'ArrowFunctionExpression': {
        return this.generateArrow(node);
      }
      default: {
        return node satisfies never;
      }
    }
  }

  /** `node` as an operand of any operator. */
  private operand(node: ASTNode): string {
    const code = this.generate(node);
    return isAtomic(node) ? code : `(${code})`;
  }

  /**
   * Member/call chains, flattened so an optional link (`?.`, or any member
   * read in loose mode) short-circuits the rest of the chain to `shortValue`,
   * as ChainExpression does. Outside a ChainExpression no link is optional
   * unless loose mode applies, and there a short-circuit at any depth already
   * propagates `undefined` to the end, so flattening is exact.
   */
  private generateChain(
    node: MemberNode | CallNode,
    shortValue: string,
    deleteLast: boolean,
  ): string {
    const links: Array<MemberNode | CallNode> = [];
    let base: ASTNode = node;
    while (base.type === 'MemberExpression' || base.type === 'CallExpression') {
      links.push(base);
      base = base.type === 'MemberExpression' ? base.object : base.callee;
    }
    links.reverse();
    return this.generateLinks(
      this.generate(base),
      links,
      0,
      null,
      shortValue,
      deleteLast,
    );
  }

  private generateLinks(
    current: string,
    links: Array<MemberNode | CallNode>,
    index: number,
    receiver: string | null,
    shortValue: string,
    deleteLast: boolean,
  ): string {
    if (index === links.length) {
      return current;
    }
    const link = links[index];
    const next = (code: string, nextReceiver: string | null): string =>
      this.generateLinks(
        code,
        links,
        index + 1,
        nextReceiver,
        shortValue,
        deleteLast,
      );

    if (link.type === 'MemberExpression') {
      const remove = deleteLast && index === links.length - 1 ? 'delete ' : '';
      // Keys are generated after the object, so they run only once it is
      // known to be non-nullish, as in the interpreter.
      if (link.optional === true || this.loose) {
        const [object, assignment] = this.hold(current);
        return `(${this.h('U')}(${assignment})?${shortValue}:${next(`${remove}${object}${this.memberKey(link)}`, object)})`;
      }
      if (links[index + 1]?.type === 'CallExpression') {
        const [object, guarded] = this.holdGuarded(current);
        return next(`${guarded}${this.memberKey(link)}`, object);
      }
      return next(
        `${remove}${this.h('N')}(${current})${this.memberKey(link)}`,
        null,
      );
    }

    // F checks callability before any argument is evaluated.
    const args = link.args.map(argument => this.generate(argument));
    const call = (fn: string): string =>
      receiver === null
        ? `${this.h('F')}(${fn})(${args.join(',')})`
        : `${this.h('C')}(${[`${this.h('F')}(${fn})`, receiver, ...args].join(',')})`;
    if (link.optional) {
      const [fn, assignment] = this.hold(current);
      return `(${this.h('U')}(${assignment})?${shortValue}:${next(call(fn), null)})`;
    }
    return next(call(current), null);
  }

  private memberKey(link: MemberNode): string {
    return link.computed
      ? `[${this.generate(link.property)}]`
      : this.property(String((link.property as { value: unknown }).value));
  }

  private generateDelete(node: ASTNode): string {
    switch (node.type) {
      case 'ParenthesizedExpression':
        return this.generateDelete(node.expression);
      case 'ChainExpression':
        return node.expression.type === 'MemberExpression'
          ? `(${this.generateChain(node.expression, 'true', true)})`
          : `(${this.generate(node.expression)},true)`;
      case 'Identifier': {
        if (this.scope.kind === 'lexical') {
          throw new ScopeObjectsRequired();
        }
        return `(delete ${this.scope.object}[${this.quote(node.name)}])`;
      }
      case 'MemberExpression':
        return `(${this.generateChain(node, 'true', true)})`;
      default:
        return `(${this.generate(node)},true)`;
    }
  }

  /**
   * A native literal up to the first computed key or key that exists on
   * `Object.prototype`; the interpreter assigns properties one by one, so from
   * there on the generated code does the same. Assignment and literal
   * definition only differ for those keys: a computed key is coerced before
   * its value runs, `__proto__` goes through the setter, and an inherited
   * setter or read-only property (frozen intrinsics) intercepts assignment.
   */
  private generateObject(node: ObjectNode): string {
    const parts: string[] = [];
    let index = 0;
    for (; index < node.properties.length; index++) {
      const property = node.properties[index];
      if ('type' in property) {
        parts.push(`...${this.generate(property.argument)}`);
      } else if (property.computed || property.key in Object.prototype) {
        break;
      } else {
        parts.push(
          `${this.quote(property.key)}:${this.generate(property.value)}`,
        );
      }
    }
    const literal = `{${parts.join(',')}}`;
    if (index === node.properties.length) {
      return `(${literal})`;
    }

    const object = this.local('t');
    const steps = [`${object}=${literal}`];
    for (; index < node.properties.length; index++) {
      const property = node.properties[index];
      if ('type' in property) {
        steps.push(
          `${this.h('CS')}(${object},${this.generate(property.argument)})`,
        );
      } else if (property.computed) {
        steps.push(
          `${object}[${this.h('K')}(${this.generate(property.key)})]=${this.generate(property.value)}`,
        );
      } else {
        steps.push(
          `${object}[${this.quote(property.key)}]=${this.generate(property.value)}`,
        );
      }
    }
    return `(${steps.join(',')},${object})`;
  }

  private generateTaggedTemplate(node: TaggedTemplateNode): string {
    const tagNode = node.tag;
    if (tagNode.type !== 'MemberExpression') {
      const tag = this.generate(tagNode);
      return `${this.h('F')}(${tag})(${this.templateArguments(node)})`;
    }
    const objectCode = this.generate(tagNode.object);
    if (tagNode.optional === true || this.loose) {
      const [object, assignment] = this.hold(objectCode);
      const tag = `${object}${this.memberKey(tagNode)}`;
      return `(${this.h('U')}(${assignment})?void 0:${this.h('C')}(${this.h('F')}(${tag}),${object},${this.templateArguments(node)}))`;
    }
    const [object, guarded] = this.holdGuarded(objectCode);
    const tag = `${guarded}${this.memberKey(tagNode)}`;
    return `${this.h('C')}(${this.h('F')}(${tag}),${object},${this.templateArguments(node)})`;
  }

  /** The strings array is created after the tag is known to be callable. */
  private templateArguments(node: TaggedTemplateNode): string {
    const strings = `${this.h('T')}(${this.stringArray(node.quasi.quasis)},${this.stringArray(node.quasi.rawQuasis)})`;
    const values = node.quasi.expressions.map(expression =>
      this.generate(expression),
    );
    return [strings, ...values].join(',');
  }

  private generateArrow(node: ArrowFunctionNode): string {
    const parent = this.scope;
    const dynamic = this.dynamicScopes;
    const scope = new Scope(
      dynamic ? 'dynamic' : 'lexical',
      parent,
      dynamic ? this.fresh('e') : '',
    );

    // Default every parameter to `void 0` so `fn.length` stays 0, matching
    // the interpreter's `(...args) => ...` closure.
    const params = node.params.map(() => this.fresh('p'));
    const signature = node.params.map((param, index) =>
      param.kind === 'rest' ? `...${params[index]}` : `${params[index]}=void 0`,
    );

    const prologue: string[] = [];
    if (dynamic) {
      prologue.push(`const ${scope.object}={...${parent.object}};`);
    } else {
      const early = earlyNames(node.params);
      const counts = new Map<string, number>();
      for (const param of node.params) {
        for (const name of boundNames(param)) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
      node.params.forEach((param, index) => {
        const direct =
          (param.kind === 'rest' ||
            (param.kind === 'identifier' && param.default === undefined)) &&
          counts.get(param.name) === 1 &&
          !early.has(param.name);
        if (direct) {
          scope.bindings.set(param.name, params[index]);
        }
      });
      const initialized: string[] = [];
      counts.forEach((_, name) => {
        if (scope.bindings.has(name)) {
          return;
        }
        if (early.has(name)) {
          const variable = this.fresh('v');
          initialized.push(`${variable}=${this.outer(scope, name)}`);
          scope.bindings.set(name, variable);
        } else {
          scope.bindings.set(name, this.local('v', scope));
        }
      });
      if (initialized.length > 0) {
        prologue.push(`let ${initialized.join(',')};`);
      }
    }

    this.scope = scope;
    const assign = (name: string, value: string): string =>
      dynamic
        ? `${scope.object}[${this.quote(name)}]=${value};`
        : scope.bindings.get(name) === value
          ? ''
          : `${scope.bindings.get(name)}=${value};`;
    const withDefault = (value: string, fallback: ASTNode | undefined) =>
      fallback === undefined
        ? value
        : `${value}===void 0?${this.generate(fallback)}:${value}`;
    const bindElement = (element: IdentifierParam, source: string): string => {
      if (element.default === undefined) {
        return assign(element.name, source);
      }
      const value = this.local('t');
      return `${value}=${source};${assign(element.name, withDefault(value, element.default))}`;
    };

    const statements: string[] = [];
    node.params.forEach((param, index) => {
      const argument = params[index];
      if (param.kind === 'rest') {
        statements.push(assign(param.name, argument));
        return;
      }
      if (param.kind === 'identifier') {
        statements.push(
          assign(param.name, withDefault(argument, param.default)),
        );
        return;
      }
      // Parameters are never reassigned, so one without a default can be
      // destructured in place.
      let source = argument;
      if (param.default !== undefined) {
        source = this.local('d');
        statements.push(`${source}=${withDefault(argument, param.default)};`);
      }
      statements.push(`if(${this.h('U')}(${source}))${this.h('DE')}();`);
      if (param.kind === 'object') {
        for (const property of param.properties) {
          statements.push(
            bindElement(
              property.value,
              `${source}${this.property(property.key)}`,
            ),
          );
        }
      } else {
        param.elements.forEach((element, position) => {
          if (element !== null) {
            statements.push(bindElement(element, `${source}[${position}]`));
          }
        });
      }
    });
    const body = this.generate(node.body);
    this.scope = parent;

    const snapshots: string[] = [];
    scope.snapshots.forEach((variable, name) => {
      snapshots.push(`${variable}=${this.snapshotValue(name)}`);
    });
    const head = [
      snapshots.length > 0 ? `const ${snapshots.join(',')};` : '',
      ...prologue,
      this.declare(scope.locals),
      ...statements,
    ].join('');
    // `(0,fn)` keeps the arrow anonymous wherever it lands (an object literal
    // property or a temporary would otherwise name it), as in the interpreter.
    const fn =
      head === ''
        ? `(${signature.join(',')})=>${body}`
        : `(${signature.join(',')})=>{${head}return ${body};}`;
    return `(0,${fn})`;
  }

  /** What `name` means just outside `scope`, at the moment it is entered. */
  private outer(scope: Scope, name: string): string {
    if (scope.parent!.kind === 'root') {
      return this.snapshot(scope, name);
    }
    const saved = this.scope;
    this.scope = scope.parent!;
    const code = this.identifier(name);
    this.scope = saved;
    return code;
  }
}

const compileAst = <Context, ReturnType>(
  ast: ASTNode,
  optionalMemberAccess: boolean,
): Compiled<Context, ReturnType> => {
  let generator = new Generator(optionalMemberAccess, false);
  let source: string;
  try {
    source = generator.build(ast);
  } catch (error) {
    if (!(error instanceof ScopeObjectsRequired)) {
      throw error;
    }
    generator = new Generator(optionalMemberAccess, true);
    source = generator.build(ast);
  }
  const names = [...generator.helpers];
  try {
    const FunctionConstructor = Function;
    const factory = new FunctionConstructor(
      ...names,
      `"use strict";return ${source}`,
    ) as (...helpers: unknown[]) => Compiled<Context, ReturnType>;
    return factory(...names.map(name => HELPERS[name]));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new ExpressionCompileError(
      `Expression code generation is unavailable${detail}`,
    );
  }
};

export function compile<Context = unknown, ReturnType = unknown>(
  expr: LooseExpr<Context, ReturnType>,
  options: CompileOptions & ({ optionalMemberAccess: true } | { loose: true }),
): Compiled<Context, ReturnType>;
export function compile<Context = unknown, ReturnType = unknown>(
  expr: Expr<Context, ReturnType>,
  options?: CompileOptions,
): Compiled<Context, ReturnType>;
export function compile(
  expr: string,
  options?: CompileOptions,
): Compiled<unknown, unknown>;
export function compile<Context = unknown, ReturnType = unknown>(
  expr: Expr<Context, ReturnType> | string,
  options?: CompileOptions,
): Compiled<Context, ReturnType> {
  if (typeof expr !== 'string') {
    throw new Error(formatInvalid());
  }

  const optionalMemberAccess =
    options?.optionalMemberAccess === true || options?.loose === true;
  const cacheKey = (optionalMemberAccess ? 'o' : 's') + expr;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return cached as Compiled<Context, ReturnType>;
  }

  const ast = parseSource(expr);
  if (ast === null) {
    const result: Compiled<Context, ReturnType> = () => undefined as ReturnType;
    cacheSet(cacheKey, result);
    return result;
  }

  try {
    const result = compileAst<Context, ReturnType>(ast, optionalMemberAccess);
    cacheSet(cacheKey, result);
    return result;
  } catch (error) {
    if (options?.strict) {
      throw error instanceof ExpressionCompileError
        ? error
        : new ExpressionCompileError('Expression code generation failed');
    }
    const evalOptions: EvalOptions | undefined = optionalMemberAccess
      ? { optionalMemberAccess: true }
      : undefined;
    return (env: Context) =>
      evaluate(ast, env as Record<string, unknown>, evalOptions) as ReturnType;
  }
}
