import { exprTemplate } from '@conf-ts/macro';

type Context = { value: number };

const defaultTemplate = exprTemplate<Context, number, [number]>(
  (ctx, amount) => ctx.value + amount,
);

export const multiplied = exprTemplate<Context, number, [number]>(
  (ctx, factor) => ctx.value * factor,
);

export default defaultTemplate;
