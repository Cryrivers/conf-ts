const base = { a: 1, b: 2 };
const extended = { ...base, c: 3, d: { e: 5, ...{ f: 6 } } };

const arr1 = [1, 2];
const arr2 = [...arr1, 3, 4, ...[7, 8]];

const nestedObject = { x: 10, y: { z: 11, ...{ w: 12 } } };
const combined = { ...extended, ...nestedObject, arr: [...arr2, 9] };

const override = { a: 10, b: 20, c: 30 };
const override2 = { b: 'aaa', c: 40, d: 50, e: 60 };

const original = { a: 1, b: 2, c: 3, d: { e: 4, f: 5 } };
const { a, b, ...rest } = original;

export default {
  extended,
  arr2,
  combined,
  override: { ...override, ...override2 },
  spreaded: { rest, g: 100 },
};
