import { expr } from '@conf-ts/macro';

type Context = {
  a: boolean;
  b: boolean;
  c: boolean;
  name: string;
  score: number;
};

const bOrC = expr<Context, boolean>(ctx => ctx.b || ctx.c);
const bOrCAlias = bOrC;
const scored = expr<Context, boolean>(
  ctx => (ctx.score > 10 ? ctx.a : ctx.c) && bOrCAlias(ctx),
);

export default {
  single: expr<Context, boolean>(ctx => ctx.a && bOrC(ctx)),
  alias: expr<Context, boolean>(value => bOrCAlias(value) && value.a),
  multiLevel: expr<Context, boolean>(ctx => scored(ctx) || ctx.a),
  stringLiteral: expr<Context, boolean>(
    ctx => ctx.name === 'ready' && bOrC(ctx),
  ),
};
