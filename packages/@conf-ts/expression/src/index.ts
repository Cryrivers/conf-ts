import { formatInvalid } from '@conf-ts/expr-core';
import type { Expr, LooseExpr } from '@conf-ts/macro';

import { compile, ExpressionCompileError } from './compile';
import { evaluate, type EvalOptions } from './eval';
import { parseSource } from './parse';
import type { Compiled, CompileOptions, ExpressionOptions } from './types';

/**
 * LRU cache for interpreter-backed expressions.
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

function expression<Context = unknown, ReturnType = unknown>(
  expr: LooseExpr<Context, ReturnType>,
  options: ExpressionOptions &
    ({ optionalMemberAccess: true } | { loose: true }),
): Compiled<Context, ReturnType>;
function expression<Context = unknown, ReturnType = unknown>(
  expr: Expr<Context, ReturnType>,
  options?: ExpressionOptions,
): Compiled<Context, ReturnType>;
function expression(expr: string, options?: ExpressionOptions): Compiled;
function expression<Context = unknown, ReturnType = unknown>(
  expr: Expr<Context, ReturnType> | string,
  options?: ExpressionOptions,
): Compiled<Context, ReturnType> {
  if (typeof expr !== 'string') {
    throw new Error(formatInvalid());
  }

  const optionalMemberAccess =
    options?.optionalMemberAccess === true || options?.loose === true;
  const evalOptions: EvalOptions | undefined = optionalMemberAccess
    ? { optionalMemberAccess: true }
    : undefined;
  const cacheKey = (optionalMemberAccess ? 'o' : 's') + expr;

  const cached = cacheGet(cacheKey);
  if (cached) {
    return cached as Compiled<Context, ReturnType>;
  }

  const ast = parseSource(expr);
  if (ast === null) {
    const fn: Compiled<Context, ReturnType> = () => undefined as ReturnType;
    cacheSet(cacheKey, fn);
    return fn;
  }

  const fn: Compiled<Context, ReturnType> = (env: Context) =>
    evaluate(ast, env as Record<string, unknown>, evalOptions) as ReturnType;
  cacheSet(cacheKey, fn);
  return fn;
}

export default expression;
export { compile, ExpressionCompileError };
export type { Compiled, CompileOptions, Expr, ExpressionOptions, LooseExpr };
