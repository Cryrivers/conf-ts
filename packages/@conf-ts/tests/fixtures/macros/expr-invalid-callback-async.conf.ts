import { expr } from '@conf-ts/macro';

type Context = { queue: number[] };

export default {
  rule: expr<Context, boolean>(
    ctx => ctx.queue.filter(async a => a < 5).length > 0,
  ),
};
