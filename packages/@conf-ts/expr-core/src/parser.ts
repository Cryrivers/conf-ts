import { ExprSyntaxError, formatParseError } from './errors';
import { tokenize, tokenizeAt } from './lexer';
import type {
  ArrayPatternParam,
  ArrowParam,
  ASTNode,
  BinaryNode,
  ComputedObjectProperty,
  IdentifierParam,
  LiteralNode,
  LogicalNode,
  ObjectPatternParam,
  ObjectPatternProperty,
  ObjectProperty,
  SpreadElement,
  TemplateLiteralNode,
  Token,
  UnaryNode,
} from './types';

export interface ParserState {
  tokens: Token[];
  pos: number;
  src: string;
}

interface State extends ParserState {
  /** Offset of `src` in the source that token positions refer to. */
  base?: number;
}

const peek = (ps: ParserState) => ps.tokens[ps.pos];
const next = (ps: ParserState) => ps.tokens[ps.pos++];
const eof = (ps: ParserState) => peek(ps)?.kind === 'eof';
// End of the most recently consumed token.
const lastEnd = (ps: ParserState) => ps.tokens[ps.pos - 1].end;

// A token's source text, e.g. a string literal with its quotes.
const tokenText = (ps: State, tk: Token) =>
  ps.src.slice(tk.start - (ps.base ?? 0), tk.end - (ps.base ?? 0));

const isPunct = (ps: ParserState, value: string) =>
  peek(ps)?.kind === 'punct' && peek(ps)?.value === value;
const isOp = (ps: ParserState, value?: string) =>
  peek(ps)?.kind === 'operator' && (value ? peek(ps)?.value === value : true);
const isIdentifierName = (token: Token | undefined) =>
  token?.kind === 'identifier' ||
  (token?.kind === 'operator' &&
    ['instanceof', 'in', 'typeof', 'void', 'delete'].includes(token.value));

const EXPRESSION = 'an expression';

const describe = (ps: State, tk: Token): string => {
  switch (tk.kind) {
    case 'eof':
      return 'end of expression';
    case 'template':
      return 'template literal';
    case 'identifier':
      return `identifier "${tk.value}"`;
    case 'number':
      return `number ${tk.value}`;
    case 'string':
      return `string ${tokenText(ps, tk)}`;
    default:
      return `token "${tk.value}"`;
  }
};

/** Throws for the current token, optionally naming what was expected there. */
const fail = (ps: State, expected?: string): never => {
  const tk: Token | undefined =
    ps.tokens[Math.min(ps.pos, ps.tokens.length - 1)];
  const detail =
    !tk || (tk.kind === 'eof' && expected === EXPRESSION)
      ? 'unexpected end of expression'
      : `unexpected ${describe(ps, tk)}${expected ? `, expected ${expected}` : ''}`;
  throw new ExprSyntaxError(formatParseError(ps.src), {
    start: tk?.start ?? 0,
    end: tk?.end ?? 0,
    detail,
    token: tk,
  });
};

const expectPunct = (ps: State, value: string) => {
  if (!isPunct(ps, value)) {
    fail(ps, `"${value}"`);
  }
  next(ps);
};

const mustNode = (ps: State, node: ASTNode | null) => {
  if (!node) {
    fail(ps, EXPRESSION);
  }
  return node as ASTNode;
};

const literal = (ps: State, tk: Token, value: unknown): LiteralNode => ({
  type: 'Literal',
  value,
  raw: tokenText(ps, tk),
  start: tk.start,
  end: tk.end,
});

const templateLiteral = (ps: State, tk: Token): TemplateLiteralNode => {
  const t = tk.template!;
  return {
    type: 'TemplateLiteral',
    quasis: t.quasis,
    rawQuasis: t.rawQuasis,
    // Each interpolation is parsed on its own, keeping positions in the
    // whole source.
    expressions: t.expressionsSrc.map((src, index) =>
      parseSource(src, t.expressionsStart[index]),
    ),
    start: tk.start,
    end: tk.end,
  };
};

