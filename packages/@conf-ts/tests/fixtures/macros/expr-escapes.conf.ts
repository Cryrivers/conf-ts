import { expr } from '@conf-ts/macro';

type Context = {
  s: string;
  tag: (strings: TemplateStringsArray, ...values: unknown[]) => string;
};

// String and template literal escapes must mean in the emitted expression
// what they mean in the TypeScript source.
export default {
  backspace: expr<Context, boolean>(ctx => ctx.s === '\b'),
  nul: expr<Context, boolean>(ctx => ctx.s === '\0'),
  hex: expr<Context, boolean>(ctx => ctx.s === '\x41\x7e'),
  codePoint: expr<Context, boolean>(ctx => ctx.s === '\u{1F600}\u{41}'),
  unicode: expr<Context, boolean>(ctx => ctx.s === 'A'),
  doubleQuoted: expr<Context, boolean>(ctx => ctx.s === "\b\0\x41\u{42}"),
  template: expr<Context, string>(ctx => ctx.s + `\b\0\x41\u{1F600}${ctx.s}`),
  tagged: expr<Context, string>(ctx => ctx.tag`\x41${ctx.s}\u{42}`),
};
