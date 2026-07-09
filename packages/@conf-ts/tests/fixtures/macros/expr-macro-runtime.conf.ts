import { Boolean, expr, Number, String } from '@conf-ts/macro';

const THRESHOLD = 41;

type Context = {
  a: string;
  n: number;
};

export default {
  runtimeString: expr<Context, boolean>(ctx => ctx.a === String(ctx.n)),
  mixedFold: expr<Context, number>(ctx => Number(ctx.n + THRESHOLD)),
  nestedRuntime: expr<Context, boolean>(ctx => Boolean(Number(ctx.a))),
};
