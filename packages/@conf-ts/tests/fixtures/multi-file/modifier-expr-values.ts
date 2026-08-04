import { expr } from '@conf-ts/macro';

type Context = {
  imported: boolean;
  local: boolean;
  score: number;
};

export const importedRule = expr<Context, boolean>(
  ctx => ctx.imported || ctx.score > 5,
);

export const importedInput = {
  expression: importedRule,
  label: 'imported-present',
};

export const importedEmptyInput = {
  label: 'imported-absent',
};
