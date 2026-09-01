import {
  formatInvalid,
  type ArrowParam,
  type ASTNode,
  type ComputedObjectProperty,
  type ObjectProperty,
  type SpreadElement,
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

const SHORT_CIRCUIT = Symbol('compiled-chain-short-circuit');
const GLOBAL_BUILTINS: Record<string, unknown> = {
  String,
  Number,
  Boolean,
};

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

const runtime = Object.freeze({
  shortCircuit: SHORT_CIRCUIT,
  lookup(env: Record<string, unknown>, name: string): unknown {
    return hasOwn(env, name)
      ? env[name]
      : hasOwn(GLOBAL_BUILTINS, name)
        ? GLOBAL_BUILTINS[name]
        : undefined;
  },
  finish(value: unknown): unknown {
    return value === SHORT_CIRCUIT ? undefined : value;
  },
  read(object: unknown, key: PropertyKey, optional: boolean): unknown {
    if (object === SHORT_CIRCUIT) {
      return SHORT_CIRCUIT;
    }
    if (object === null || object === undefined) {
      if (optional) {
        return SHORT_CIRCUIT;
      }
      return runtime.nullishMemberError();
    }
    return (object as Record<PropertyKey, unknown>)[key];
  },
  readComputed(
    object: unknown,
    getKey: () => unknown,
    optional: boolean,
  ): unknown {
    if (object === SHORT_CIRCUIT) {
      return SHORT_CIRCUIT;
    }
    if (object === null || object === undefined) {
      if (optional) {
        return SHORT_CIRCUIT;
      }
      return runtime.nullishMemberError();
    }
    return (object as Record<PropertyKey, unknown>)[runtime.toKey(getKey())];
  },
  toKey(key: unknown): PropertyKey {
    return typeof key === 'symbol' ? key : String(key);
  },
  nullishMemberError(): never {
    throw new TypeError('Cannot read properties of null or undefined');
  },
  nonCallableError(): never {
    throw new TypeError('Expression value is not callable');
  },
  apply(
    fn: (...args: unknown[]) => unknown,
    thisArg: unknown,
    args: unknown[],
  ): unknown {
    return Reflect.apply(fn, thisArg, args);
  },
  copySpread(target: object, source: unknown): void {
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
  },
  spreadArray(target: unknown[], source: unknown): void {
    for (const item of source as Iterable<unknown>) {
      target.push(item);
    }
  },
  destructure(source: unknown): Record<PropertyKey, unknown> {
    if (source === null || source === undefined) {
      throw new TypeError('Cannot destructure null or undefined');
    }
    return source as Record<PropertyKey, unknown>;
  },
  template(quasis: string[], rawQuasis: string[]): TemplateStringsArray {
    const raw = Object.freeze([...rawQuasis]);
    const strings = [...quasis] as string[] & { raw: readonly string[] };
    Object.defineProperty(strings, 'raw', { value: raw });
    return Object.freeze(strings) as unknown as TemplateStringsArray;
  },
  toString(value: unknown): string {
    return String(value);
  },
});

type Runtime = typeof runtime;

class Generator {
  private variableCounter = 0;

  constructor(private readonly optionalMemberAccess: boolean) {}

  build(node: ASTNode): string {
    return this.generate(node, 'env');
  }

  private nextVariable(prefix: string): string {
    return `${prefix}${this.variableCounter++}`;
  }

  private quote(value: string): string {
    return JSON.stringify(value)
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
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

  private generate(node: ASTNode, scope: string): string {
    switch (node.type) {
      case 'Literal': {
        return this.literal(node.value);
      }
      case 'Identifier': {
        return `h.lookup(${scope},${this.quote(node.name)})`;
      }
      case 'Elision': {
        return 'void 0';
      }
      case 'ParenthesizedExpression': {
        return `(${this.generate(node.expression, scope)})`;
      }
      case 'ChainExpression': {
        return `h.finish(${this.generateChainOperand(node.expression, scope)})`;
      }
      case 'UnaryExpression': {
        if (node.operator === 'delete') {
          return this.generateDelete(node.argument, scope);
        }
        return `(${node.operator} (${this.generate(node.argument, scope)}))`;
      }
      case 'BinaryExpression': {
        return `((${this.generate(node.left, scope)}) ${node.operator} (${this.generate(node.right, scope)}))`;
      }
      case 'LogicalExpression': {
        return `((${this.generate(node.left, scope)}) ${node.operator} (${this.generate(node.right, scope)}))`;
      }
      case 'ConditionalExpression': {
        return `((${this.generate(node.test, scope)}) ? (${this.generate(node.consequent, scope)}) : (${this.generate(node.alternate, scope)}))`;
      }
      case 'MemberExpression': {
        return `h.finish(${this.generateMember(node, scope, false)})`;
      }
      case 'CallExpression': {
        return `h.finish(${this.generateCall(node, scope, false)})`;
      }
      case 'ArrayExpression': {
        return this.generateArray(node, scope);
      }
      case 'ObjectExpression': {
        return this.generateObject(node, scope);
      }
      case 'TemplateLiteral': {
        let result = this.quote(node.quasis[0] ?? '');
        node.expressions.forEach((expression, index) => {
          result = `(${result}+h.toString(${this.generate(expression, scope)})+${this.quote(node.quasis[index + 1] ?? '')})`;
        });
        return result;
      }
      case 'TaggedTemplateExpression': {
        return this.generateTaggedTemplate(node, scope);
      }
      case 'ArrowFunctionExpression': {
        return this.generateArrow(node, scope);
      }
      default: {
        return node satisfies never;
      }
    }
  }

  private generateChainOperand(node: ASTNode, scope: string): string {
    if (node.type === 'MemberExpression') {
      return this.generateMember(node, scope, true);
    }
    if (node.type === 'CallExpression') {
      return this.generateCall(node, scope, true);
    }
    return this.generate(node, scope);
  }

  private generateMember(
    node: Extract<ASTNode, { type: 'MemberExpression' }>,
    scope: string,
    chain: boolean,
  ): string {
    const object = chain
      ? this.generateChainOperand(node.object, scope)
      : this.generate(node.object, scope);
    const optional = node.optional === true || this.optionalMemberAccess;
    if (node.computed) {
      return `h.readComputed(${object},()=>(${this.generate(node.property, scope)}),${optional})`;
    }
    const key = String(
      (node.property as Extract<ASTNode, { type: 'Literal' }>).value,
    );
    return `h.read(${object},${this.quote(key)},${optional})`;
  }

  private generateCall(
    node: Extract<ASTNode, { type: 'CallExpression' }>,
    scope: string,
    chain: boolean,
  ): string {
    const fn = this.nextVariable('f');
    const lines: string[] = [];
    let thisArg = 'void 0';

    if (node.callee.type === 'MemberExpression') {
      const object = this.nextVariable('o');
      const objectCode = chain
        ? this.generateChainOperand(node.callee.object, scope)
        : this.generate(node.callee.object, scope);
      const memberOptional =
        node.callee.optional === true || this.optionalMemberAccess;
      lines.push(`const ${object}=${objectCode};`);
      lines.push(`if(${object}===h.shortCircuit)return h.shortCircuit;`);
      lines.push(
        `if(${object}===null||${object}===void 0){${memberOptional ? 'return h.shortCircuit;' : 'h.nullishMemberError();'}}`,
      );
      if (node.callee.computed) {
        const key = this.nextVariable('k');
        lines.push(
          `const ${key}=h.toKey(${this.generate(node.callee.property, scope)});`,
        );
        lines.push(`const ${fn}=${object}[${key}];`);
      } else {
        const key = String(
          (node.callee.property as Extract<ASTNode, { type: 'Literal' }>).value,
        );
        lines.push(`const ${fn}=${object}[${this.quote(key)}];`);
      }
      thisArg = object;
    } else {
      const callee = chain
        ? this.generateChainOperand(node.callee, scope)
        : this.generate(node.callee, scope);
      lines.push(`const ${fn}=${callee};`);
      lines.push(`if(${fn}===h.shortCircuit)return h.shortCircuit;`);
    }

    if (node.optional) {
      lines.push(`if(${fn}===null||${fn}===void 0)return h.shortCircuit;`);
    }
    lines.push(`if(typeof ${fn}!=="function")h.nonCallableError();`);
    const args = node.args.map(argument => this.generate(argument, scope));
    lines.push(`return h.apply(${fn},${thisArg},[${args.join(',')}]);`);
    return `(()=>{${lines.join('')}})()`;
  }

  private generateDelete(node: ASTNode, scope: string): string {
    if (node.type === 'ParenthesizedExpression') {
      return this.generateDelete(node.expression, scope);
    }
    if (node.type === 'ChainExpression') {
      if (node.expression.type !== 'MemberExpression') {
        return `(()=>{${this.generate(node.expression, scope)};return true;})()`;
      }
      return this.generateMemberDelete(node.expression, scope, true);
    }
    if (node.type === 'Identifier') {
      return `(delete ${scope}[${this.quote(node.name)}])`;
    }
    if (node.type === 'MemberExpression') {
      return this.generateMemberDelete(node, scope, false);
    }
    return `(()=>{${this.generate(node, scope)};return true;})()`;
  }

  private generateMemberDelete(
    node: Extract<ASTNode, { type: 'MemberExpression' }>,
    scope: string,
    chain: boolean,
  ): string {
    const object = this.nextVariable('o');
    const key = this.nextVariable('k');
    const objectCode = chain
      ? this.generateChainOperand(node.object, scope)
      : this.generate(node.object, scope);
    const optional = node.optional === true || this.optionalMemberAccess;
    const keyCode = node.computed
      ? `h.toKey(${this.generate(node.property, scope)})`
      : this.quote(
          String(
            (node.property as Extract<ASTNode, { type: 'Literal' }>).value,
          ),
        );
    return `(()=>{const ${object}=${objectCode};if(${object}===h.shortCircuit)return true;if(${object}===null||${object}===void 0){${optional ? 'return true;' : 'h.nullishMemberError();'}}const ${key}=${keyCode};return delete ${object}[${key}];})()`;
  }

  private generateArray(
    node: Extract<ASTNode, { type: 'ArrayExpression' }>,
    scope: string,
  ): string {
    const array = this.nextVariable('a');
    const lines = [`const ${array}=[];`];
    for (const element of node.elements) {
      if (element.type === 'SpreadElement') {
        lines.push(
          `h.spreadArray(${array},${this.generate(element.argument, scope)});`,
        );
      } else if (element.type === 'Elision') {
        lines.push(`${array}.length+=1;`);
      } else {
        lines.push(`${array}.push(${this.generate(element, scope)});`);
      }
    }
    lines.push(`return ${array};`);
    return `(()=>{${lines.join('')}})()`;
  }

  private generateObject(
    node: Extract<ASTNode, { type: 'ObjectExpression' }>,
    scope: string,
  ): string {
    const object = this.nextVariable('o');
    const lines = [`const ${object}={};`];
    for (const property of node.properties) {
      if ((property as SpreadElement).type === 'SpreadElement') {
        lines.push(
          `h.copySpread(${object},${this.generate((property as SpreadElement).argument, scope)});`,
        );
      } else if ((property as ComputedObjectProperty).computed) {
        const item = property as ComputedObjectProperty;
        lines.push(
          `${object}[h.toKey(${this.generate(item.key, scope)})]=${this.generate(item.value, scope)};`,
        );
      } else {
        const item = property as ObjectProperty;
        lines.push(
          `${object}[${this.quote(item.key)}]=${this.generate(item.value, scope)};`,
        );
      }
    }
    lines.push(`return ${object};`);
    return `(()=>{${lines.join('')}})()`;
  }

  private generateArrow(
    node: Extract<ASTNode, { type: 'ArrowFunctionExpression' }>,
    scope: string,
  ): string {
    const args = this.nextVariable('args');
    const local = this.nextVariable('env');
    const lines = [`const ${local}={...${scope}};`];

    node.params.forEach((param, index) => {
      if (param.kind === 'rest') {
        lines.push(
          `${local}[${this.quote(param.name)}]=${args}.slice(${index});`,
        );
      } else {
        lines.push(...this.bindParam(param, `${args}[${index}]`, local));
      }
    });
    lines.push(`return ${this.generate(node.body, local)};`);
    return `(...${args})=>{${lines.join('')}}`;
  }

  private bindParam(
    param: Exclude<ArrowParam, { kind: 'rest' }>,
    argument: string,
    scope: string,
  ): string[] {
    if (param.kind === 'identifier') {
      if (param.default === undefined) {
        return [`${scope}[${this.quote(param.name)}]=${argument};`];
      }
      const value = this.nextVariable('p');
      return [
        `const ${value}=${argument};`,
        `${scope}[${this.quote(param.name)}]=${value}===void 0?${this.generate(param.default, scope)}:${value};`,
      ];
    }

    const value = this.nextVariable('p');
    const source = this.nextVariable('d');
    const lines = [`const ${value}=${argument};`];
    const resolved =
      param.default === undefined
        ? value
        : `${value}===void 0?${this.generate(param.default, scope)}:${value}`;
    lines.push(`const ${source}=h.destructure(${resolved});`);

    if (param.kind === 'object') {
      for (const property of param.properties) {
        lines.push(
          ...this.bindParam(
            property.value,
            `${source}[${this.quote(property.key)}]`,
            scope,
          ),
        );
      }
    } else {
      param.elements.forEach((element, index) => {
        if (element !== null) {
          lines.push(...this.bindParam(element, `${source}[${index}]`, scope));
        }
      });
    }
    return lines;
  }

  private generateTaggedTemplate(
    node: Extract<ASTNode, { type: 'TaggedTemplateExpression' }>,
    scope: string,
  ): string {
    const tag = this.nextVariable('f');
    const lines: string[] = [];
    let thisArg = 'void 0';

    if (node.tag.type === 'MemberExpression') {
      const object = this.nextVariable('o');
      const optional = node.tag.optional === true || this.optionalMemberAccess;
      lines.push(`const ${object}=${this.generate(node.tag.object, scope)};`);
      lines.push(`if(${object}===h.shortCircuit)return void 0;`);
      lines.push(
        `if(${object}===null||${object}===void 0){${optional ? 'return void 0;' : 'h.nullishMemberError();'}}`,
      );
      if (node.tag.computed) {
        const key = this.nextVariable('k');
        lines.push(
          `const ${key}=h.toKey(${this.generate(node.tag.property, scope)});`,
        );
        lines.push(`const ${tag}=${object}[${key}];`);
      } else {
        const key = String(
          (node.tag.property as Extract<ASTNode, { type: 'Literal' }>).value,
        );
        lines.push(`const ${tag}=${object}[${this.quote(key)}];`);
      }
      thisArg = object;
    } else {
      lines.push(`const ${tag}=${this.generate(node.tag, scope)};`);
    }

    lines.push(`if(typeof ${tag}!=="function")h.nonCallableError();`);
    const strings = `h.template(${this.stringArray(node.quasi.quasis)},${this.stringArray(node.quasi.rawQuasis)})`;
    const values = node.quasi.expressions.map(expression =>
      this.generate(expression, scope),
    );
    lines.push(
      `return h.apply(${tag},${thisArg},[${strings}${values.length > 0 ? `,${values.join(',')}` : ''}]);`,
    );
    return `(()=>{${lines.join('')}})()`;
  }
}

const compileAst = <Context, ReturnType>(
  ast: ASTNode,
  optionalMemberAccess: boolean,
): Compiled<Context, ReturnType> => {
  const body = new Generator(optionalMemberAccess).build(ast);
  const factorySource = `"use strict";return function compiledExpression(env){return ${body};}`;
  try {
    const FunctionConstructor = Function;
    const factory = new FunctionConstructor('h', factorySource) as (
      helpers: Runtime,
    ) => Compiled<Context, ReturnType>;
    return factory(runtime);
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
