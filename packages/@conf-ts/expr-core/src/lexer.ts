import { ExprSyntaxError, formatInvalid } from './errors';
import type { Token, TokenKind } from './types';

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const isHexDigit = (ch: string) =>
  isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
const isIdentStart = (ch: string) =>
  ch === '_' ||
  ch === '$' ||
  (ch >= 'a' && ch <= 'z') ||
  (ch >= 'A' && ch <= 'Z');
const isIdentPart = (ch: string) => isIdentStart(ch) || isDigit(ch);

/** Whether `text` is spelled like an identifier (keywords included). */
export const isIdentifierText = (text: string): boolean => {
  if (!isIdentStart(text[0] ?? '')) {
    return false;
  }
  for (let i = 1; i < text.length; i++) {
    if (!isIdentPart(text[i])) {
      return false;
    }
  }
  return true;
};

const punctuators = new Set(['(', ')', '[', ']', '{', '}', ',', ':', '.', '?']);

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

interface State {
  readonly input: string;
  pos: number;
  /** Offset of `input` in the source that token positions refer to. */
  readonly base: number;
}

const eof = (st: State) => st.pos >= st.input.length;

// A token ending at `st.pos`. `raw` defaults to the source text; tokens whose
// value is their source text pass `value` instead of slicing it again.
const token = (
  st: State,
  kind: TokenKind,
  value: string,
  start: number,
  raw = st.input.slice(start, st.pos),
): Token => ({
  kind,
  value,
  raw,
  start: st.base + start,
  end: st.base + st.pos,
});

// `message` keeps the historical text: the source being tokenized plus, for
// some errors only (`quoteDetail`), the detail. The error always has `detail`.
const fail = (
  st: State,
  start: number,
  end: number,
  detail: string,
  quoteDetail: boolean,
): never => {
  throw new ExprSyntaxError(
    formatInvalid(st.input, quoteDetail ? detail : undefined),
    { start: st.base + start, end: st.base + end, detail },
  );
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
      fail(st, start, st.pos, 'missing exponent digits', false);
    }
    skipDigits(st);
  }
  const text = st.input.slice(start, st.pos);
  return token(st, 'number', text, start, text);
};

// `count` hex digits starting at `st.pos`, or undefined.
const readHex = (st: State, count: number): number | undefined => {
  const digits = st.input.slice(st.pos, st.pos + count);
  for (let i = 0; i < count; i++) {
    if (!isHexDigit(digits[i] ?? '')) {
      return undefined;
    }
  }
  st.pos += count;
  return parseInt(digits, 16);
};

/**
 * Decodes the escape sequence whose backslash is at `st.pos`, moving past it,
 * the way strict-mode JavaScript does. Returns `undefined` when the input
 * ends right after the backslash.
 */
const decodeEscape = (st: State): string | undefined => {
  const { input } = st;
  const backslash = st.pos;
  st.pos++;
  if (eof(st)) {
    return undefined;
  }
  const esc = input[st.pos++];
  // Throws for the escape from the backslash up to `end`.
  const invalid = (detail: string, end: number): never =>
    fail(
      st,
      backslash,
      end,
      `${detail} [${input.slice(backslash, end)}]`,
      true,
    );
  switch (esc) {
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'v':
      return '\v';
    case '0':
      if (!isDigit(input[st.pos] ?? '')) {
        return '\0';
      }
      return invalid('octal escape sequences are not allowed', st.pos + 1);
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7':
      return invalid('octal escape sequences are not allowed', st.pos);
    case '8':
    case '9':
      return invalid('invalid escape sequence', st.pos);
    case 'x': {
      const code = readHex(st, 2);
      return code === undefined
        ? invalid(
            'invalid hexadecimal escape',
            Math.min(st.pos + 2, input.length),
          )
        : String.fromCharCode(code);
    }
    case 'u': {
      if (input[st.pos] !== '{') {
        const code = readHex(st, 4);
        return code === undefined
          ? invalid(
              'invalid unicode escape',
              Math.min(st.pos + 4, input.length),
            )
          : String.fromCharCode(code);
      }
      // `\u{X…}`: any number of hex digits, for a code point up to 0x10FFFF
      let end = st.pos + 1;
      while (end < input.length && isHexDigit(input[end])) {
        end++;
      }
      const code = parseInt(input.slice(st.pos + 1, end), 16);
      if (input[end] !== '}' || !(code <= 0x10ffff)) {
        return invalid(
          'invalid unicode escape',
          Math.min(end + 1, input.length),
        );
      }
      st.pos = end + 1;
      return String.fromCodePoint(code);
    }
    case '\r':
      // a line continuation, like `\` followed by a newline
      if (input[st.pos] === '\n') {
        st.pos++;
      }
      return '';
    case '\n':
    case '\u2028':
    case '\u2029':
      return '';
    default:
      // Any other character stands for itself, e.g. `\\`, a quote, or `\s`.
      return esc;
  }
};

// Literal text is collected as slices between escapes rather than one
// character at a time.

