const base = { a: 1, b: 2 };
const extended = { ...base, c: 3, d: { e: 5, ...{ f: 6 } } };
const override = { a: 10, b: 'aaa', c: 40, d: 50, e: 60 };
const override2 = { b: 'bbb', c: 41, d: 51, e: 61 };
const obj = { a: 1, b: 2, c: 3 };

export default {
  obj,
  extended,
  override: { ...override, ...override2 },
};