const parsePrimary = (ps: State): ASTNode | null => {
  const tk = peek(ps);
  if (!tk) {
    return null;
  }
  if (tk.kind === 'number') {
    next(ps);
    return literal(ps, tk, Number(tk.value));
  }
  if (tk.kind === 'string') {
    next(ps);
    return literal(ps, tk, tk.value);
  }
  if (tk.kind === 'boolean') {
    next(ps);
    return literal(ps, tk, tk.value === 'true');
  }
  if (tk.kind === 'null') {
    next(ps);
    return literal(ps, tk, null);
  }
  if (tk.kind === 'undefined') {
    next(ps);
    return literal(ps, tk, undefined);
  }
  if (tk.kind === 'identifier') {
    next(ps);
    return { type: 'Identifier', name: tk.value, start: tk.start, end: tk.end };
  }
  if (tk.kind === 'template') {
    next(ps);
    return templateLiteral(ps, tk);
  }
  if (isPunct(ps, '(')) {
    next(ps);
    const e = parseExpression(ps);
    const close = peek(ps);
    expectPunct(ps, ')');
    return {
      type: 'ParenthesizedExpression',
      // `()` is the legacy spelling of `(undefined)`.
      expression: e ?? {
        type: 'Literal',
        value: undefined,
        start: close.start,
        end: close.start,
      },
      start: tk.start,
      end: lastEnd(ps),
    };
  }
  if (isPunct(ps, '[')) {
    return parseArray(ps);
  }
  if (isPunct(ps, '{')) {
    return parseObject(ps);
  }
  return null;
};

const parseArray = (ps: State): ASTNode => {
  const open = peek(ps);
  expectPunct(ps, '[');
  const elements: Array<ASTNode | SpreadElement> = [];
  while (!eof(ps) && !isPunct(ps, ']')) {
    if (isPunct(ps, ',')) {
      const comma = next(ps);
      elements.push({ type: 'Elision', start: comma.start, end: comma.end });
      continue;
    }
    if (isOp(ps, '...')) {
      const spread = next(ps);
      const arg = mustNode(ps, parseExpression(ps));
      elements.push({
        type: 'SpreadElement',
        argument: arg,
        start: spread.start,
        end: arg.end,
      });
    } else {
      const el = parseExpression(ps);
      if (el) {
        elements.push(el);
      }
    }
    if (isPunct(ps, ',')) {
      next(ps); // allow trailing comma
    } else {
      break;
    }
  }
  expectPunct(ps, ']');
  return {
    type: 'ArrayExpression',
    elements,
    start: open.start,
    end: lastEnd(ps),
  };
};

const parseObject = (ps: State): ASTNode => {
  const open = peek(ps);
  expectPunct(ps, '{');
  const properties: Array<
    ObjectProperty | ComputedObjectProperty | SpreadElement
  > = [];
  while (!eof(ps) && !isPunct(ps, '}')) {
    // support spread in object literal: ...expr
    if (isOp(ps, '...')) {
      const spread = next(ps);
      const arg = mustNode(ps, parseExpression(ps));
      properties.push({
        type: 'SpreadElement',
        argument: arg,
        start: spread.start,
        end: arg.end,
      });
      if (isPunct(ps, ',')) {
        next(ps);
      }
      continue;
    }

    // computed key: { [expr]: value }
    if (isPunct(ps, '[')) {
      const bracket = next(ps);
      const keyExpr = mustNode(ps, parseExpression(ps));
      expectPunct(ps, ']');
      expectPunct(ps, ':');
      const value = mustNode(ps, parseExpression(ps));
      properties.push({
        key: keyExpr,
        computed: true,
        value,
        start: bracket.start,
        end: value.end,
      });
      if (isPunct(ps, ',')) {
        next(ps);
      }
      continue;
    }

    const keyTk = peek(ps);
    if (!keyTk || (!isIdentifierName(keyTk) && keyTk.kind !== 'string')) {
      fail(ps, 'a property name');
    }
    next(ps);
    const key = keyTk.value;
    if (isPunct(ps, ':')) {
      next(ps);
      const value = mustNode(ps, parseExpression(ps));
      properties.push({ key, value, start: keyTk.start, end: value.end });
    } else {
      // shorthand property: { a } is short for { a: a }, and only a plain
      // identifier can stand in for its own value (matching real JS, where
      // e.g. `in`/`typeof` can be property keys but not shorthand ones).
      if (keyTk.kind !== 'identifier') {
        fail(ps, '":"');
      }
      properties.push({
        key,
        value: {
          type: 'Identifier',
          name: key,
          start: keyTk.start,
          end: keyTk.end,
        },
        start: keyTk.start,
        end: keyTk.end,
      });
    }
    if (isPunct(ps, ',')) {
      next(ps); // allow trailing comma
    }
  }
  expectPunct(ps, '}');
  return {
    type: 'ObjectExpression',
    properties,
    start: open.start,
    end: lastEnd(ps),
  };
};

