import { expr, String } from '@conf-ts/macro';

export default {
  test: expr<{ a: string }, string>(ctx => String(ctx.a, 'extra')),
};
