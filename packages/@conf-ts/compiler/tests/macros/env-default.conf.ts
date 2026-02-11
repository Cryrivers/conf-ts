import { env } from '@conf-ts/macro';

export default {
  exists: env('CONF_TS_EXISTS', 'default'),
  missing: env('CONF_TS_MISSING', 'default'),
  nested: env('CONF_TS_MISSING', env('CONF_TS_EXISTS', 'fallback')),
};
