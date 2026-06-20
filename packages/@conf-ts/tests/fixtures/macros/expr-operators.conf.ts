import { expr } from '@conf-ts/macro';

type Context = {
  base: number;
  exponent: number;
  left: number;
  right: number;
  value: object;
  Constructor: abstract new (...args: any[]) => object;
  key: string;
  object: { removable?: number };
};

export default {
  exponential: expr<Context, number>(ctx => ctx.base ** ctx.exponent),
  bitwiseAnd: expr<Context, number>(ctx => ctx.left & ctx.right),
  bitwiseOr: expr<Context, number>(ctx => ctx.left | ctx.right),
  bitwiseXor: expr<Context, number>(ctx => ctx.left ^ ctx.right),
  shiftLeft: expr<Context, number>(ctx => ctx.left << ctx.right),
  shiftRight: expr<Context, number>(ctx => ctx.left >> ctx.right),
  shiftRightZeroFill: expr<Context, number>(ctx => ctx.left >>> ctx.right),
  instanceOf: expr<Context, boolean>(
    ctx => ctx.value instanceof ctx.Constructor,
  ),
  in: expr<Context, boolean>(ctx => ctx.key in ctx.object),
  bitwiseNot: expr<Context, number>(ctx => ~ctx.left),
  void: expr<Context, undefined>(ctx => void ctx.value),
  delete: expr<Context, boolean>(ctx => delete ctx.object.removable),
  typeof: expr<Context, string>(ctx => typeof ctx.value),
};
