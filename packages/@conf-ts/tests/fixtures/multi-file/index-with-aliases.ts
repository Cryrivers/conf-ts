import { MY_CONSTANT } from '@/constants';
import { MultiFileEnum } from '@/enums';

export default {
  aliasedValue: MY_CONSTANT + MultiFileEnum.Value,
  regularValue: 'also works',
};
