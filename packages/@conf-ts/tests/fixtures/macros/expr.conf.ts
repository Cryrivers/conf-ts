import { expr, looseExpr } from '@conf-ts/macro';

type LooseContext = { user?: { age?: number } };

const hasAge = looseExpr<LooseContext, number | boolean>(
  ctx => ctx.user.age || true,
);

export default {
  simple: expr<{ a: number; b: number }, boolean>(ctx => ctx.a > ctx.b),
  nested: expr<{ user: { age: number }; limit: number }, boolean>(
    ctx => ctx.user.age >= ctx.limit,
  ),
  computed: expr<{ a: number }, number>(ctx => ctx['a']),
  loose: hasAge,
  looseComposed: looseExpr<LooseContext, boolean>(ctx => hasAge(ctx) === true),
};
