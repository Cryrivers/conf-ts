import { expr } from '@conf-ts/macro';

type Context = {
  requestCount: number;
  quota: number;
  name: string;
};

export default {
  // A method call whose receiver is a plain runtime-representable literal
  // (not the context, not a macro-time constant) must be kept as runtime
  // call syntax instead of being folded to a compile-time value.
  arrayIncludes: expr<Context, boolean>(ctx => [1, 2].includes(ctx.quota)),
  stringIncludes: expr<Context, boolean>(ctx => 'ab'.includes(ctx.name)),
};
