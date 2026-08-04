import { expr, modifier } from '@conf-ts/macro';

import {
  importedEmptyInput,
  importedInput,
  importedRule,
} from './modifier-expr-values';

type Context = {
  imported: boolean;
  local: boolean;
  score: number;
};
type Rule = (ctx: Context) => boolean;
type Input = {
  readonly expression?: Rule;
  readonly label: string;
};

const localRule = expr<Context, boolean>(
  ctx => ctx.local || ctx.score < 100,
);

const withOptional = modifier<[Input], Input & { expression: Rule }>(input => ({
  ...input,
  expression: input.expression
    ? expr<Context, boolean>(
        ctx => input.expression!(ctx) && localRule(ctx),
      )
    : localRule,
}));

const direct = modifier<[Rule], Rule>(expression =>
  expr<Context, boolean>(ctx => expression(ctx) && localRule(ctx)),
);

export default {
  importedPresent: withOptional(importedInput),
  importedAbsent: withOptional(importedEmptyInput),
  importedDirect: direct(importedRule),
};
