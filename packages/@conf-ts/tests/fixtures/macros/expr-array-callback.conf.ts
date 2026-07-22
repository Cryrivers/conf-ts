import { expr } from '@conf-ts/macro';

const MIN_SCORE = 3;

type Context = {
  quota: number;
  queue: number[];
  scores: number[];
  threshold: number;
  matrix: number[][];
};

export default {
  // Arrow function with an expression body: it only ever needs its own
  // parameter and the context, so it passes through almost unchanged.
  arrowExpressionBody: expr<Context, boolean>(
    ctx =>
      [1, 2].includes(ctx.quota) && ctx.queue.filter(i => i < 5).length > 5,
  ),

  // `function` expression callback, down-leveled into arrow syntax.
  functionExpressionBody: expr<Context, boolean>(
    ctx =>
      ctx.queue.filter(function (a) {
        return a < 5;
      }).length > 5,
  ),

  // Block-bodied arrow callback: same down-leveling as a `function`
  // expression, and still reaches into the outer context.
  blockBodiedArrow: expr<Context, boolean>(
    ctx =>
      ctx.queue.filter(a => {
        return a >= ctx.threshold;
      }).length > 0,
  ),

  // Multiple callback parameters.
  reduceSum: expr<Context, number>(
    ctx => ctx.scores.reduce((sum, value) => sum + value, 0),
  ),

  // Zero-parameter callback that still reaches into the outer context.
  someAboveZero: expr<Context, boolean>(
    ctx => ctx.queue.some(() => ctx.quota > 0),
  ),

  // Callback referencing an outer compile-time constant alongside its own
  // parameter.
  anyAboveMinScore: expr<Context, boolean>(
    ctx => ctx.scores.some(value => value > MIN_SCORE),
  ),

  // Chained callbacks on the same expression.
  chainedFilterMap: expr<Context, number[]>(
    ctx => ctx.queue.filter(i => i > 0).map(i => i * 2),
  ),

  // Nested callback referencing the outer context parameter.
  filterAboveThreshold: expr<Context, number>(
    ctx => ctx.queue.filter(i => i > ctx.threshold).length,
  ),

  // Two levels of nested callbacks.
  countPositiveRows: expr<Context, number>(
    ctx => ctx.matrix.filter(row => row.some(cell => cell > 0)).length,
  ),

  // Three levels of nested callbacks (arrow -> `function` expression ->
  // arrow), where the innermost callback cross-references names bound at
  // every enclosing level: `c` from its immediate parent, `r` from its
  // grandparent, and `ctx` from the outermost expr callback itself.
  complexCombination: expr<Context, boolean>(
    ctx =>
      ctx.matrix.filter(r =>
        r.some(function (c) {
          return r.some(p => p > c && p < ctx.threshold);
        }),
      ).length > 0,
  ),
};
