import { modifier } from '@conf-ts/macro';

const invalid = modifier<[{ nested: { value: number } }], number>(
  ({ nested: { value } }) => value,
);

export default { invalid: invalid({ nested: { value: 1 } }) };
