import { Number, String } from '@conf-ts/macro';

export default {
  toString: String(123),
  toNumber: Number('123'),
  toBoolean: Boolean('true'), // This should fail
};
