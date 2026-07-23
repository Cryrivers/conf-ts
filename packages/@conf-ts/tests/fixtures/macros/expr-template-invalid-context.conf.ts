import { exprTemplate } from '@conf-ts/macro';

const invalid = exprTemplate<{ value: number }, number, [number]>(
  ({ value }, amount) => value + amount,
);

export default { invalid: invalid(1) };
