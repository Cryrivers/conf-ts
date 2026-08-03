import { modifier } from '@conf-ts/macro';

const add = modifier<[number, number?], number>(
  (value, offset?: number) => value + (offset ?? 0),
);

export default { invalid: add() };
