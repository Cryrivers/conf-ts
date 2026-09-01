import {
  formatInvalid,
  formatParseError,
  parse,
  tokenize,
  type ASTNode,
} from '@conf-ts/expr-core';

/** `null` is the legacy leading-`]` expression, whose value is `undefined`. */
export const parseSource = (source: string): ASTNode | null => {
  let ast: ASTNode | null = null;

  try {
    const tokens = tokenize(source);
    if (
      tokens.length > 0 &&
      tokens[0].kind === 'punct' &&
      tokens[0].value === ']'
    ) {
      return null;
    }
    ast = parse(tokens, source);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(formatInvalid(source));
  }

  if (!ast) {
    throw new Error(formatParseError(source));
  }
  return ast;
};
