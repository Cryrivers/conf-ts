import { arrayFlatMap, String } from '@conf-ts/macro';

const nums = [1, 2, 3];
const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
];

export default {
  duplicateNumbers: arrayFlatMap(nums, n => [n, n * 10]),
  objectRows: arrayFlatMap(users, user => [
    { id: user.id, label: `${user.name}:primary` },
    { id: user.id, label: `${user.name}:secondary` },
  ]),
  mixedResults: arrayFlatMap(nums, n => (n > 2 ? n : [n, n + 100])),
  nestedStringIds: arrayFlatMap(users, user => [String(user.id)]),
  nonArrayInput: arrayFlatMap(String(123), x => [x]),
};
