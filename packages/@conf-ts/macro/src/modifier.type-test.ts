import { modifier, type Modifier, type ModifierCallback } from './index';

type InputA = { a: number };
type InputB = { b: number };
type Output = InputA & InputB & { extraProperty: number };

const callback: ModifierCallback<[InputA, InputB], Output> = (
  inputA,
  inputB,
) => ({
  ...inputA,
  ...inputB,
  extraProperty: 3,
});

const addProperty = modifier<[InputA, InputB], Output>(callback);
const modifierType: Modifier<[InputA, InputB], Output> = addProperty;
const outputType: Output = modifierType({ a: 1 }, { b: 2 });

const inferred = modifier((inputA: InputA, inputB: InputB): Output => ({
  ...inputA,
  ...inputB,
  extraProperty: 3,
}));
const inferredOutput: Output = inferred({ a: 1 }, { b: 2 });

const zero = modifier<[], { enabled: boolean }>(() => ({ enabled: true }));
const zeroOutput: { enabled: boolean } = zero();

const flexible = modifier<
  [{ value?: number }?, ...labels: string[]],
  { value: number; labels: string[] }
>((options = {}, ...labels) => ({
  value: options.value ?? 0,
  labels,
}));
flexible();
flexible({ value: 1 }, 'a', 'b');

// @ts-expect-error required modifier arguments cannot be omitted
addProperty({ a: 1 });

// @ts-expect-error modifier arguments retain their declared types
addProperty({ a: '1' }, { b: 2 });

void outputType;
void inferredOutput;
void zeroOutput;
