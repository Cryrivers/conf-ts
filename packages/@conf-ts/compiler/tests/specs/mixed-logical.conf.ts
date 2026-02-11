export default {
  mixed1: (true && false) || true,
  mixed2: (null ?? 'default') && true,
  mixed3: (0 || 'fallback') && 'final',
};
