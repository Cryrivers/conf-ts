import { expr, String } from '@conf-ts/macro';

export default {
  test: expr<{ a: string; b: string }, boolean>(
    ctx => ctx.a === String(ctx.b + someUndeclaredVar),
  ),
};
