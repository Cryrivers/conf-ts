enum MyEnum {
  A,
  B = 5,
  C,
}

enum MyStringEnum {
  Foo = 'foo',
  Bar = 'bar',
}

enum MyInitializedEnum {
  A = 10,
  B = A + 5,
  C = B * 2,
}

export default {
  numberEnums: {
    enumValueA: MyEnum.A,
    enumValueB: MyEnum.B,
    enumValueC: MyEnum.C,
  },
  stringEnums: {
    stringEnumValueFoo: MyStringEnum.Foo,
    stringEnumValueBar: MyStringEnum.Bar,
  },
  initializedEnums: {
    initializedEnumValueA: MyInitializedEnum.A,
    initializedEnumValueB: MyInitializedEnum.B,
    initializedEnumValueC: MyInitializedEnum.C,
  },
};