const readString = (st: State): Token => {
  const { input } = st;
  const start = st.pos;
  const quote = input[st.pos++];
  let value = '';
  let chunk = st.pos;
  while (!eof(st)) {
    const ch = input[st.pos];
    if (ch === quote) {
      value += input.slice(chunk, st.pos);
      st.pos++;
      return token(st, 'string', value, start);
    }
    if (ch !== '\\') {
      st.pos++;
      continue;
    }
    value += input.slice(chunk, st.pos);
    const decoded = decodeEscape(st);
    if (decoded === undefined) {
      break;
    }
    value += decoded;
    chunk = st.pos;
  }
  return fail(st, start, input.length, 'unterminated string literal', false);
};

// The skip helpers only find where a template literal interpolation ends;
// its source is validated when it is tokenized on its own (see the parser).
// Positions may run past the end of input after a trailing backslash.

// Moves past the string or template literal at `st.pos`, including a
// template's interpolations, or to the end of input if it isn't closed.
const skipQuoted = (st: State) => {
  const { input } = st;
  const quote = input[st.pos++];
  while (!eof(st)) {
    const ch = input[st.pos++];
    if (ch === '\\') {
      st.pos++;
    } else if (ch === quote) {
      return;
    } else if (quote === '`' && ch === '$' && input[st.pos] === '{') {
      st.pos++;
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
  const { input } = st;
  let depth = 0;
  while (!eof(st)) {
    const ch = input[st.pos];
    if (ch === '"' || ch === "'" || ch === '`') {
      skipQuoted(st);
      continue;
    }
    st.pos++;
    if (ch === '\\') {
      st.pos++;
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
  const { input } = st;
  const start = st.pos;
  st.pos++; // opening backtick
  const quasis: string[] = [];
  const rawQuasis: string[] = [];
  const expressionsSrc: string[] = [];
  const expressionsStart: number[] = [];
  let rawStart = st.pos;
  let cooked = '';
  let chunk = st.pos;
  while (!eof(st)) {
    const ch = input[st.pos];
    if (ch === '\\') {
      cooked += input.slice(chunk, st.pos);
      const decoded = decodeEscape(st);
      if (decoded === undefined) {
        // the historical message has no detail here
        fail(st, start, input.length, 'unterminated template literal', false);
      }
      cooked += decoded;
      chunk = st.pos;
      continue;
    }
    const interpolation = ch === '$' && input[st.pos + 1] === '{';
    if (ch !== '`' && !interpolation) {
      st.pos++;
      continue;
    }
    // End of a chunk; without escapes its cooked text is its raw text.
    const raw = input.slice(rawStart, st.pos);
    rawQuasis.push(raw);
    quasis.push(chunk === rawStart ? raw : cooked + input.slice(chunk, st.pos));
    if (!interpolation) {
      st.pos++;
      const result = token(st, 'template', '', start);
      result.template = { quasis, rawQuasis, expressionsSrc, expressionsStart };
      return result;
    }
    const open = st.pos;
    st.pos += 2;
    const expressionStart = st.pos;
    if (!skipInterpolation(st)) {
      fail(st, open, input.length, 'unterminated template expression', true);
    }
    expressionsSrc.push(input.slice(expressionStart, st.pos - 1));
    expressionsStart.push(st.base + expressionStart);
    cooked = '';
    rawStart = chunk = st.pos;
  }
  return fail(st, start, input.length, 'unterminated template literal', true);
};

const readIdentifier = (st: State): Token => {
  const start = st.pos;
  st.pos++;
  while (!eof(st) && isIdentPart(st.input[st.pos])) {
    st.pos++;
  }
  const id = st.input.slice(start, st.pos);
  return token(st, keywordKinds.get(id) ?? 'identifier', id, start, id);
};

// Operators of two or three characters all start with one of `= ! < > & | ?
// * .`; any other character is a one-character token. Punctuators are
// 'punct' tokens (and so is `=>`); everything else, including characters the
// parser doesn't know, is an 'operator' token.
const readOperatorOrPunct = (st: State): Token => {
  const { input } = st;
  const start = st.pos;
  const c1 = input[start];
  const c2 = input[start + 1];
  const c3 = input[start + 2];
  let length = 1;
  switch (c1) {
    case '=': // = == === =>
      length = c2 === '=' ? (c3 === '=' ? 3 : 2) : c2 === '>' ? 2 : 1;
      break;
    case '!': // ! != !==
      length = c2 === '=' ? (c3 === '=' ? 3 : 2) : 1;
      break;
    case '<': // < <= <<
      length = c2 === '=' || c2 === '<' ? 2 : 1;
      break;
    case '>': // > >= >> >>>
      length = c2 === '>' ? (c3 === '>' ? 3 : 2) : c2 === '=' ? 2 : 1;
      break;
    case '&':
    case '|':
    case '?':
    case '*': // && || ?? **
      length = c2 === c1 ? 2 : 1;
      break;
    case '.': // . ...
      length = c2 === '.' && c3 === '.' ? 3 : 1;
      break;
  }
  st.pos += length;
  const value = length === 1 ? c1 : input.slice(start, st.pos);
  const punct = length === 1 ? punctuators.has(c1) : value === '=>';
  return token(st, punct ? 'punct' : 'operator', value, start, value);
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
      fail(st, st.pos, st.pos + 1, 'unexpected character "\\"', false);
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
  tokens.push(token(st, 'eof', '', st.pos, ''));
  return tokens;
};

export const tokenize = (input?: string): Token[] => {
  if (typeof input !== 'string') {
    throw new Error(formatInvalid());
  }
  return tokenizeAt(input, 0);
};
