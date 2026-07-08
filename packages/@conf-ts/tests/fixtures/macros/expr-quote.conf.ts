import { expr } from '@conf-ts/macro';

const SINGLE = "it's";
const LABEL = 'line\n"quoted"\\path';
const DOUBLE = "double";
const QUOTE = '"';
const BACKSLASH = '\\';
const CONTROL = '\u0001';
const NON_ASCII = '星';

type Context = {
  value: string;
  label: string;
  key: string;
  nested: { key: string };
};

export default {
  directDouble: expr<Context, boolean>(ctx => ctx.value === "double"),
  directSingle: expr<Context, boolean>(ctx => ctx.value === 'single'),
  directEscaped: expr<Context, boolean>(ctx => ctx.label === 'it\'s'),
  directLabel: expr<Context, boolean>(ctx => ctx.label === 'line\n"quoted"\\path'),
  capturedSingle: expr<Context, boolean>(ctx => ctx.label === SINGLE),
  capturedLabel: expr<Context, boolean>(ctx => ctx.label === LABEL),
  capturedDouble: expr<Context, boolean>(ctx => ctx.value === DOUBLE),
  capturedQuote: expr<Context, boolean>(ctx => ctx.key === QUOTE),
  capturedBackslash: expr<Context, boolean>(ctx => ctx.key === BACKSLASH),
  capturedControl: expr<Context, boolean>(ctx => ctx.key === CONTROL),
  capturedNonAscii: expr<Context, boolean>(ctx => ctx.key === NON_ASCII),
  computedLiteral: expr<Context, string>(ctx => ctx["nested"].key),
  mixed: expr<Context, boolean>(ctx => ctx.value === DOUBLE && ctx.label !== SINGLE),
};
