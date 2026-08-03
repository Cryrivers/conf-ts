import { modifier } from '@conf-ts/macro';

const invalid = modifier<[number], number>(value => {
  return value + 1;
});

export default { invalid: invalid(1) };
