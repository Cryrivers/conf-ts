const arr = [10, 20, 30];
const obj = { name: 'alice', age: 30 };
const KEY = 'name';
const matrix = [
  [1, 2],
  [3, 4],
];
const idx = 1;

export default {
  first: arr[0],
  last: arr[2],
  indexed: arr[idx],
  computed: arr[1 + 1],
  byKey: obj['name'],
  byComputedKey: obj[KEY],
  nested: matrix[1][0],
  outOfRangeFallback: arr[5] ?? 'none',
};
