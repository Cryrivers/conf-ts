import { formatInvalid, type Expr, type LooseExpr } from '@conf-ts/expr-core';

import { ExpressionCache, isOptionalMemberAccess } from './cache';
import { compile, ExpressionCompileError } from './compile';
import { interpret } from './eval';
import { parseSource } from './parse';
import type { Compiled, CompileOptions, ExpressionOptions } from './types';

// Interpreter-backed functions; bounded so that long-running applications
// don't grow without limit.
const cache = new ExpressionCache();

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
  const optionalMemberAccess = isOptionalMemberAccess(options);
  const modeCache = cache.for(optionalMemberAccess);
  let fn = modeCache.get(expr);
  if (!fn) {
    const ast = parseSource(expr);
    fn = ast === null ? () => undefined : interpret(ast, optionalMemberAccess);
    modeCache.set(expr, fn);
  }
  return fn as Compiled<Context, ReturnType>;
}

export default expression;
export { compile, ExpressionCompileError };
export type { Compiled, CompileOptions, Expr, ExpressionOptions, LooseExpr };