const parsePostfix = (ps: State, base: ASTNode | null): ASTNode | null => {
  let expr = base;
  let optionalChain = false;
  while (expr) {
    // Tagged template: Identifier/MemberExpression immediately followed by template token
    if (peek(ps)?.kind === 'template') {
      const tk = next(ps);
      expr = {
        type: 'TaggedTemplateExpression',
        tag: expr,
        quasi: templateLiteral(ps, tk),
        start: expr.start,
        end: tk.end,
      };
      continue;
    }

    // Optional chaining: '?.prop', '?.[expr]', '?.(args)'. As in JavaScript,
    // a '?' followed by anything but '.' (including '[' or '(') starts a
    // conditional expression instead.
    let optional = false;
    if (isPunct(ps, '?')) {
      const nextTk = ps.tokens[ps.pos + 1];
      if (nextTk?.kind !== 'punct' || nextTk.value !== '.') {
        break;
      }
      next(ps); // consume '?'
      next(ps); // consume '.'
      optionalChain = true;
      if (!isPunct(ps, '[') && !isPunct(ps, '(')) {
        expr = parseDotProperty(ps, expr, true);
        continue;
      }
      optional = true;
    } else if (isPunct(ps, '.')) {
      next(ps);
      expr = parseDotProperty(ps, expr, false);
      continue;
    }

    if (isPunct(ps, '[')) {
      next(ps);
      const propExpr = mustNode(ps, parseExpression(ps));
      expectPunct(ps, ']');
      expr = {
        type: 'MemberExpression',
        object: expr,
        property: propExpr,
        computed: true,
        ...(optional ? { optional: true } : {}),
        start: expr.start,
        end: lastEnd(ps),
      };
      continue;
    }
    if (isPunct(ps, '(')) {
      next(ps);
      const args: ASTNode[] = [];
      if (!isPunct(ps, ')')) {
        while (true) {
          const arg = parseExpression(ps);
          if (arg) {
            args.push(arg);
          }
          if (isPunct(ps, ',')) {
            next(ps);
            continue;
          }
          break;
        }
      }
      expectPunct(ps, ')');
      expr = {
        type: 'CallExpression',
        callee: expr,
        args,
        ...(optional ? { optional: true } : {}),
        start: expr.start,
        end: lastEnd(ps),
      };
      continue;
    }
    break;
  }
  return expr && optionalChain
    ? {
        type: 'ChainExpression',
        expression: expr,
        start: expr.start,
        end: expr.end,
      }
    : expr;
};

// The property name after `.` or `?.`, which is already consumed.
const parseDotProperty = (
  ps: State,
  object: ASTNode,
  optional: boolean,
): ASTNode => {
  const prop = peek(ps);
  if (!isIdentifierName(prop)) {
    fail(ps, 'a property name');
  }
  next(ps);
  return {
    type: 'MemberExpression',
    object,
    property: literal(ps, prop, prop.value),
    computed: false,
    ...(optional ? { optional: true } : {}),
    start: object.start,
    end: prop.end,
  };
};

