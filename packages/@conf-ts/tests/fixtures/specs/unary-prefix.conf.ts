export const MY_NUMBER = 42;
export const MY_BOOLEAN = true;
export const MY_FALSE = false;

export default {
  // Unary plus
  positiveNumber: +10,
  positiveString: +'5',
  positiveConstant: +MY_NUMBER,

  // Unary minus
  negativeNumber: -10,
  negativeString: -'5',
  negativeConstant: -MY_NUMBER,
  negativeComplex: -(10 + 5),

  // Logical NOT
  notTrue: !true,
  notFalse: !false,
  notNumber: !42,
  notZero: !0,
  notString: !'hello',
  notEmptyString: !'',
  notConstant: !MY_BOOLEAN,
  notComplexExpression: !(10 + 5),

  // Bitwise NOT
  bitwiseNotZero: ~0,
  bitwiseNotNumber: ~42,
  bitwiseNotNegative: ~-1,
  bitwiseNotConstant: ~MY_NUMBER,

  // Complex nested expressions
  complexNested: -(!true + ~0),
  chainedUnary: !!true,
  mixedWithBinary: -10 + +5,
  parenthesizedUnary: -(10 + 5) * 2,
};
