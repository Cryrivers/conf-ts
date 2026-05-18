import { arrayFlatMap } from '@conf-ts/macro';

const nums = [1, 2, 3];

export default {
  invalidFlatMap: arrayFlatMap(nums, function (x) {
    return [x];
  }),
};
