import { modifier } from '@conf-ts/macro';

const add = modifier<[number], number>(value => value + 1);

export default { invalid: add(1, 2) };
