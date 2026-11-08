import { parse, tokenize, type ASTNode } from '../src';

export const parseSource = (source: string): ASTNode =>
  parse(tokenize(source), source)!;

const POSITION_KEYS = new Set(['start', 'end', 'raw']);

/**
 * The tree without source positions, `raw` texts, and (with `parens`)
 * `ParenthesizedExpression` wrappers, for comparing trees structurally.
 */
export const strip = (value: unknown, parens = true): unknown => {
  if (Array.isArray(value)) {
    return value.map(item => strip(item, parens));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const node = value as Record<string, unknown>;
  if (parens && node.type === 'ParenthesizedExpression') {
    return strip(node.expression, parens);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(node)) {
    if (!POSITION_KEYS.has(key) && item !== undefined) {
      out[key] = strip(item, parens);
    }
  }
  return out;
};
