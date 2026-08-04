import { expr, modifier } from '@conf-ts/macro';

type Context = { child: Context; value: boolean };
type Rule = (ctx: Context) => boolean;

const reuse = modifier<[{ expression: Rule }], Rule>(input =>
  expr<Context, boolean>(ctx => input.expression(ctx.child)),
);

export default reuse({
  expression: expr<Context, boolean>(ctx => ctx.value),
});
