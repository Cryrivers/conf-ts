export default {
  nullCoalescing: null ?? 'default',
  undefinedCoalescing: undefined ?? 'default',
  stringCoalescing: 'value' ?? 'default',
  numberCoalescing: 0 ?? 'default',
  falseCoalescing: false ?? 'default',
  emptyStringCoalescing: '' ?? 'default',
};
