const nested = { a: { b: { c: 10 } } };
const top = { x: { y: 'ok' } };

export default {
  deep: nested!.a!.b!.c!,
  mid: top!.x!.y!,
};
