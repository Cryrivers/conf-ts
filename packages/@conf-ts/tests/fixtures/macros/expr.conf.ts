import { expr } from '@conf-ts/macro';

export default {
  simple: expr<{ a: number; b: number }, boolean>(ctx => ctx.a > ctx.b),
  nested: expr<{ user: { age: number }; limit: number }, boolean>(
    ctx => ctx.user.age >= ctx.limit,
  ),
  computed: expr<{ a: number }, number>(ctx => ctx['a']),
};
