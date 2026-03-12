import { arrayMap } from '@conf-ts/macro';

const nums = [1, 2, 3];

export default {
  invalidMap: arrayMap(nums, function (x) {
    return x * 2;
  }),
};
