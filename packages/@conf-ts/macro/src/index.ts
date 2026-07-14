import type { Expr, RuntimeEnv } from '@conf-ts/expression';

console.warn(
  '@conf-ts/macro has been imported. This package is intended for compile-time macro expansion and should not be directly imported into runtime code.',
);

export type { Expr, LooseExpr, RuntimeEnv } from '@conf-ts/expression';

function macroNotTransformed(name: string): never {
  throw new Error(
    `'${name}' is a compile-time macro from '@conf-ts/macro' and must be expanded by the conf-ts macro transformer; it cannot run at runtime.`,
  );
}

export function expr<
  Context extends RuntimeEnv = RuntimeEnv,
  ReturnType = unknown,
>(_callback: (ctx: Context) => ReturnType): Expr<Context, ReturnType> {
  return macroNotTransformed('expr');
}

export function String(_value: any): string {
  return macroNotTransformed('String');
}

export function Number(_value: any): number {
  return macroNotTransformed('Number');
}

export function Boolean(_value: any): boolean {
  return macroNotTransformed('Boolean');
}

export function arrayMap<T, U>(_array: T[], _callback: (item: T) => U): U[] {
  return macroNotTransformed('arrayMap');
}

export function arrayFlatMap<T, U>(
  _array: T[],
  _callback: (item: T) => U | U[],
): U[] {
  return macroNotTransformed('arrayFlatMap');
}

export function arrayFilter<T>(
  _array: T[],
  _predicate: (item: T) => boolean,
): T[] {
  return macroNotTransformed('arrayFilter');
}

export function env(key: string): string | undefined;
export function env(key: string, defaultValue: string): string;
export function env(_key: string, _defaultValue?: string): string | undefined {
  return macroNotTransformed('env');
}
