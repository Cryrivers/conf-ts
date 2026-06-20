import { expr } from '@conf-ts/macro';

export default {
  rule: expr<{ a: number }, number>(ctx => ctx.a ** 2),
};
