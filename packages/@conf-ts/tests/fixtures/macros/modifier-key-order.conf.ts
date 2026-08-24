import { modifier } from '@conf-ts/macro';

type Entry = Record<string, number>;

const identity = modifier<[Entry], Entry>(input => input);

const merge = modifier<[Entry, Entry], Entry>((left, right) => ({
  ...left,
  ...right,
}));

const override = modifier<[Entry], Entry>(input => ({
  ...input,
  b: 200,
  e: 5,
}));

const nested = modifier<[Entry, Entry], Entry>((left, right) =>
  override(merge(left, right)),
);

const wrapNested = modifier<
  [Entry],
  { outer: Entry; sibling: Entry }
>(input => ({
  outer: {
    x: 0,
    ...input,
    b: 200,
    y: 9,
  },
  sibling: {
    ...input,
    a: 100,
  },
}));

const base = { a: 1, b: 2, c: 3 };
const overrides = { b: 20, d: 4, a: 10 };

export default {
  inputArgument: identity({ ...base, b: 99 }),
  returnedObject: override(base),
  directMerge: merge(base, overrides),
  nestedModifier: nested(base, overrides),
  nestedObject: wrapNested(base),
};
