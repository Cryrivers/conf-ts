import { formatInvalid, raiseInvalid } from './errors';
import type { Token } from './types';

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const isHex = (ch: string) => (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
const isIdentStart = (ch: string) => ch === '_' || ch === '$' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
const isIdentPart = (ch: string) => isIdentStart(ch) || isDigit(ch);

const punctuators = new Set(['(', ')', '[', ']', '{', '}', ',', ':', '.', '?']);

const twoCharOps = new Set(['==', '!=', '>=', '<=', '&&', '||', '??']);
const threeCharOps = new Set(['===', '!==', '...']);

export interface LexerState {
  input: string;
  pos: number;
}

const createState = (input: string): LexerState => ({ input, pos: 0 });

const peek = (st: LexerState) => st.input[st.pos] ?? '';
const next = (st: LexerState) => st.input[st.pos++] ?? '';
const eof = (st: LexerState) => st.pos >= st.input.length;

const skipWhitespace = (st: LexerState) => {
  while (!eof(st)) {
    const ch = peek(st);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f') {
      st.pos++;
    } else {
      break;
    }
  }
};

const readNumber = (st: LexerState, startPos: number): Token => {
  let numStr = '';
  let ch = peek(st);
  while (isDigit(ch)) {
    numStr += next(st);
    ch = peek(st);
  }
  if (ch === '.') {
    numStr += next(st);
    ch = peek(st);
    while (isDigit(ch)) {
      numStr += next(st);
      ch = peek(st);
    }
  }
  if (ch === 'e' || ch === 'E') {
    numStr += next(st);
    ch = peek(st);
    if (ch === '+' || ch === '-') {
      numStr += next(st);
      ch = peek(st);
    }
    if (!isDigit(ch)) {
      // invalid exponent: keep message concise as tests expect
      raiseInvalid(st.input);
    }
    while (isDigit(ch)) {
      numStr += next(st);
      ch = peek(st);
    }
  }
  return { kind: 'number', value: numStr, pos: startPos };
};

const decodeEscape = (st: LexerState): string => {
  const esc = next(st);
  if (!esc) {
    raiseInvalid(st.input);
  }
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
    case '`':
      return '`';
    case '\\':
      return '\\';
    case 'u': {
      const hexStart = st.pos;
      let hex = '';
      for (let i = 0; i < 4; i++) {
        const h = next(st);
        if (!h || !isHex(h)) {
          const seq = st.input.slice(hexStart, hexStart + 4);
          const msg = `invalid unicode escape [\\u${seq}]`;
          throw new Error(formatInvalid(st.input, msg));
        }
        hex += h;
      }
      return String.fromCharCode(parseInt(hex, 16));
    }
    default:
      return esc;
  }
};

const readString = (st: LexerState): Token => {
  const quote = next(st); // consume opening quote
  const startPos = st.pos - 1;
  let out = '';
  while (!eof(st)) {
    const ch = next(st);
    if (ch === quote) {
      return { kind: 'string', value: out, pos: startPos };
    }
    if (ch === '\\') {
      out += decodeEscape(st);
    } else {
      out += ch;
    }
  }
  // not closed
  throw new Error(formatInvalid(st.input));
};

