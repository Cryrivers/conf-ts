export const MACRO_FUNCTION_NAMES = [
  'env',
  'String',
  'Number',
  'Boolean',
  'arrayMap',
  'arrayFlatMap',
  'arrayFilter',
  'expr',
  'exprTemplate',
] as const;

export const MACRO_FUNCTION_NAME_SET: ReadonlySet<string> = new Set(
  MACRO_FUNCTION_NAMES,
);