// Finds the index of the punct that closes the '(' at `openIndex`, tracking
// nested (), [], {} depth. Returns -1 if unmatched (caller then falls back to
// treating '(' as a normal parenthesized expression).
const findMatchingParenEnd = (tokens: Token[], openIndex: number): number => {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.kind === 'eof') {
      return -1;
    }
    if (
      tk.kind === 'punct' &&
      (tk.value === '(' || tk.value === '[' || tk.value === '{')
    ) {
      depth++;
    } else if (
      tk.kind === 'punct' &&
      (tk.value === ')' || tk.value === ']' || tk.value === '}')
    ) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
};

const isArrowToken = (tk: Token | undefined) =>
  tk?.kind === 'punct' && tk.value === '=>';

const parseParamDefault = (ps: State): ASTNode | undefined => {
  if (!isOp(ps, '=')) {
    return undefined;
  }
  next(ps);
  return mustNode(ps, parseExpression(ps));
};

// Builds an identifier binding for a name already read from the token
// stream (e.g. after resolving an object pattern's `key: rename`), parsing
// its trailing `= default` if present. Shared by parseIdentifierParam below
// and each property/element of a destructuring pattern.
const parseDefaultedIdentifier = (
  ps: State,
  nameTk: Token,
): IdentifierParam => ({
  kind: 'identifier',
  name: nameTk.value,
  default: parseParamDefault(ps),
  start: nameTk.start,
  end: lastEnd(ps),
});

const consumeIdentifierName = (ps: State): Token => {
  const tk = peek(ps);
  if (tk?.kind !== 'identifier') {
    fail(ps, 'an identifier');
  }
  next(ps);
  return tk;
};

const parseIdentifierParam = (ps: State): IdentifierParam =>
  parseDefaultedIdentifier(ps, consumeIdentifierName(ps));

// One level of destructuring only: each property/element binds a plain
// (optionally renamed, optionally defaulted) identifier, never another
// nested pattern — matching the restriction the macro-transformer already
// enforces when down-leveling TypeScript source into this DSL.
const parseObjectPatternParam = (ps: State): ObjectPatternParam => {
  const open = peek(ps);
  expectPunct(ps, '{');
  const properties: ObjectPatternProperty[] = [];
  while (!isPunct(ps, '}')) {
    const keyTk = peek(ps);
    if (!isIdentifierName(keyTk)) {
      fail(ps, 'a property name');
    }
    next(ps);
    let bindingTk = keyTk;
    if (isPunct(ps, ':')) {
      next(ps);
      bindingTk = consumeIdentifierName(ps);
    }
    const value = parseDefaultedIdentifier(ps, bindingTk);
    properties.push({
      key: keyTk.value,
      value,
      start: keyTk.start,
      end: value.end,
    });
    if (isPunct(ps, ',')) {
      next(ps);
      continue;
    }
    break;
  }
  expectPunct(ps, '}');
  return {
    kind: 'object',
    properties,
    default: parseParamDefault(ps),
    start: open.start,
    end: lastEnd(ps),
  };
};

const parseArrayPatternParam = (ps: State): ArrayPatternParam => {
  const open = peek(ps);
  expectPunct(ps, '[');
  const elements: Array<IdentifierParam | null> = [];
  while (!isPunct(ps, ']')) {
    if (isPunct(ps, ',')) {
      elements.push(null); // hole, e.g. the middle slot in `[a, , b]`
      next(ps);
      continue;
    }
    elements.push(parseIdentifierParam(ps));
    if (isPunct(ps, ',')) {
      next(ps);
      continue;
    }
    break;
  }
  expectPunct(ps, ']');
  return {
    kind: 'array',
    elements,
    default: parseParamDefault(ps),
    start: open.start,
    end: lastEnd(ps),
  };
};

