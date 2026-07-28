import { expr, exprTemplate } from '@conf-ts/macro';

type Context = {
  expressionA: number;
  expressionB: number;
  enabled: boolean;
};

const optional = exprTemplate<Context, number, [number, number?]>(
  (ctx, constA, constB?: number) =>
    typeof constB === 'undefined'
      ? ctx.expressionA + constA
      : ctx.expressionB + constB,
);
const comparison = exprTemplate<Context, number, [number, boolean]>(
  (ctx, amount, enabled) =>
    amount >= 2 && enabled !== false ? ctx.expressionA : ctx.expressionB,
);
const unary = exprTemplate<Context, number, [boolean]>((ctx, enabled) =>
  !enabled ? ctx.expressionA : ctx.expressionB,
);
const formattedTruthiness = exprTemplate<Context, number, [number]>(
  (ctx, value) => (value ? ctx.expressionA : ctx.expressionB),
);
const formattedOperators = exprTemplate<Context, number, [number]>(
  (ctx, value) =>
    typeof value === 'number' && value === 1
      ? ctx.expressionA
      : ctx.expressionB,
);
const formattedUnary = exprTemplate<Context, number, [number]>((ctx, value) =>
  !value ? ctx.expressionA : ctx.expressionB,
);
const nullish = exprTemplate<
  Context,
  number,
  [string | null | undefined, string]
>((ctx, mode, fallback) =>
  (mode ?? fallback) === 'a' ? ctx.expressionA : ctx.expressionB,
);
const nested = exprTemplate<Context, number, [number, boolean]>(
  (ctx, amount, enabled) =>
    amount === 1
      ? enabled
        ? ctx.expressionA
        : ctx.expressionB
      : ctx.expressionA + amount,
);
const arithmetic = exprTemplate<Context, number, [number, boolean]>(
  (ctx, amount, enabled) =>
    enabled ? ctx.expressionA + (amount + 1) : ctx.expressionB,
);
const defaulted = exprTemplate<Context, number, [string?]>((ctx, mode = 'a') =>
  mode === 'a' ? ctx.expressionA : ctx.expressionB,
);
const unsupportedStatic = exprTemplate<Context, number, [number[], number]>(
  (ctx, allowed, value) =>
    typeof (allowed.includes(value)) === 'boolean'
      ? ctx.expressionA
      : ctx.expressionB,
);
const dynamic = exprTemplate<Context, number, [number]>((ctx, amount) =>
  ctx.enabled ? ctx.expressionA + amount : ctx.expressionB + amount,
);
const NON_FINITE = 1 / 0;
const deadBranch = exprTemplate<Context, number, [boolean]>((ctx, enabled) =>
  enabled ? ctx.expressionA : NON_FINITE,
);

export default {
  optionalMissing: optional(2),
  optionalPresent: optional(2, 5),
  comparisonTrue: comparison(3, true),
  comparisonFalse: comparison(1, true),
  unary: unary(false),
  formattedFalsy: formattedTruthiness(0.0),
  formattedOperators: formattedOperators(1.0),
  formattedUnary: formattedUnary(0.0),
  nullish: nullish(undefined, 'a'),
  nested: nested(1, false),
  arithmetic: arithmetic(2, true),
  defaulted: defaulted(),
  defaultedExplicitUndefined: defaulted(undefined),
  unsupportedStatic: unsupportedStatic([1, 2], 2),
  dynamic: dynamic(4),
  deadBranch: deadBranch(true),
  ordinaryExpr: expr<Context, number>(ctx =>
    true ? ctx.expressionA : ctx.expressionB,
  ),
};
