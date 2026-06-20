import { expr } from '@conf-ts/macro';

export default {
  rule: expr<{ a: number }, { a: number }>(ctx => ctx),
};
