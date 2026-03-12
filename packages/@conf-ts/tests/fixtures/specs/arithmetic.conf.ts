export const MY_CONSTANT = 10;

export enum MyArithmeticEnum {
  Val1 = 5,
  Val2 = 20,
}

export default {
  sum: 10 + 5,
  difference: 20 - 7,
  product: 4 * 6,
  quotient: 30 / 5,
  remainder: 17 % 3,
  complex: (10 + 2) * 3 - 5 / 1 + (100 % 7),
  constantSum: MY_CONSTANT + 5,
  enumProduct: MyArithmeticEnum.Val1 * MyArithmeticEnum.Val2,
  mixedOperation: MY_CONSTANT + MyArithmeticEnum.Val2 - 3,
};
