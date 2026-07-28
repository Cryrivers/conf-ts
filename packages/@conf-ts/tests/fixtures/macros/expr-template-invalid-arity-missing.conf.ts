import { exprTemplate } from '@conf-ts/macro';

const add = exprTemplate<{ value: number }, number, [number, number?]>(
  (ctx, amount, offset?: number) => ctx.value + amount + (offset ?? 0),
);

export default { invalid: add() };
