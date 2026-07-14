import config from './config.conf';

const runtimeJsxOutput = globalThis.__CONF_TS_JSX_OUTPUT__;
if (
  !runtimeJsxOutput ||
  runtimeJsxOutput.type !== '$type' ||
  runtimeJsxOutput.props !== false
) {
  throw new Error('ConfTsWebpackPlugin did not inject jsxOutput');
}

const expected = {
  name: 'test-config',
  version: '1.0.0',
  env: 'development',
  port: 3000,
  a: { name: 'a', value: 1 },
  b: { name: 'b', value: 2 },
  macros: {
    activeServices: ['api:3', 'scheduler:1'],
    replicaSlots: ['api', 'api-backup', 'scheduler', 'scheduler-backup'],
    casts: { number: 42, boolean: true, string: '2026' },
    target: 'local',
  },
  expressions: {
    canRelease: '(user?.score ?? 0) >= 80 && stage === "production"',
    label: '`${region}:${String(retries)}`',
    destination: 'primary ?? fallback',
    priority: 'retries === 0 ? "high" : retries < 3 ? "normal" : "low"',
  },
};

if (JSON.stringify(config) !== JSON.stringify(expected)) {
  throw new Error(
    `Unexpected generated config:\n${JSON.stringify(config, null, 2)}`,
  );
}

console.log(JSON.stringify({ config, runtimeJsxOutput }, null, 2));
