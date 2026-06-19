export type RuntimeEnv = Record<string, unknown>;
export type Expr<Context extends RuntimeEnv, ReturnType> = string & { __brand: 'ExpressionString',  __context: Context, __returnType: ReturnType };