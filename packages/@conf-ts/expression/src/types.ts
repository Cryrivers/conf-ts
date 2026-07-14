export type RuntimeEnv = Record<string, unknown>;

export type ExpressionOptions = {
  optionalMemberAccess?: boolean;
  /** Alias for `optionalMemberAccess`. */
  loose?: boolean;
};

declare const EXPR_CALLBACK: unique symbol;

export type Expr<Context extends RuntimeEnv, ReturnType> = ((
  ctx: Context,
) => ReturnType) &
  string & {
    readonly [EXPR_CALLBACK]: true;
  };

type IsPlainObject<T> = T extends readonly unknown[]
  ? false
  : T extends (...args: any[]) => any
    ? false
    : T extends object
      ? true
      : false;

// Recursively strips optionality from nested plain-object properties, and
// from object properties nested inside array elements, so an expr callback
// can access them without `?.` (e.g. `ctx.a[0].b.c`). Function types are left
// untouched (not loosened); tuple element positions aren't preserved since
// indexed access can't recover which tuple slot was read anyway.
type LooseContext<T> = T extends readonly (infer Element)[]
  ? LooseContext<Element>[]
  : IsPlainObject<T> extends true
    ? { -readonly [K in keyof T]-?: LooseContext<NonNullable<T[K]>> }
    : T;

// Presents a deeply-required view of Context to the expr(...) callback for
// type-checking only; the compiled output is identical to Expr and must be
// evaluated with optionalMemberAccess/loose: true for the loosened types to
// match runtime behavior.
export type LooseExpr<Context extends RuntimeEnv, ReturnType> = Expr<
  LooseContext<Context>,
  ReturnType
>;
