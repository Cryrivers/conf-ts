import { Number } from '@conf-ts/macro';

export default {
  value: Number(true ? 1 : 0),
  nested: {
    value: Number(false ? 10 : 20),
  },
  stringTernary: true ? 'hello' : 'world',
  booleanTernary: false ? true : false,
  nullTernary: true ? null : undefined,
};
