const value = 42 as number;
const tuple = [1, 2, 3] as const;
const obj = { a: 1, b: 'x' } as const;

export default {
  value,
  tuple,
  obj,
} satisfies Record<string, unknown>;
