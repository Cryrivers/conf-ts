const str = 'hi';
const num = 3;
const bool = true;
const arr = [1, 2];
const obj = { a: 1 };
const u = undefined;

export default {
  typeofStr: typeof str,
  typeofNum: typeof num,
  typeofBool: typeof bool,
  typeofArr: typeof arr,
  typeofObj: typeof obj,
  typeofNull: typeof null,
  typeofUndef: typeof u,
  typeofUnresolved: typeof notDefined,
  inObj: 'a' in obj,
  missingInObj: 'missing' in obj,
  inArr: 0 in arr,
  outOfRangeInArr: 5 in arr,
};
