import { HELPER_CONSTANT, HELPER_NUMBER } from '@utils/helper';

import { MY_CONSTANT } from '@/constants';
import { MultiFileEnum } from '@/enums';

export default {
  value1: MY_CONSTANT + MultiFileEnum.Value,
  value2: HELPER_CONSTANT + ' ' + HELPER_NUMBER,
  nested: {
    enumValue: MultiFileEnum.Value,
    constant: MY_CONSTANT,
    helper: HELPER_CONSTANT,
    number: HELPER_NUMBER,
  },
};
