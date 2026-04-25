const obj = { a: 1, b: undefined };
const arr = [, 1, undefined];
const methodObj = {
  a: 1,
  b() {
    return 2;
  },
};

export default {
  fallback: obj.missing ?? 2,
  directMissing: obj.missing,
  array: arr,
  holeIsUndefined: arr[0] === undefined,
  explicitUndefinedIsUndefined: arr[2] === undefined,
  sequence: (obj.a, 3),
  methodObj,
};
