import { Boolean, env, expr, Number, String } from '@conf-ts/macro';

const THRESHOLD = 41;
const someConst = { ctx: 41 };

type Context = {
  a: string;
  n: number;
  b: boolean;
  mode: string;
};

export default {
  stringLiteral: expr<Context, string>(ctx => String(1)),
  mixedWithContext: expr<Context, boolean>(ctx => ctx.a === String(1)),
  numberCast: expr<Context, boolean>(ctx => ctx.n === Number('42')),
  booleanCast: expr<Context, boolean>(ctx => ctx.b === Boolean(THRESHOLD)),
  nestedArithmetic: expr<Context, boolean>(
    ctx => ctx.a === String(THRESHOLD + 1),
  ),
  envDefault: expr<Context, boolean>(
    ctx => ctx.mode === env('CONF_TS_EXPR_MACRO_MODE', 'dev'),
  ),
  // An object key or property name that happens to be spelled the same as
  // the context parameter is not itself a reference to it, so these must
  // still fold to a constant instead of being kept as a runtime call.
  objectKeyNamedCtx: expr<Context, number>(ctx => Number({ ctx: 1 }.ctx)),
  propertyNamedCtx: expr<Context, number>(ctx => Number(someConst.ctx)),
};
