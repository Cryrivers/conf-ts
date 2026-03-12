import { env } from '@conf-ts/macro';

export default {
  foo: env('CONF_TS_FOO'),
  bar: env('CONF_TS_BAR'),
};
