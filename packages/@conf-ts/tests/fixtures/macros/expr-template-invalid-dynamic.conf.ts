import { exprTemplate } from '@conf-ts/macro';

const add = exprTemplate<{ value: number }, number, [number]>(
  (ctx, amount) => ctx.value + amount,
);

function dynamic(value: number) {
  return add(value);
}

export default { dynamic };
