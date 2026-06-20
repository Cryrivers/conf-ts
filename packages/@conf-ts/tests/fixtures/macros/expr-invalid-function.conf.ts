import { expr } from '@conf-ts/macro';

export default {
  rule: expr(function (ctx) {
    return ctx.a;
  }),
};
