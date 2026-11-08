import { parse, tokenize, type ASTNode } from '@conf-ts/expr-core';

/** `null` is the legacy leading-`]` expression, whose value is `undefined`. */
export const parseSource = (source: string): ASTNode | null => {
  const tokens = tokenize(source);
  const [first] = tokens;
  return first.kind === 'punct' && first.value === ']'
    ? null
    : parse(tokens, source);
};
