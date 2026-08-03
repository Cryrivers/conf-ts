import { modifier } from '@conf-ts/macro';

const add = modifier<[number], number>(value => value + 1);
let addAlias = add;

export default { invalid: addAlias(1) };
