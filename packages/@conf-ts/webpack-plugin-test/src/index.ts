import config from './config.conf';

const runtimeJsxOutput = globalThis.__CONF_TS_JSX_OUTPUT__;
if (
  !runtimeJsxOutput ||
  runtimeJsxOutput.type !== '$type' ||
  runtimeJsxOutput.props !== false
) {
  throw new Error('ConfTsWebpackPlugin did not inject jsxOutput');
}

console.log(JSON.stringify({ config, runtimeJsxOutput }, null, 2));
