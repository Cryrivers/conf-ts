import { expr } from '@conf-ts/macro';

type Context = {
  a: boolean;
  b: boolean;
  label: string;
};

export default {
  spaces: expr<Context, boolean>(ctx => ctx.a      &&       ctx.b),
  tabs: expr<Context, boolean>(ctx => ctx.a		&&		ctx.b),
  newlines: expr<Context, boolean>(
    ctx => ctx.a &&

      ctx.b,
  ),
  mixed: expr<Context, boolean>(
    ctx => ctx.a 	
  &&
	 ctx.b,
  ),
  literalSpaces: expr<Context, boolean>(ctx => ctx.label === 'a    b'),
  literalTabs: expr<Context, boolean>(ctx => ctx.label === 'a		b'),
  template: expr<Context, string>(
    ctx => `first		  second:${ctx.a	&&
      ctx.b}`,
  ),
};
