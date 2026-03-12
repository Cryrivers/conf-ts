const maybeNumber: number | undefined = 42;
const maybeString: string | null = 'hello';
const obj: { a?: number } = { a: 5 };

export default {
  number: maybeNumber!,
  string: maybeString!,
  prop: obj.a!,
};
