const arr = [10, 20, 30, 40];
const [first, second, ...rest] = arr;
const [, secondOnly, third] = arr;
const pair = ['a', 'b'];
const [left, right] = pair;

export default {
  first,
  second,
  rest,
  secondOnly,
  third,
  left,
  right,
};
