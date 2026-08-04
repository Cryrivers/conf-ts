import {
  arrayMap,
  expr,
  modifier,
  String as macroString,
} from '@conf-ts/macro';

type InputA = { a: number };
type InputB = { b: number };
type Added = InputA & InputB & { extraProperty: number };
type RuleContext = { value: number };
type ConditionInput = {
  condition: (ctx: RuleContext) => boolean;
  label: string;
};

const EXTRA_PROPERTY = 3;
const anotherCondition = true;

const addProperty = modifier<[InputA, InputB], Added>((inputA, inputB) => ({
  ...inputA,
  ...inputB,
  extraProperty: EXTRA_PROPERTY,
}));
const addPropertyAlias = addProperty;

const zero = modifier<[], { enabled: boolean }>(() => ({ enabled: true }));

const destructured = modifier<
  [
    { x?: number; label: string; extra?: number },
    [number, number?, number?],
    number?,
    ...number[],
  ],
  { value: number; label: string; rest: { extra?: number } }
>(
  (
    { x = 3, label, ...rest },
    [first, , third = 4],
    scale = 2,
    ...extras
  ) => ({
    value: (x + first + third + extras[0]) * scale,
    label,
    rest,
  }),
);

const nested = modifier<[InputA], Added>(inputA =>
  addProperty(inputA, { b: 2 }),
);
const stringify = modifier<[number], string>(value => macroString(value));
const double = modifier<[number], number>(value => value * 2);
const collect = modifier<[...number[]], number[]>((...values) => values);
const shorthand = modifier<[number], { value: number }>(value => ({ value }));
const addEach = modifier<[number], number[]>(amount =>
  arrayMap([1, 2], value => value + amount),
);
const minimumRule = modifier<[number], string>(minimum =>
  expr<RuleContext, boolean>(ctx => ctx.value >= minimum),
);
const extendCondition = modifier<[ConditionInput], ConditionInput>(input => ({
  ...input,
  condition: expr<RuleContext, boolean>(
    ctx => input.condition(ctx) && anotherCondition,
  ),
}));
const merge = modifier<
  [Record<string, number>, Record<string, number>],
  Record<string, number>
>((left, right) => ({ ...left, ...right }));

const spreadArgs = [{ label: 'ready', extra: 9 }, [1, 0], 2, 5] as const;

export default {
  modifierTest: addPropertyAlias({ a: 1 }, { b: 2 }),
  zero: zero(),
  destructuring: destructured(...spreadArgs),
  nested: nested({ a: 1 }),
  stringified: stringify(42),
  scalar: double(4),
  mapped: arrayMap([1, 2], value => double(value)),
  nestedArrayMacro: addEach(3),
  nestedExpr: minimumRule(3),
  reusedExpr: extendCondition({
    condition: expr<RuleContext, boolean>(
      ctx => ctx.value > 1 || ctx.value < 0,
    ),
    label: 'reused',
  }),
  array: collect(1, 2, 3),
  shorthand: shorthand(7),
  overridden: merge({ a: 1, b: 1 }, { a: 2 }),
};
