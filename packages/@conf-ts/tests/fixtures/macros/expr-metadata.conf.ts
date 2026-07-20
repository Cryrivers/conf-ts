import { expr } from '@conf-ts/macro';

type Context = {
  value: number;
  formatter: {
    format<T extends number>(value: T): string;
    tag<T extends number>(strings: TemplateStringsArray, value: T): string;
  };
};

export default {
  blockComment: expr<Context, number>(
    ctx => ctx.value /* erased block comment */ + 1,
  ),
  lineComment: expr<Context, number>(
    ctx =>
      ctx.value + // erased line comment
      1,
  ),
  typeAssertions: expr<Context, number>(
    ctx => (((<number>ctx.value) as number) satisfies number)!,
  ),
  genericCall: expr<Context, string>(
    ctx =>
      ctx.formatter.format<
        /* erased type-argument comment */ number
      >(ctx.value),
  ),
  instantiatedCall: expr<Context, string>(
    ctx => (ctx.formatter.format<number>)(ctx.value),
  ),
  genericTag: expr<Context, string>(
    ctx => ctx.formatter.tag<number>`value=${ctx.value}`,
  ),
  templateLiteral: expr<Context, string>(
    ctx => `raw /* preserved text */:${ctx.value /* erased comment */ + 1}`,
  ),
};
