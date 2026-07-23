import { expr, exprTemplate } from '@conf-ts/macro';
import * as macros from '@conf-ts/macro';

type Context = {
  a: number;
  enabled: boolean;
};

enum Offset {
  Small = 2,
}

const add = exprTemplate<Context, number, [number]>(
  (ctx, amount) => ctx.a + amount,
);
const addAlias = add;
const namespaceTemplate = macros['exprTemplate']<Context, number, [number]>(
  (ctx, amount) => ctx.a - amount,
);
const withOptions = exprTemplate<Context, number, [{ offset: number }]>(
  (ctx, options) => ctx.a + options.offset,
);
const includes = exprTemplate<Context, boolean, [number[]]>((ctx, allowed) =>
  allowed.includes(ctx.a),
);
const destructured = exprTemplate<
  Context,
  unknown,
  [
    { x?: number; label: string; extra?: number },
    [number, number?, number?],
    number?,
    ...number[],
  ]
>(
  (
    ctx,
    { x = 3, label, ...rest },
    [first, , third = 4],
    scale = 2,
    ...extras
  ) => ({
    value: (ctx.a + x + first + third + extras[0]) * scale,
    label,
    rest,
  }),
);
const above = exprTemplate<Context, boolean, [number]>(
  (ctx, minimum) => ctx.a > minimum,
);
const aboveTen = above(10);
const spreadArgs = [2, 5, 3] as const;

export default {
  scalar: addAlias(Offset.Small),
  namespaceMacro: namespaceTemplate(1),
  objectProperty: withOptions({ offset: 5 }),
  arrayLiteral: includes([1, 2, 3]),
  destructuring: destructured(
    { label: 'ready', extra: 9 },
    [1, 0],
    ...spreadArgs,
  ),
  composition: expr<Context, boolean>(ctx => aboveTen(ctx) && ctx.enabled),
};
