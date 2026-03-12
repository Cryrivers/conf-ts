import { arrayFilter } from '@conf-ts/macro';

const nums: number[] = [1, 2, 3];

export default {
  invalidFilter: arrayFilter(nums, function (x: number) {
    return x > 1;
  }),
};
