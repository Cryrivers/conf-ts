export default {
  trueOrTrue: true || true,
  trueOrFalse: true || false,
  falseOrTrue: false || true,
  falseOrFalse: false || false,
  numberOrString: 1 || 'a',
  zeroOrString: 0 || 'a',
  stringOrNumber: 'a' || 1,
  emptyStringOrNumber: '' || 1,
  nullOrString: null || 'a',
  undefinedOrString: undefined || 'a',
};
