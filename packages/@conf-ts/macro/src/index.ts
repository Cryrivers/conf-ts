import {
  rewriteContextExpression,
  type Expr,
  type RuntimeEnv,
} from '@conf-ts/expression';

console.warn(
  '@conf-ts/macro has been imported. This package is intended for compile-time macro expansion and should not be directly imported into runtime code.',
);

export { createElement, type JsxOutputOptions } from './jsx-runtime';
export type { Expr, RuntimeEnv } from '@conf-ts/expression';

const EXPR_CALLBACK_ERROR =
  'expr callback must be an arrow function with a single identifier parameter and expression body';

type ParsedCallback = {
  paramName: string;
  body: string;
};

function parseCallback(callback: Function): ParsedCallback {
  const source = callback.toString().trim();
  const arrowIndex = source.indexOf('=>');
  if (arrowIndex === -1) {
    throw new Error(EXPR_CALLBACK_ERROR);
  }

  if (/^async\b\s*(?:\(|[A-Za-z_$])/.test(source)) {
    throw new Error(EXPR_CALLBACK_ERROR);
  }

  const params = source.slice(0, arrowIndex).trim();
  const body = source.slice(arrowIndex + 2).trim();
  if (!body || body.startsWith('{')) {
    throw new Error(EXPR_CALLBACK_ERROR);
  }

  const parenthesized = params.match(/^\(\s*([A-Za-z_$][0-9A-Za-z_$]*)\s*\)$/);
  if (parenthesized) {
    return { paramName: parenthesized[1], body };
  }

  const bare = params.match(/^([A-Za-z_$][0-9A-Za-z_$]*)$/);
  if (bare) {
    return { paramName: bare[1], body };
  }

  throw new Error(EXPR_CALLBACK_ERROR);
}

export function expr<
  Context extends RuntimeEnv = RuntimeEnv,
  ReturnType = unknown,
>(callback: (ctx: Context) => ReturnType): Expr<Context, ReturnType> {
  const { paramName, body } = parseCallback(callback);
  return rewriteContextExpression(body, paramName) as Expr<Context, ReturnType>;
}

export function String(value: any): string {
  return globalThis.String(value);
}

export function Number(value: any): number {
  return globalThis.Number(value);
}

export function Boolean(value: any): boolean {
  return globalThis.Boolean(value);
}

export function arrayMap<T, U>(array: T[], callback: (item: T) => U): U[] {
  return array.map(callback);
}

export function arrayFlatMap<T, U>(
  array: T[],
  callback: (item: T) => U | U[],
): U[] {
  return array.flatMap(callback);
}

export function arrayFilter<T>(
  array: T[],
  predicate: (item: T) => boolean,
): T[] {
  return array.filter(predicate);
}

export function env(key: string): string | undefined;
export function env(key: string, defaultValue: string): string;
export function env(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}
