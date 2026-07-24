import { expr } from '@conf-ts/macro';

export default {
  literal: expr(() => true),
  computed: expr(() => 1 + 2),
};
