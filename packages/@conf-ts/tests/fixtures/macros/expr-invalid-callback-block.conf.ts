import { expr } from '@conf-ts/macro';

type Context = { queue: number[] };

export default {
  // A block body with more than one statement can't be down-leveled into a
  // single expr-DSL expression.
  rule: expr<Context, boolean>(
    ctx =>
      ctx.queue.filter(a => {
        const doubled = a * 2;
        return doubled < 5;
      }).length > 0,
  ),
};
