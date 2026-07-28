import { exprTemplate } from '@conf-ts/macro';

type Context = {
  expressionA: number;
  expressionB: number;
};

const optional = exprTemplate<Context, number, [number, number?]>(
  (ctx, constA, constB?: number) =>
    typeof constB === 'undefined'
      ? ctx.expressionA + constA
      : ctx.expressionB + constB,
);

export default {
  optionalMissing: optional(2),
  optionalPresent: optional(2, 5),
};
