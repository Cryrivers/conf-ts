import { Boolean, Number, String } from '@conf-ts/macro';

const MY_CONSTANT = 456;

enum MyEnum {
  A = 1,
  B,
  C = '1005',
}

export default {
  toString: String(123),
  toNumber: Number('123'),
  toBoolean: Boolean('true'),
  // Casting constants
  constantToString: String(MY_CONSTANT),
  constantToBoolean: Boolean(MY_CONSTANT),
  // Casting enums
  enumToString: String(MyEnum.A),
  enumToBoolean: Boolean(MyEnum.B),
  enumToNumber: Number(MyEnum.C),
};
