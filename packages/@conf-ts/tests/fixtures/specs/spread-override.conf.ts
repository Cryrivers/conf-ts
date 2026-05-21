const obj = { a: 1, b: 2, c: 3 };
const inner = { x: 1, y: 2, z: 3 };

export default {
  partial: { ...obj, b: 'new' },
  nested: { outer: { ...inner, y: 'new' } },
};
