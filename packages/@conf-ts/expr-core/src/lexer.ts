import { ExprSyntaxError, formatInvalid } from './errors';
import type { Token, TokenKind } from './types';

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const HEX4 = /^[0-9a-fA-F]{4}$/;
const isIdentStart = (ch: string) =>
  ch === '_' ||
  ch === '$' ||
  (ch >= 'a' && ch <= 'z') ||
  (ch >= 'A' && ch <= 'Z');
const isIdentPart = (ch: string) => isIdentStart(ch) || isDigit(ch);

const punctuators = new Set(['(', ')', '[', ']', '{', '}', ',', ':', '.', '?']);

const twoCharOps = new Set([
  '==',
  '!=',
  '>=',
  '<=',
  '&&',
  '||',
  '??',
  '**',
  '<<',
  '>>',
]);
const threeCharOps = new Set(['===', '!==', '...', '>>>']);

/**
 * Words the lexer doesn't emit as identifiers. Matched case-sensitively, as in
 * JavaScript: `TRUE` or `Null` are ordinary identifiers.
 */
export const keywordKinds: ReadonlyMap<string, TokenKind> = new Map<
  string,
  TokenKind
>([
  ['true', 'boolean'],
  ['false', 'boolean'],
  ['null', 'null'],
  ['undefined', 'undefined'],
  ['instanceof', 'operator'],
  ['in', 'operator'],
  ['typeof', 'operator'],
  ['void', 'operator'],
  ['delete', 'operator'],
]);

export interface LexerState {
  input: string;
  pos: number;
}

interface State extends LexerState {
  /** Offset of `input` in the source that token positions refer to. */
  readonly base: number;
}

const eof = (st: State) => st.pos >= st.input.length;

const token = (
  st: State,
  kind: TokenKind,
  value: string,
  start: number,
): Token => {
  return { kind, value, start: st.base + start, end: st.base + st.pos };
};

// `message` keeps the historical text: the source being tokenized plus, for
// some errors only, a detail. `detail` is always given on the error itself.
const fail = (
  st: State,
  start: number,
  end: number,
  detail: string,
  messageDetail?: string,
): never => {
  throw new ExprSyntaxError(formatInvalid(st.input, messageDetail), {
    start: st.base + start,
    end: st.base + end,
    detail,
  });
};

const skipWhitespace = (st: State) => {
  while (!eof(st)) {
    const ch = st.input[st.pos];
    if (
      ch === ' ' ||
      ch === '\t' ||
      ch === '\n' ||
      ch === '\r' ||
      ch === '\v' ||
      ch === '\f'
    ) {
      st.pos++;
    } else {
      break;
    }
  }
};

const skipDigits = (st: State) => {
  while (!eof(st) && isDigit(st.input[st.pos])) {
    st.pos++;
  }
};

const readNumber = (st: State): Token => {
  const start = st.pos;
  skipDigits(st);
  if (st.input[st.pos] === '.') {
    st.pos++;
    skipDigits(st);
  }
  const ch = st.input[st.pos];
  if (ch === 'e' || ch === 'E') {
    st.pos++;
    if (st.input[st.pos] === '+' || st.input[st.pos] === '-') {
      st.pos++;
    }
    if (eof(st) || !isDigit(st.input[st.pos])) {
      fail(st, start, st.pos, 'missing exponent digits');
    }
    skipDigits(st);
  }
  return token(st, 'number', st.input.slice(start, st.pos), start);
};

/**
 * Decodes the escape sequence whose backslash is at `st.pos`, moving past it.
 * Returns `undefined` when the input ends right after the backslash.
 */
const decodeEscape = (st: State): string | undefined => {
  const backslash = st.pos;
  st.pos++;
  if (eof(st)) {
    return undefined;
  }
  const esc = st.input[st.pos++];
  switch (esc) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 'f':
      return '\f';
    case 't':
      return '\t';
    case 'v':
      return '\v';
    case 's':
      // non-standard, treat as literal 's'
      return 's';
    case 'u': {
      const hexStart = st.pos;
      const hex = st.input.slice(hexStart, hexStart + 4);
      if (!HEX4.test(hex)) {
        const detail = `invalid unicode escape [\\u${hex}]`;
        fail(st, backslash, hexStart + hex.length, detail, detail);
      }
      st.pos += 4;
      return String.fromCharCode(parseInt(hex, 16));
    }
    default:
      // includes '\\', quotes and '`', which stand for themselves
      return esc;
  }
};

const readString = (st: State): Token => {
  const start = st.pos;
  const quote = st.input[st.pos++];
  let out = '';
  while (!eof(st)) {
    const ch = st.input[st.pos];
    if (ch === quote) {
      st.pos++;
      return token(st, 'string', out, start);
    }
    if (ch === '\\') {
      const decoded = decodeEscape(st);
      if (decoded === undefined) {
        break;
      }
      out += decoded;
    } else {
      out += ch;
      st.pos++;
    }
  }
  return fail(st, start, st.input.length, 'unterminated string literal');
};

// Advances `st.pos` by one character without running past the end.
const step = (st: State) => {
  st.pos = Math.min(st.pos + 1, st.input.length);
};

// The skip* helpers only find where a template literal interpolation ends;
// its source is validated when it is tokenized on its own (see the parser).

