import { expr } from '@conf-ts/macro';

type Context = { queue: number[] };

export default {
  // The nested callback's own parameter reuses the outer context parameter
  // name, which would make `ctx.` prefix-stripping ambiguous.
  rule: expr<Context, boolean>(
    ctx => ctx.queue.filter(ctx => ctx < 5).length > 0,
  ),
};
