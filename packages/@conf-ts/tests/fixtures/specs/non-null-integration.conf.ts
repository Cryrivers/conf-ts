const maybe: string | undefined = 'baz';
const obj = { foo: 'bar' } satisfies { foo: string | undefined };
const constObj = { val: 1 } as const;

export default {
  fromAs: maybe! as string,
  fromSatisfies: obj.foo!,
  fromConstObj: constObj.val!,
};
