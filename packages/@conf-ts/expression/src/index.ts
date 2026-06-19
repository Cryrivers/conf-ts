import { formatInvalid, formatParseError } from './errors';
import { evaluate } from './eval';
import { tokenize } from './lexer';
import { parse } from './parser';
import type { ASTNode, Env as RuntimeEnv } from './types';

type Compiled = (env: RuntimeEnv) => unknown;

/**
 * LRU Cache for compiled expressions.
 * Prevents unbounded memory growth in long-running applications.
 */
const MAX_CACHE_SIZE = 1000;
const cache = new Map<string, Compiled>();

function cacheSet(key: string, value: Compiled): void {
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

const expression = (expr?: string): Compiled => {
  const cacheKey = expr ?? '';
  const cached = cacheGet(cacheKey);
  if (cached) {
    return cached;
  }

  // special case: undefined input
  if (!expr && expr !== '') {
    throw new Error(formatInvalid());
  }

  let ast: ASTNode | null = null;
  try {
    const tokens = tokenize(expr);
    // special case: leading ']'
    if (tokens.length > 0 && tokens[0].kind === 'punct' && tokens[0].value === ']') {
      const fn: Compiled = () => undefined;
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

  const fn: Compiled = (env: RuntimeEnv) => evaluate(ast, env ?? {});
  cacheSet(expr, fn);
  return fn;
};

export default expression;
