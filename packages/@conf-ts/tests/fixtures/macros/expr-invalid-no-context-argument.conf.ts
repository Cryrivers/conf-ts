import { expr } from '@conf-ts/macro';

const always = expr(() => true);

export default {
  // The enclosing expr callback takes no context parameter, so a nested
  // Expr composed into it can't be called with an argument either.
  rule: expr(() => always(1)),
};
