const KEY = 'dynamic';
const source = {
  nested: { value: 10 },
  dynamic: 20,
  keep: 'yes',
  remove: 'no',
};
const {
  nested: { value },
  missing = 30,
  [KEY]: computed,
  remove,
  ...rest
} = source;
const arr = [1, [2, 3], undefined];
const [first, [second, third], fallback = 4, ...tail] = arr;

export default {
  value,
  missing,
  computed,
  rest,
  first,
  second,
  third,
  fallback,
  tail,
};
