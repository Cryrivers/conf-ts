export type RuntimeEnv = Record<string, unknown>;

export type QuoteStyle = 'single' | 'double';

export type RewriteContextOptions = {
  quote?: QuoteStyle;
};

export type ExpressionOptions = {
  optionalMemberAccess?: boolean;
};

declare const EXPR_CALLBACK: unique symbol;

export type Expr<Context extends RuntimeEnv, ReturnType> = ((
  ctx: Context,
) => ReturnType) & {
  readonly [EXPR_CALLBACK]: true;
};