const skipQuoted = (st: State) => {
  const quote = st.input[st.pos];
  step(st);
  while (!eof(st)) {
    const ch = st.input[st.pos];
    step(st);
    if (ch === '\\') {
      step(st);
    } else if (ch === quote) {
      return;
    }
  }
};

const skipTemplate = (st: State) => {
  step(st); // opening backtick
  while (!eof(st)) {
    const ch = st.input[st.pos];
    step(st);
    if (ch === '\\') {
      step(st);
    } else if (ch === '`') {
      return;
    } else if (ch === '$' && st.input[st.pos] === '{') {
      step(st);
      if (!skipInterpolation(st)) {
        return;
      }
    }
  }
};

/**
 * Moves past an interpolation's source and its closing brace, starting just
 * after `${`. Returns false when the input ends first.
 */
const skipInterpolation = (st: State): boolean => {
  let depth = 0;
  while (!eof(st)) {
    const ch = st.input[st.pos];
    if (ch === '"' || ch === "'") {
      skipQuoted(st);
      continue;
    }
    if (ch === '`') {
      skipTemplate(st);
      continue;
    }
    step(st);
    if (ch === '\\') {
      step(st);
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      if (depth === 0) {
        return true;
      }
      depth--;
    }
  }
  return false;
};

const readTemplate = (st: State): Token => {
  const start = st.pos;
  st.pos++; // opening backtick
  const quasis: string[] = [];
  const rawQuasis: string[] = [];
  const expressionsSrc: string[] = [];
  const expressionsStart: number[] = [];
  let cooked = '';
  let rawStart = st.pos;
  while (!eof(st)) {
    const ch = st.input[st.pos];
    if (ch === '`') {
      quasis.push(cooked);
      rawQuasis.push(st.input.slice(rawStart, st.pos));
      st.pos++;
      const result = token(st, 'template', '', start);
      result.template = { quasis, rawQuasis, expressionsSrc, expressionsStart };
      return result;
    }
    if (ch === '\\') {
      const decoded = decodeEscape(st);
      if (decoded === undefined) {
        fail(st, start, st.input.length, 'unterminated template literal');
      }
      cooked += decoded;
      continue;
    }
    if (ch === '$' && st.input[st.pos + 1] === '{') {
      quasis.push(cooked);
      rawQuasis.push(st.input.slice(rawStart, st.pos));
      cooked = '';
      const open = st.pos;
      st.pos += 2;
      const expressionStart = st.pos;
      if (!skipInterpolation(st)) {
        const detail = 'unterminated template expression';
        fail(st, open, st.input.length, detail, detail);
      }
      expressionsSrc.push(st.input.slice(expressionStart, st.pos - 1));
      expressionsStart.push(st.base + expressionStart);
      rawStart = st.pos;
      continue;
    }
    cooked += ch;
    st.pos++;
  }
  const detail = 'unterminated template literal';
  return fail(st, start, st.input.length, detail, detail);
};

const readIdentifier = (st: State): Token => {
  const start = st.pos;
  st.pos++;
  while (!eof(st) && isIdentPart(st.input[st.pos])) {
    st.pos++;
  }
  const id = st.input.slice(start, st.pos);
  return token(st, keywordKinds.get(id) ?? 'identifier', id, start);
};

const readOperatorOrPunct = (st: State): Token => {
  const start = st.pos;
  const three = st.input.slice(start, start + 3);
  if (threeCharOps.has(three)) {
    st.pos += 3;
    return token(st, 'operator', three, start);
  }
  const two = three.slice(0, 2);
  if (two === '=>') {
    st.pos += 2;
    return token(st, 'punct', '=>', start);
  }
  if (twoCharOps.has(two)) {
    st.pos += 2;
    return token(st, 'operator', two, start);
  }
  // Single-character operators, and any other character, are 'operator'
  // tokens; the parser rejects the ones it doesn't know.
  const one = st.input[st.pos++];
  return token(st, punctuators.has(one) ? 'punct' : 'operator', one, start);
};

/**
 * Tokenizes `input` as the text found at offset `base` of a larger source, so
 * that token positions are measured in that source. Used for template literal
 * interpolations; error messages still quote `input` itself.
 */
export const tokenizeAt = (input: string, base: number): Token[] => {
  const st: State = { input, pos: 0, base };
  const tokens: Token[] = [];
  while (true) {
    skipWhitespace(st);
    if (eof(st)) {
      break;
    }
    const ch = st.input[st.pos];
    if (ch === '\\') {
      // standalone backslash is invalid
      fail(st, st.pos, st.pos + 1, 'unexpected character "\\"');
    }
    if (ch === '"' || ch === "'") {
      tokens.push(readString(st));
    } else if (ch === '`') {
      tokens.push(readTemplate(st));
    } else if (isDigit(ch)) {
      tokens.push(readNumber(st));
    } else if (isIdentStart(ch)) {
      tokens.push(readIdentifier(st));
    } else {
      tokens.push(readOperatorOrPunct(st));
    }
  }
  tokens.push(token(st, 'eof', '', st.pos));
  return tokens;
};

export const tokenize = (input?: string): Token[] => {
  if (typeof input !== 'string') {
    throw new Error(formatInvalid());
  }
  return tokenizeAt(input, 0);
};
