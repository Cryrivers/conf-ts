declare const EXPR_CALLBACK: unique symbol;
declare const EXPR_TEMPLATE: unique symbol;

type IsPlainObject<T> = T extends readonly unknown[]
  ? false
  : T extends (...args: any[]) => any
    ? false
    : T extends object
      ? true
      : false;

// True when a property's raw declared type (before NonNullable) allows
// `undefined` — covering both an optional `?:` modifier and an explicit
// `X | undefined` union.
type IncludesUndefined<T> = undefined extends T ? true : false;

// Recursively presents a deeply-required navigation shape for an expr
// callback's context, and from object properties nested inside array
// elements, so the callback can access them without `?.` at any container
// level (e.g. `ctx.a[0].b.c`). Container types (plain objects, arrays) are
// never unioned with `undefined` themselves — doing so would force `?.`
// back onto navigation and defeat the point of LooseExpr. Instead, `Loosened`
// tracks whether the path leading here already crossed an optional level,
// and only the leaf value ultimately read at the end of such a path is
// unioned with `undefined` — matching what optionalMemberAccess/loose
// actually returns at runtime when an intermediate is missing. Function
// types count as leaves (not recursed into); tuple element positions aren't
// preserved since indexed access can't recover which tuple slot was read.
type LooseContext<
  T,
  Loosened extends boolean = false,
> = T extends readonly (infer Element)[]
  ? LooseContext<Element, Loosened>[]
  : IsPlainObject<T> extends true
    ? {
        -readonly [K in keyof T]-?: LooseContext<
          NonNullable<T[K]>,
          Loosened extends true ? true : IncludesUndefined<T[K]>
        >;
      }
    : Loosened extends true
      ? T | undefined
      : T;

export type Expr<Context, ReturnType> = ((ctx: Context) => ReturnType) &
  string & {
    readonly [EXPR_CALLBACK]: true;
  };

// Presents a deeply-required view of Context to the expr(...) callback for
// type-checking only; the compiled output is identical to Expr and must be
// evaluated with optionalMemberAccess/loose: true for the loosened types to
// match runtime behavior.
export type LooseExpr<Context, ReturnType> = Expr<
  LooseContext<Context>,
  ReturnType
>;

export type ExprTemplateCallback<
  Context,
  ReturnType,
  Parameters extends readonly unknown[],
> = (ctx: Context, ...args: Parameters) => ReturnType;

export type ExprTemplate<
  Context,
  ReturnType,
  Parameters extends readonly unknown[],
> = ((...args: Parameters) => Expr<Context, ReturnType>) & {
  readonly [EXPR_TEMPLATE]: true;
};

export type LooseExprTemplate<
  Context,
  ReturnType,
  Parameters extends readonly unknown[],
> = ((...args: Parameters) => LooseExpr<Context, ReturnType>) & {
  readonly [EXPR_TEMPLATE]: true;
};
