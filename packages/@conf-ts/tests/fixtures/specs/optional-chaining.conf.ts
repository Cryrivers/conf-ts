const user = { name: 'alice', address: { city: 'NYC' } };
const items = [10, 20];
const nullish: { name?: string; address?: { city?: string } } | undefined =
  undefined;
const nullArr: number[] | undefined = undefined;

export default {
  name: user?.name,
  city: user?.address?.city,
  firstItem: items?.[0],
  missingName: nullish?.name ?? 'fallback',
  missingDeep: nullish?.address?.city ?? 'fallback',
  missingItem: nullArr?.[0] ?? 'fallback',
};