const readTemplate = (st: LexerState): Token => {
  const backtick = next(st); // consume opening backtick
  const startPos = st.pos - 1;
  if (backtick !== '`') {
    raiseInvalid(st.input);
  }
  const cookedChunks: string[] = [];
  const rawChunks: string[] = [];
  const exprSrcs: string[] = [];

  let cooked = '';
  let raw = '';
  while (!eof(st)) {
    const ch = next(st);
    if (ch === '`') {
      // end of template
      cookedChunks.push(cooked);
      rawChunks.push(raw);
      return {
        kind: 'template',
        value: '',
        pos: startPos,
        template: { quasis: cookedChunks, rawQuasis: rawChunks, expressionsSrc: exprSrcs },
      };
    }
    if (ch === '\\') {
      // escape in template head/tail
      const esc = peek(st);
      // record raw as backslash+esc char
      raw += ch;
      if (!esc) {
        raiseInvalid(st.input);
      }
      raw += esc;
      cooked += decodeEscape(st);
      continue;
    }
    if (ch === '$' && peek(st) === '{') {
      // start of expression
      next(st); // consume '{'
      cookedChunks.push(cooked);
      rawChunks.push(raw);
      cooked = '';
      raw = '';
      // read until matching '}' with nesting
      let depth = 1;
      let expr = '';
      while (!eof(st)) {
        const c = next(st);
        if (c === '\\') {
          // keep escapes literal inside expr
          expr += c + next(st);
          continue;
        }
        if (c === "'" || c === '"') {
          // string literal inside expr: consume until closing quote handling escapes
          expr += c;
          while (!eof(st)) {
            const sc = next(st);
            expr += sc;
            if (sc === '\\') {
              expr += next(st);
              continue;
            }
            if (sc === c) {
              break;
            }
          }
          continue;
        }
        if (c === '`') {
          // nested template inside expression: consume until closing backtick, supporting escapes and nested ${}
          expr += c;
          let tCooked = '';
          let tRaw = '';
          while (!eof(st)) {
            const tc = next(st);
            expr += tc;
            if (tc === '`') {
              break;
            }
            if (tc === '\\') {
              expr += peek(st);
              tCooked += decodeEscape(st);
              tRaw += '\\' + peek(st);
              continue;
            }
            if (tc === '$' && peek(st) === '{') {
              expr += next(st); // '{'
              // track nested depth inside nested template expression via braces as part of expr string
              let nd = 1;
              while (!eof(st)) {
                const nc = next(st);
                expr += nc;
                if (nc === '\\') {
                  expr += next(st);
                  continue;
                }
                if (nc === "'" || nc === '"') {
                  expr += nc;
                  while (!eof(st)) {
                    const nsc = next(st);
                    expr += nsc;
                    if (nsc === '\\') {
                      expr += next(st);
                      continue;
                    }
                    if (nsc === nc) {
                      break;
                    }
                  }
                  continue;
                }
                if (nc === '{') {
                  nd++;
                } else if (nc === '}') {
                  nd--;
                  if (nd === 0) {
                    break;
                  }
                }
              }
              continue;
            }
          }
          continue;
        }
        if (c === '{') {
          depth++;
          expr += c;
          continue;
        }
        if (c === '}') {
          depth--;
          if (depth === 0) {
            exprSrcs.push(expr);
            break;
          }
          expr += c;
          continue;
        }
        expr += c;
      }
      // if loop ended without closing '}', it's malformed
      if (depth !== 0) {
        throw new Error(formatInvalid(st.input, 'unterminated template expression'));
      }
      continue;
    }
    // regular character
    cooked += ch;
    raw += ch;
  }
  // not closed
  throw new Error(formatInvalid(st.input, 'unterminated template literal'));
};

const readIdentifier = (st: LexerState): Token => {
  const startPos = st.pos;
  let id = next(st);
  while (!eof(st) && isIdentPart(peek(st))) {
    id += next(st);
  }
  const lowers = id.toLowerCase();
  if (lowers === 'true' || lowers === 'false') {
    return { kind: 'boolean', value: lowers, pos: startPos };
  }
  if (lowers === 'null') {
    return { kind: 'null', value: lowers, pos: startPos };
  }
  if (lowers === 'undefined') {
    return { kind: 'undefined', value: lowers, pos: startPos };
  }
  return { kind: 'identifier', value: id, pos: startPos };
};

const readOperatorOrPunct = (st: LexerState): Token => {
  const startPos = st.pos;
  const ch1 = next(st);
  const ch2 = peek(st);
  const ch3 = st.input[st.pos + 1] ?? '';

  const two = ch1 + ch2;
  const three = two + ch3;
  if (threeCharOps.has(three)) {
    st.pos += 2;
    return { kind: 'operator', value: three, pos: startPos };
  }
  if (twoCharOps.has(two)) {
    st.pos += 1;
    return { kind: 'operator', value: two, pos: startPos };
  }
  if (
    ch1 === '>' ||
    ch1 === '<' ||
    ch1 === '+' ||
    ch1 === '-' ||
    ch1 === '*' ||
    ch1 === '/' ||
    ch1 === '%' ||
    ch1 === '!' ||
    ch1 === '='
  ) {
    return { kind: 'operator', value: ch1, pos: startPos };
  }
  if (punctuators.has(ch1)) {
    return { kind: 'punct', value: ch1, pos: startPos };
  }
  // unknown single char
  return { kind: 'operator', value: ch1, pos: startPos };
};

export const tokenize = (input?: string): Token[] => {
  if (!input && input !== '') {
    // undefined or null
    raiseInvalid();
  }
  const st = createState(input ?? '');
  const tokens: Token[] = [];
  while (!eof(st)) {
    skipWhitespace(st);
    if (eof(st)) {
      break;
    }
    const ch = peek(st);
    if (ch === '\\') {
      // standalone backslash is invalid
      raiseInvalid(st.input);
    }
    if (ch === '"' || ch === "'") {
      tokens.push(readString(st));
      continue;
    }
    if (ch === '`') {
      tokens.push(readTemplate(st));
      continue;
    }
    if (isDigit(ch)) {
      tokens.push(readNumber(st, st.pos));
      continue;
    }
    if (isIdentStart(ch)) {
      tokens.push(readIdentifier(st));
      continue;
    }
    tokens.push(readOperatorOrPunct(st));
  }
  tokens.push({ kind: 'eof', value: '', pos: st.pos });
  return tokens;
};