const parseArrowParam = (ps: State): ArrowParam => {
  if (isOp(ps, '...')) {
    const spread = next(ps);
    const tk = consumeIdentifierName(ps);
    return { kind: 'rest', name: tk.value, start: spread.start, end: tk.end };
  }
  if (isPunct(ps, '{')) {
    return parseObjectPatternParam(ps);
  }
  if (isPunct(ps, '[')) {
    return parseArrayPatternParam(ps);
  }
  return parseIdentifierParam(ps);
};

// Arrow functions are only supported with an expression body (never a
// block) — this keeps the DSL's grammar to "expressions only"; the
// macro-transformer is responsible for down-leveling richer JS callback
// forms (block bodies, `function` expressions) into this shape before the
// text ever reaches here. Parameters otherwise mirror real JS: a single
// bare identifier, or a parenthesized comma-separated list that can mix
// plain identifiers (with defaults), one level of object/array
// destructuring (with defaults), and a trailing rest parameter.
const tryParseArrowFunction = (ps: State): ASTNode | null => {
  const tk = peek(ps);
  if (tk?.kind === 'identifier' && isArrowToken(ps.tokens[ps.pos + 1])) {
    next(ps); // identifier
    next(ps); // '=>'
    const body = mustNode(ps, parseExpression(ps));
    return {
      type: 'ArrowFunctionExpression',
      params: [
        { kind: 'identifier', name: tk.value, start: tk.start, end: tk.end },
      ],
      body,
      start: tk.start,
      end: body.end,
    };
  }
  if (isPunct(ps, '(')) {
    const closeIndex = findMatchingParenEnd(ps.tokens, ps.pos);
    if (closeIndex !== -1 && isArrowToken(ps.tokens[closeIndex + 1])) {
      next(ps); // '('
      const params: ArrowParam[] = [];
      if (!isPunct(ps, ')')) {
        while (true) {
          const param = parseArrowParam(ps);
          params.push(param);
          if (param.kind === 'rest') {
            break; // rest must be the last parameter; trailing comma/params rejected below
          }
          if (isPunct(ps, ',')) {
            next(ps);
            continue;
          }
          break;
        }
      }
      expectPunct(ps, ')');
      next(ps); // '=>'
      const body = mustNode(ps, parseExpression(ps));
      return {
        type: 'ArrowFunctionExpression',
        params,
        body,
        start: tk.start,
        end: body.end,
      };
    }
  }
  return null;
};

const prefixOps = new Set(['+', '-', '!', '~', 'void', 'delete', 'typeof']);

const parseUnary = (ps: State): ASTNode | null => {
  const tk = peek(ps);
  if (!tk) {
    return null;
  }
  if (tk.kind === 'operator' && prefixOps.has(tk.value)) {
    next(ps);
    const arg = mustNode(ps, parseUnary(ps));
    return {
      type: 'UnaryExpression',
      operator: tk.value as UnaryNode['operator'],
      argument: arg,
      start: tk.start,
      end: arg.end,
    };
  }
  // Arrow functions have lower precedence than everything else and are never
  // postfixed directly (`x => x` can't be called without wrapping parens,
  // just like real JS), so this returns straight from the arrow branch.
  const arrow = tryParseArrowFunction(ps);
  if (arrow) {
    return arrow;
  }
  const primary = parsePrimary(ps);
  return parsePostfix(ps, primary);
};

/** Binding power of each binary operator; higher binds tighter. */
export const precedence: Readonly<
  Record<BinaryNode['operator'] | LogicalNode['operator'], number>
> = {
  '**': 12,
  '*': 11,
  '/': 11,
  '%': 11,
  '+': 10,
  '-': 10,
  '<<': 9,
  '>>': 9,
  '>>>': 9,
  '>': 8,
  '<': 8,
  '>=': 8,
  '<=': 8,
  instanceof: 8,
  in: 8,
  '==': 7,
  '!=': 7,
  '===': 7,
  '!==': 7,
  '&': 6,
  '^': 5,
  '|': 4,
  '&&': 3,
  '||': 2,
  '??': 2,
};

