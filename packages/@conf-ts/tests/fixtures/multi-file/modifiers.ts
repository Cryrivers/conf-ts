import { modifier, String as macroString } from '@conf-ts/macro';

type Base = { value: number };

const defaultModifier = modifier<[Base], Base & { source: string }>(input => ({
  ...input,
  source: 'default',
}));

export const add = modifier<[Base, number], Base & { added: number }>(
  (input, amount) => ({
    ...input,
    added: input.value + amount,
  }),
);

export const stringify = modifier<[number], string>(value =>
  macroString(value),
);

export default defaultModifier;
