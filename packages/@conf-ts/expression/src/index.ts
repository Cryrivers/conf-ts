import { tokenize } from './ast/lexer';
import { parse } from './ast/parser';
import type { ASTNode } from './ast/types';
import { formatInvalid, formatParseError } from './errors';
import { evaluate } from './eval';
import type { Expr, RuntimeEnv } from './types';

type Compiled<Context extends RuntimeEnv = RuntimeEnv, ReturnType = unknown> = (
  env: Context,
) => ReturnType;

/**
 * LRU Cache for compiled expressions.
 * Prevents unbounded memory growth in long-running applications.
 */
const MAX_CACHE_SIZE = 1000;
const cache = new Map<string, Compiled>();

function cacheSet(key: string, value: Compiled<any, any>): void {
  // If cache is full, evict the oldest entry (first key in Map iteration order)
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) {
      cache.delete(firstKey);
    }
  }
  cache.set(key, value);
}

function cacheGet(key: string): Compiled | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    // Move to end of Map (most recently used) by re-inserting
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function expression(expr: string): Compiled;
function expression<
  Context extends RuntimeEnv = RuntimeEnv,
  ReturnType = unknown,
>(expr: Expr<Context, ReturnType>): Compiled<Context, ReturnType>;
function expression<
  Context extends RuntimeEnv = RuntimeEnv,
  ReturnType = unknown,
>(expr: Expr<Context, ReturnType> | string): Compiled<Context, ReturnType> {
  if (typeof expr === 'function') {
    return expr as Compiled<Context, ReturnType>;
  }

  if (typeof expr !== 'string') {
    throw new Error(formatInvalid());
  }

  const cached = cacheGet(expr);
  if (cached) {
    return cached as Compiled<Context, ReturnType>;
  }

  let ast: ASTNode | null = null;
  try {
    const tokens = tokenize(expr);
    // special case: leading ']'
    if (
      tokens.length > 0 &&
      tokens[0].kind === 'punct' &&
      tokens[0].value === ']'
    ) {
      const fn: Compiled<Context, ReturnType> = () => undefined as ReturnType;
      cacheSet(expr, fn);
      return fn;
    }
    ast = parse(tokens, expr);
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(formatInvalid(expr));
  }

  if (!ast) {
    // grammar error
    throw new Error(formatParseError(expr));
  }

  const fn: Compiled<Context, ReturnType> = (env: Context) =>
    evaluate(ast, env) as ReturnType;
  cacheSet(expr, fn);
  return fn;
}

export default expression;
export { parse, tokenize };
export { rewriteContextExpression, validateContextExpression } from './rewrite';
export type * from './ast/types';
export type { Expr, RuntimeEnv };
