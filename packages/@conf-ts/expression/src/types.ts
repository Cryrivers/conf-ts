export type RuntimeEnv = Record<string, unknown>;

export type ExpressionOptions = {
  optionalMemberAccess?: boolean;
};

declare const EXPR_CALLBACK: unique symbol;

export type Expr<Context extends RuntimeEnv, ReturnType> = ((
  ctx: Context,
) => ReturnType) &
  string & {
    readonly [EXPR_CALLBACK]: true;
  };
