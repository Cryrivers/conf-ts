import { modifier } from '@conf-ts/macro';

const invalid = modifier<[number], Promise<number>>(
  async value => value + 1,
);

export default { invalid: invalid(1) };
