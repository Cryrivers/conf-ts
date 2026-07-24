import { expr } from '@conf-ts/macro';

const always = expr(() => true);

export default {
  combined: expr(() => always() && 1 < 2),
};
