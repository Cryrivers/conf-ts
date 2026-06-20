import { expr } from '@conf-ts/macro';

enum Status {
  Active = 1,
  Inactive = 0,
}

enum Color {
  Red = 'red',
  Blue = 'blue',
}

const THRESHOLD = 100;
const LABEL = 'hello';
const ENABLED = true;
const MIN = 0;
const MAX = 100;
const key = 'a';

export default {
  numericEnum: expr(ctx => ctx.status === Status.Active),
  stringEnum: expr(ctx => ctx.color === Color.Red),
  constNumber: expr(ctx => ctx.value > THRESHOLD),
  constString: expr(ctx => ctx.name === LABEL),
  constBool: expr(ctx => ctx.active === ENABLED),
  mixed: expr(ctx => ctx.value >= MIN && ctx.value <= MAX),
  computedKey: expr<{ a: number }, number>(ctx => ctx[key]),
};
