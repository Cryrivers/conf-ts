const key = 'super';
const config = {
  host: 'localhost',
  port: 8080,
};

export default {
  host: config.host,
  port: config.port,
  'test-1': { cool: 123, awesome: true },
  // prettier-ignore
  "test-2": { cool: 456, awesome: false },
  [key]: { cool: 789, awesome: true },
  [`test-${key}`]: { cool: 101112, awesome: false },
};
