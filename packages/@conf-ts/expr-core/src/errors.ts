import type { SourceRange, Token } from './types';

export const formatInvalid = (expr?: string, detail?: string): string => {
  if (!expr) {
    return 'invalid expression';
  }
  return detail
    ? `invalid expression: ${expr}, ${detail}`
    : `invalid expression: ${expr}`;
};

export const formatParseError = (expr: string): string => {
  return `parse expression error: ${expr}`;
};

export interface ExprSyntaxErrorOptions extends SourceRange {
  detail: string;
  token?: Token;
}

/**
 * Thrown by `tokenize()` and `parse()` (and so by `@conf-ts/expression`) for
 * source text that isn't a valid expression. `message` keeps the historical
 * `invalid expression: …` / `parse expression error: …` text; `detail` says
 * what is wrong and `start`/`end` where, as offsets into the parsed string.
 */
export class ExprSyntaxError extends Error implements SourceRange {
  /** Offset of the first offending character. */
  readonly start: number;
  /** Offset just past the offending text; equals `start` at end of input. */
  readonly end: number;
  /** What is wrong, e.g. `unexpected token ")"` or `unterminated string literal`. */
  readonly detail: string;
  /** The token the parser rejected; absent for errors found by the lexer. */
  readonly token?: Token;

  constructor(message: string, options: ExprSyntaxErrorOptions) {
    super(message);
    this.name = 'ExprSyntaxError';
    this.start = options.start;
    this.end = options.end;
    this.detail = options.detail;
    if (options.token) {
      this.token = options.token;
    }
  }
}
