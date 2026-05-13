/** @jsxImportSource @conf-ts/macro */

import { String, env } from '@conf-ts/macro';

const API_KEY = "secret-123";

export default {
  config: <service name={String(42)} env={env('CONF_TS_JSX_ENV', 'default')} />,
  simple: <item label={`key-${API_KEY}`} />,
};
