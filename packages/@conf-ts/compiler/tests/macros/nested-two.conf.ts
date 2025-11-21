import { arrayMap, Number, String } from '@conf-ts/macro';

const nums = [1, 2, 3];

export default {
  roundTrip: arrayMap(nums, x => Number(String(x))),
  castChain: Number(String(42)),
};
