import expression, { compile, ExpressionCompileError } from './index';

// Keep CommonJS `require('@conf-ts/expression')` callable after adding ESM
// named exports. The new APIs are also available as properties in CJS.
export default Object.assign(expression, {
  compile,
  ExpressionCompileError,
});