const precedenceOf = (operator: string): number | undefined =>
  Object.prototype.hasOwnProperty.call(precedence, operator)
    ? precedence[operator as keyof typeof precedence]
    : undefined;

const parseBinaryRHS = (ps: State, minPrec: number, left: ASTNode): ASTNode => {
  let lhs = left;
  while (!eof(ps) && peek(ps).kind === 'operator') {
    const opTk = peek(ps);
    const prec = precedenceOf(opTk.value);
    if (prec === undefined || prec < minPrec) {
      break;
    }
    next(ps);
    let rhs = mustNode(ps, parseUnary(ps));
    // handle right-assoc? none here
    while (!eof(ps) && peek(ps).kind === 'operator') {
      const nextPrec = precedenceOf(peek(ps).value);
      if (
        nextPrec !== undefined &&
        (nextPrec > prec || (opTk.value === '**' && nextPrec === prec))
      ) {
        rhs = parseBinaryRHS(ps, nextPrec, rhs);
      } else {
        break;
      }
    }
    const op = opTk.value as LogicalNode['operator'] | BinaryNode['operator'];
    const range = { start: lhs.start, end: rhs.end };
    if (op === '&&' || op === '||' || op === '??') {
      lhs = {
        type: 'LogicalExpression',
        operator: op,
        left: lhs,
        right: rhs,
        ...range,
      };
    } else {
      lhs = {
        type: 'BinaryExpression',
        operator: op,
        left: lhs,
        right: rhs,
        ...range,
      };
    }
  }
  return lhs;
};

const parseConditional = (ps: State, test: ASTNode): ASTNode => {
  if (!isPunct(ps, '?')) {
    return test;
  }
  next(ps);
  const consequent = mustNode(ps, parseExpression(ps));
  expectPunct(ps, ':');
  const alternate = mustNode(ps, parseExpression(ps));
  return {
    type: 'ConditionalExpression',
    test,
    consequent,
    alternate,
    start: test.start,
    end: alternate.end,
  };
};

export const parseExpression = (ps: ParserState): ASTNode | null => {
  const lhs = parseUnary(ps);
  if (!lhs) {
    return null;
  }
  const rhs = parseBinaryRHS(ps, 1, lhs);
  return parseConditional(ps, rhs);
};

const parseTokens = (tokens: Token[], src: string, base: number): ASTNode => {
  const ps: State = { tokens, pos: 0, src, base };
  const node = parseExpression(ps);
  if (!node) {
    fail(ps, EXPRESSION);
  }
  if (!eof(ps)) {
    fail(ps);
  }
  return node as ASTNode;
};

// Parses `src` found at offset `base` of a larger source.
const parseSource = (src: string, base: number): ASTNode =>
  parseTokens(tokenizeAt(src, base), src, base);

/**
 * Parses the tokens of `src` (from `tokenize(src)`). Throws `ExprSyntaxError`
 * unless they form exactly one expression; never returns `null` despite its
 * type.
 */
export const parse = (tokens: Token[], src: string): ASTNode | null =>
  parseTokens(tokens, src, 0);

export type ParseResult =
  | { ok: true; ast: ASTNode }
  | { ok: false; error: ExprSyntaxError };

/**
 * Tokenizes and parses `input` without throwing for invalid syntax: the
 * result holds either the AST or the `ExprSyntaxError` that `parse()` would
 * have thrown, with its `start`/`end` range and `detail`.
 */
export const tryParse = (input: string): ParseResult => {
  try {
    return { ok: true, ast: parseTokens(tokenize(input), input, 0) };
  } catch (error) {
    if (error instanceof ExprSyntaxError) {
      return { ok: false, error };
    }
    throw error;
  }
};
