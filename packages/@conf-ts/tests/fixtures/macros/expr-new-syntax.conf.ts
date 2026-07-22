import { expr } from '@conf-ts/macro';

const TAX_RATE = 0.08;
const DYNAMIC_KEY = 'dyn';

type Context = {
  items: number[];
  key: string;
  value: number;
};

export default {
  // Array spread.
  arraySpread: expr<Context, number[]>(ctx => [...ctx.items, 99]),

  // Object shorthand referencing a nested callback's own bound parameter —
  // not a compile-time constant, so it must survive as runtime shorthand
  // text rather than being folded.
  shorthandNestedParam: expr<Context, { item: number; doubled: number }[]>(
    ctx => ctx.items.map(item => ({ item, doubled: item * 2 })),
  ),

  // Object shorthand referencing an outer compile-time constant — folded to
  // `TAX_RATE: 0.08` at compile time, alongside an explicit context property.
  shorthandOuterConst: expr<Context, unknown>(
    ctx => ({ TAX_RATE, key: ctx.key }),
  ),

  // Computed object key rooted in the context parameter.
  computedContextKey: expr<Context, Record<string, number>>(
    ctx => ({ [ctx.key]: ctx.value }),
  ),

  // Computed object key referencing an outer compile-time constant — folded
  // to a literal key at compile time.
  computedConstKey: expr<Context, Record<string, number>>(
    ctx => ({ [DYNAMIC_KEY]: ctx.value }),
  ),
};
