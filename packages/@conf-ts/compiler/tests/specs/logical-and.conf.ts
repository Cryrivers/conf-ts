export default {
  trueAndTrue: true && true,
  trueAndFalse: true && false,
  falseAndTrue: false && true,
  falseAndFalse: false && false,
  numberAndString: 1 && 'a',
  zeroAndString: 0 && 'a',
  stringAndNumber: 'a' && 1,
  emptyStringAndNumber: '' && 1,
  nullAndString: null && 'a',
  undefinedAndString: undefined && 'a',
};
