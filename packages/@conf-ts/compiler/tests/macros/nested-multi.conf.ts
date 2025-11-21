import { arrayFilter, arrayMap, Boolean, Number, String } from '@conf-ts/macro';

const nums = [0, 1, 2];

export default {
  multiLevelCast: arrayMap(nums, x => Boolean(Number(String(x)))),
  nestedInArg: arrayMap(
    arrayFilter(nums, y => Boolean(y)),
    z => String(z),
  ),
  deepChain: String(Number(String(Number(5)))),
};
