import { expr } from '@conf-ts/macro';

const MIN_SCORE = 3;

type Context = {
  pairs: Array<{ a: number; b: number }>;
  matrix: number[][];
  queue: number[];
  threshold: number;
};

export default {
  // Object destructuring (shorthand properties).
  objectDestructure: expr<Context, boolean>(
    ctx => ctx.pairs.some(({ a, b }) => a < b),
  ),

  // Array destructuring, including a hole.
  arrayDestructureWithHole: expr<Context, number[]>(
    ctx => ctx.matrix.map(([, b]) => b),
  ),

  // Destructured property with its own default value.
  destructureWithDefault: expr<Context, boolean>(
    ctx => ctx.pairs.some(({ a, b = MIN_SCORE }) => a < b),
  ),

  // Rest parameter.
  restParam: expr<Context, number>(
    ctx => ctx.queue.reduce((sum, ...rest) => sum + rest.length, 0),
  ),

  // Plain parameter default value, combined with the outer context.
  defaultParam: expr<Context, boolean>(
    ctx => ctx.queue.some((v = MIN_SCORE) => v > ctx.threshold),
  ),

  // `function` expression with a destructured parameter, down-leveled into
  // arrow syntax, still reaching into the outer context.
  functionExprDestructure: expr<Context, boolean>(
    ctx =>
      ctx.pairs.some(function ({ a, b }) {
        return a < b && b < ctx.threshold;
      }),
  ),

  // Combines destructuring, a default value expression that itself
  // references the outer context, and an outer constant all in one callback.
  combinedPatterns: expr<Context, boolean>(
    ctx => ctx.pairs.some(({ a, b = ctx.threshold }) => a + MIN_SCORE < b),
  ),
};
