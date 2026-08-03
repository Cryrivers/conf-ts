import { modifier } from '@conf-ts/macro';

const double = modifier<[number], number>(value => value * 2);

function dynamic(value: number) {
  return double(value);
}

export default { dynamic };
