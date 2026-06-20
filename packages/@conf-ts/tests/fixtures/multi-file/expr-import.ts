import { expr } from '@conf-ts/macro';
import { MY_CONSTANT } from './constants';
import { MultiFileEnum } from './enums';

export default {
  enumRule: expr(ctx => ctx.kind === MultiFileEnum.Value),
  constRule: expr(ctx => ctx.prefix === MY_CONSTANT),
};
