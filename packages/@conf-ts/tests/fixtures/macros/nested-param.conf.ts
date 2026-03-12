import { arrayMap, String } from '@conf-ts/macro';

const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

export default {
  idStrings: arrayMap(items, item => String(item.id)),
};
