import type { Expr, LooseExpr } from '@conf-ts/expr-core';

export type { Expr, LooseExpr };

declare const EXPR_TEMPLATE: unique symbol;
declare const MODIFIER: unique symbol;

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

export type ModifierCallback<Parameters extends readonly unknown[], Output> = (
  ...args: Parameters
) => Output;

export type Modifier<Parameters extends readonly unknown[], Output> = ((
  ...args: Parameters
) => Output) & {
  readonly [MODIFIER]: true;
};
