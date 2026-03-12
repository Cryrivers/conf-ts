import { arrayFilter } from '@conf-ts/macro';

const nums: number[] = [1, 2, 3];
const objects: { id: number; name: string }[] = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 3, name: 'Charlie' },
  { id: 4, name: 'David' },
  { id: 5, name: 'Eve' },
];

export default {
  filterGreaterThanOne: arrayFilter(nums, (x: number) => x > 1),
  filterCharlie: arrayFilter(
    objects,
    (obj: { id: number; name: string }) => obj.name === 'Charlie',
  ),
};
