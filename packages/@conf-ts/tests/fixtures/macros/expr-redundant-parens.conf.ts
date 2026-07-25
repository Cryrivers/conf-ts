import { expr } from '@conf-ts/macro';

// Regression coverage for the redundant-parentheses removal step that runs
// at the end of `$expr` compilation (see @conf-ts/macro-transformer's
// removeRedundantParentheses and @conf-ts/macro-transformer-native's
// remove_redundant_parentheses / remove_redundant_parentheses_iterative).
// Two individually-safe paren removals are not always jointly safe when
// applied together (e.g. `((a+b))*(c)`: dropping both layers around `a+b`
// exposes it to the following `*`, changing precedence), so these fixtures
// exercise that batching behavior and rely on macro-transformer-parity.test.ts
// to prove the native fast path never diverges from the JS implementation.
type Context = {
  a: number;
  b: number;
  c: number;
  d: number;
};

export default {
  tripleNestedSingle: expr<Context, number>(ctx => (((ctx.a)))),
  redundantWithPrecedence: expr<Context, number>(
    ctx => ((ctx.a + ctx.b)) * (ctx.c),
  ),
  requiredParensPreserved: expr<Context, number>(
    ctx => (ctx.a + ctx.b) * ctx.c,
  ),
  mixedRedundantAndRequired: expr<Context, number>(
    ctx => (ctx.a + (ctx.b * ctx.c)) - (ctx.d),
  ),
  nullishThenOrGrouping: expr<Context, number>(
    ctx => ((ctx.a ?? ctx.b)) || ((ctx.c)),
  ),
  logicalAndOrGrouping: expr<Context, boolean>(
    ctx => ((ctx.a) && (ctx.b)) || ((ctx.c) && (ctx.d)),
  ),
  unaryNegationChain: expr<Context, number>(
    ctx => ((-(ctx.a))) - ((-(ctx.b))),
  ),
  chainedSubtractionOfNegatives: expr<Context, number>(
    ctx => (ctx.a) - (-(ctx.b)) - (-(ctx.c)),
  ),
  exponentiationLeftGroupingRequired: expr<Context, number>(
    ctx => (ctx.a ** ctx.b) ** (ctx.c),
  ),
  exponentiationRightGroupingRedundant: expr<Context, number>(
    ctx => (ctx.a ** (ctx.b ** ctx.c)),
  ),
  callOnParenthesizedCallee: expr<Context, number>(
    ctx => (ctx.a)(ctx.b),
  ),
  callOnDoubleParenthesizedCallee: expr<Context, number>(
    ctx => ((ctx.a))((ctx.b)),
  ),
  callOnParenthesizedExpression: expr<Context, number>(
    ctx => (ctx.a + 1)(ctx.b),
  ),
  logicalNot: expr<Context, boolean>(ctx => !(ctx.a)),
  doubleLogicalNot: expr<Context, boolean>(ctx => !(!(ctx.a))),
  typeofParenthesized: expr<Context, string>(ctx => typeof (ctx.a)),
};
