import a from './a';
import b from './b';
import c from './c';

export const d = c.value + 1;
export default {
  name: "test-config",
  version: "1.0.0",
  env: "development",
  port: 3000,
  a,
  b
};