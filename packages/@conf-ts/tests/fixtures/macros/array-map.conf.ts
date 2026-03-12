import { arrayMap } from '@conf-ts/macro';

const nums = [1, 2, 3];
const objects = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 3, name: 'Charlie' },
  { id: 4, name: 'David' },
  { id: 5, name: 'Eve' },
];

export default {
  mapDouble: arrayMap(nums, x => (x > 1 ? x * 2 : x)),
  mapToString: arrayMap(nums, x => (x > 1 ? `${x}` : 'one')),
  mapNames: arrayMap(objects, obj => obj.name),
  alternateObjects: arrayMap(objects, obj => ({
    ...obj,
    ...(obj.name === 'Charlie' ? { isAdmin: true } : {}),
  })),
};
