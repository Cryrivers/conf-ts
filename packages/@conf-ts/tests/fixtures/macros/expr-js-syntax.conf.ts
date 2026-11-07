import { expr } from '@conf-ts/macro';

type Context = {
  enabled: boolean;
  count: number;
  format?: (value: number) => string;
  list?: number[];
  TRUE: boolean;
  Null: number;
  Undefined: string;
  flags: { False: boolean };
};

// Expressions the runtime parser used to reject or misread (optional calls,
// conditionals whose branch starts with `(` or `[`, context properties spelled
// like keywords in another letter case), and brackets after an operator,
// comma, or colon, which both transformers must space alike.
export default {
  optionalCall: expr<Context, string | undefined>(ctx =>
    ctx.format?.(ctx.count),
  ),
  parenthesizedConsequent: expr<Context, number>(ctx =>
    ctx.enabled ? (ctx.count + 1) * 2 : 0,
  ),
  arrayConsequent: expr<Context, number[]>(ctx =>
    ctx.enabled ? [ctx.count] : [],
  ),
  upperCaseKeyword: expr<Context, boolean>(
    ctx => ctx.TRUE && !ctx.flags.False,
  ),
  mixedCaseKeywords: expr<Context, string>(ctx =>
    ctx.Null > 0 ? ctx.Undefined : 'none',
  ),
  nullishArray: expr<Context, number[]>(ctx => ctx.list ?? []),
  nestedLiterals: expr<Context, unknown[]>(
    ctx => [ctx.count, [ctx.count], { values: [ctx.count], flags: { on: ctx.enabled } }],
  ),
};
