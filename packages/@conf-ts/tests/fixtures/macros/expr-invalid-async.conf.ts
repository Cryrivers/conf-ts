import { expr } from '@conf-ts/macro';

export default {
  rule: expr(async ctx => ctx.a),
};
