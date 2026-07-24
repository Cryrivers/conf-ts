import {
  exprTemplate,
  String as macroString,
} from '@conf-ts/macro';
import * as macros from '@conf-ts/macro';

type Context = { value: number };

const defaultTemplate = exprTemplate<Context, number, [number]>(
  (ctx, amount) => ctx.value + amount,
);

export const multiplied = exprTemplate<Context, number, [number]>(
  (ctx, factor) => ctx.value * factor,
);

export const runtimeAliasString = exprTemplate<Context, string, []>(ctx =>
  macroString(ctx.value),
);

export const staticNamespaceString = exprTemplate<Context, string, [number]>(
  (ctx, value) => macros.String(value),
);

export default defaultTemplate;
