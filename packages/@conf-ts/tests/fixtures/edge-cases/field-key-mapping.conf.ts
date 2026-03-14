import { arrayMap, String } from '@conf-ts/macro';

enum TestNumberEnum {
  EnumA = 1,
  EnumB = 2,
  EnumC = 3,
  EnumD = 4,
  EnumE = 5
}

enum TestStringEnum {
  EnumA = 'EnumA'
}


const numberFields = [
  TestNumberEnum.EnumA,
  TestNumberEnum.EnumB,
  TestNumberEnum.EnumC,
  TestNumberEnum.EnumD,
  TestNumberEnum.EnumE
];

export default {
  config: arrayMap(numberFields, (fieldKey) => ({
    string: TestStringEnum.EnumA,
    stringifiedNumber: String(fieldKey)
  }))
};
