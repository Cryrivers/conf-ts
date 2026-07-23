import { exprTemplate } from '@conf-ts/macro';

const add = exprTemplate<{ value: number }, number, [number]>(
  (ctx, amount) => ctx.value + amount,
);

export default { invalid: [add] };
