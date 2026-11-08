import { ExprSyntaxError, formatParseError } from './errors';
import { keywordKinds, tokenize, tokenizeAt } from './lexer';
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

const peek = (ps: ParserState) => ps.tokens[ps.pos];
const next = (ps: ParserState) => ps.tokens[ps.pos++];
const eof = (ps: ParserState) => peek(ps)?.kind === 'eof';
// Where the most recently consumed token ends, i.e. the end of a node that
// was just completed.
const lastEnd = (ps: ParserState) => ps.tokens[ps.pos - 1].end;

const isPunct = (ps: ParserState, value: string) =>
  peek(ps)?.kind === 'punct' && peek(ps)?.value === value;
const isOp = (ps: ParserState, value?: string) =>
  peek(ps)?.kind === 'operator' && (value ? peek(ps)?.value === value : true);
// A name that can follow `.` or be an object key: an identifier, or one of
// the operator keywords (`in`, `typeof`, ...).
const isIdentifierName = (token: Token | undefined) =>
  token?.kind === 'identifier' ||
  (token?.kind === 'operator' && keywordKinds.get(token.value) === 'operator');

/** The prefix (unary) operators. */
export const prefixOps: ReadonlySet<string> = new Set([
  '+',
  '-',
  '!',
  '~',
  'void',
  'delete',
  'typeof',
]);

export const isLogicalOperator = (
  operator: string,
): operator is LogicalNode['operator'] =>
  operator === '&&' || operator === '||' || operator === '??';

// Binding power of each binary operator; higher binds tighter.
const precedence: Readonly<
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

/** Binding power of a binary operator (2 to 12), or undefined for others. */
export const precedenceOf = (operator: string): number | undefined =>
  Object.prototype.hasOwnProperty.call(precedence, operator)
    ? precedence[operator as keyof typeof precedence]
    : undefined;

const EXPRESSION = 'an expression';

const describe = (tk: Token): string => {
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
      return `string ${tk.raw}`;
    default:
      return `token "${tk.value}"`;
  }
};

/** Throws for the current token, optionally naming what was expected there. */
const fail = (ps: ParserState, expected?: string): never => {
  const tk: Token | undefined =
    ps.tokens[Math.min(ps.pos, ps.tokens.length - 1)];
  const detail =
    !tk || (tk.kind === 'eof' && expected === EXPRESSION)
      ? 'unexpected end of expression'
      : `unexpected ${describe(tk)}${expected ? `, expected ${expected}` : ''}`;
  throw new ExprSyntaxError(formatParseError(ps.src), {
    start: tk?.start ?? 0,
    end: tk?.end ?? 0,
    detail,
    token: tk,
  });
};

const expectPunct = (ps: ParserState, value: string) => {
  if (!isPunct(ps, value)) {
    fail(ps, `"${value}"`);
  }
  next(ps);
};

const mustNode = (ps: ParserState, node: ASTNode | null): ASTNode =>
  node ?? fail(ps, EXPRESSION);

const literal = (tk: Token, value: unknown): LiteralNode => ({
  type: 'Literal',
  value,
  raw: tk.raw,
  start: tk.start,
  end: tk.end,
});

const templateLiteral = (tk: Token): TemplateLiteralNode => {
  const t = tk.template!;
  return {
    type: 'TemplateLiteral',
    quasis: t.quasis,
    rawQuasis: t.rawQuasis,
    // Each interpolation is parsed on its own, keeping positions in the
    // whole source.
    expressions: t.expressionsSrc.map((src, index) =>
      parseTokens(tokenizeAt(src, t.expressionsStart[index]), src),
    ),
    start: tk.start,
    end: tk.end,
  };
};

const parsePrimary = (ps: ParserState): ASTNode | null => {
  const tk = peek(ps);
  if (!tk) {
    return null;
  }
  switch (tk.kind) {
    case 'number':
      next(ps);
      return literal(tk, Number(tk.value));
    case 'string':
      next(ps);
      return literal(tk, tk.value);
    case 'boolean':
      next(ps);
      return literal(tk, tk.value === 'true');
    case 'null':
      next(ps);
      return literal(tk, null);
    case 'undefined':
      next(ps);
      return literal(tk, undefined);
    case 'identifier':
      next(ps);
      return {
        type: 'Identifier',
        name: tk.value,
        start: tk.start,
        end: tk.end,
      };
    case 'template':
      next(ps);
      return templateLiteral(tk);
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

// `...expr` in an array or object literal; the `...` is the current token.
const parseSpread = (ps: ParserState): SpreadElement => {
  const start = next(ps).start;
  const argument = mustNode(ps, parseExpression(ps));
  return { type: 'SpreadElement', argument, start, end: lastEnd(ps) };
};

const parseArray = (ps: ParserState): ASTNode => {
  const start = peek(ps).start;
  expectPunct(ps, '[');
  const elements: Array<ASTNode | SpreadElement> = [];
  while (!eof(ps) && !isPunct(ps, ']')) {
    if (isPunct(ps, ',')) {
      const comma = next(ps);
      elements.push({ type: 'Elision', start: comma.start, end: comma.end });
      continue;
    }
    if (isOp(ps, '...')) {
      elements.push(parseSpread(ps));
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
  return { type: 'ArrayExpression', elements, start, end: lastEnd(ps) };
};

const parseObject = (ps: ParserState): ASTNode => {
  const start = peek(ps).start;
  expectPunct(ps, '{');
  const properties: Array<
    ObjectProperty | ComputedObjectProperty | SpreadElement
  > = [];
  while (!eof(ps) && !isPunct(ps, '}')) {
    const first = peek(ps);
    if (isOp(ps, '...')) {
      // support spread in object literal: ...expr
      properties.push(parseSpread(ps));
    } else if (isPunct(ps, '[')) {
      // computed key: { [expr]: value }
      next(ps);
      const key = mustNode(ps, parseExpression(ps));
      expectPunct(ps, ']');
      expectPunct(ps, ':');
      const value = mustNode(ps, parseExpression(ps));
      properties.push({
        key,
        computed: true,
        value,
        start: first.start,
        end: lastEnd(ps),
      });
    } else {
      if (!isIdentifierName(first) && first?.kind !== 'string') {
        fail(ps, 'a property name');
      }
      next(ps);
      const key = first.value;
      let value: ASTNode;
      if (isPunct(ps, ':')) {
        next(ps);
        value = mustNode(ps, parseExpression(ps));
      } else {
        // shorthand property: { a } is short for { a: a }, and only a plain
        // identifier can stand in for its own value (matching real JS, where
        // e.g. `in`/`typeof` can be property keys but not shorthand ones).
        if (first.kind !== 'identifier') {
          fail(ps, '":"');
        }
        value = {
          type: 'Identifier',
          name: key,
          start: first.start,
          end: first.end,
        };
      }
      properties.push({ key, value, start: first.start, end: lastEnd(ps) });
    }
    if (isPunct(ps, ',')) {
      next(ps); // allow trailing comma
    }
  }
  expectPunct(ps, '}');
  return { type: 'ObjectExpression', properties, start, end: lastEnd(ps) };
};

const parsePostfix = (
  ps: ParserState,
  base: ASTNode | null,
): ASTNode | null => {
  let expr = base;
  let optionalChain = false;
  while (expr) {
    const start = expr.start;
    // Tagged template: Identifier/MemberExpression immediately followed by template token
    if (peek(ps)?.kind === 'template') {
      expr = {
        type: 'TaggedTemplateExpression',
        tag: expr,
        quasi: templateLiteral(next(ps)),
        start,
        end: lastEnd(ps),
      };
      continue;
    }

    // Optional chaining: '?.prop', '?.[expr]', '?.(args)'. As in JavaScript,
    // a '?' followed by anything but '.' (including '[' or '(') starts a
    // conditional expression instead.
    let optional = false;
    // whether a property name must follow: after `.`, or `?.` not followed
    // by `[` or `(`
    let dot = false;
    if (isPunct(ps, '?')) {
      const nextTk = ps.tokens[ps.pos + 1];
      if (nextTk?.kind !== 'punct' || nextTk.value !== '.') {
        break;
      }
      next(ps); // consume '?'
      next(ps); // consume '.'
      optionalChain = true;
      optional = true;
      dot = !isPunct(ps, '[') && !isPunct(ps, '(');
    } else if (isPunct(ps, '.')) {
      next(ps);
      dot = true;
    } else if (!isPunct(ps, '[') && !isPunct(ps, '(')) {
      break;
    }

    if (dot) {
      const prop = peek(ps);
      if (!isIdentifierName(prop)) {
        fail(ps, 'a property name');
      }
      next(ps);
      const property = literal(prop, prop.value);
      expr = optional
        ? {
            type: 'MemberExpression',
            object: expr,
            property,
            computed: false,
            optional,
            start,
            end: prop.end,
          }
        : {
            type: 'MemberExpression',
            object: expr,
            property,
            computed: false,
            start,
            end: prop.end,
          };
    } else if (isPunct(ps, '[')) {
      next(ps);
      const property = mustNode(ps, parseExpression(ps));
      expectPunct(ps, ']');
      const end = lastEnd(ps);
      expr = optional
        ? {
            type: 'MemberExpression',
            object: expr,
            property,
            computed: true,
            optional,
            start,
            end,
          }
        : {
            type: 'MemberExpression',
            object: expr,
            property,
            computed: true,
            start,
            end,
          };
    } else {
      next(ps); // '('
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
      const end = lastEnd(ps);
      expr = optional
        ? { type: 'CallExpression', callee: expr, args, optional, start, end }
        : { type: 'CallExpression', callee: expr, args, start, end };
    }
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

// Whether the `(` at the current token opens an arrow's parameter list.
const isParenthesizedParams = (ps: ParserState) => {
  const close = findMatchingParenEnd(ps.tokens, ps.pos);
  return close !== -1 && isArrowToken(ps.tokens[close + 1]);
};

const parseParamDefault = (ps: ParserState): ASTNode | undefined => {
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
  ps: ParserState,
  nameTk: Token,
): IdentifierParam => ({
  kind: 'identifier',
  name: nameTk.value,
  default: parseParamDefault(ps),
  start: nameTk.start,
  end: lastEnd(ps),
});

const consumeIdentifierName = (ps: ParserState): Token => {
  const tk = peek(ps);
  if (tk?.kind !== 'identifier') {
    fail(ps, 'an identifier');
  }
  next(ps);
  return tk;
};

const parseIdentifierParam = (ps: ParserState): IdentifierParam =>
  parseDefaultedIdentifier(ps, consumeIdentifierName(ps));

// One level of destructuring only: each property/element binds a plain
// (optionally renamed, optionally defaulted) identifier, never another
// nested pattern — matching the restriction the macro-transformer already
// enforces when down-leveling TypeScript source into this DSL.
const parseObjectPatternParam = (ps: ParserState): ObjectPatternParam => {
  const start = peek(ps).start;
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
    properties.push({
      key: keyTk.value,
      value: parseDefaultedIdentifier(ps, bindingTk),
      start: keyTk.start,
      end: lastEnd(ps),
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
    start,
    end: lastEnd(ps),
  };
};

const parseArrayPatternParam = (ps: ParserState): ArrayPatternParam => {
  const start = peek(ps).start;
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
    start,
    end: lastEnd(ps),
  };
};

const parseArrowParam = (ps: ParserState): ArrowParam => {
  if (isOp(ps, '...')) {
    const start = next(ps).start;
    const name = consumeIdentifierName(ps).value;
    return { kind: 'rest', name, start, end: lastEnd(ps) };
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
const tryParseArrowFunction = (ps: ParserState): ASTNode | null => {
  const tk = peek(ps);
  let params: ArrowParam[];
  if (tk?.kind === 'identifier' && isArrowToken(ps.tokens[ps.pos + 1])) {
    next(ps); // identifier
    params = [
      { kind: 'identifier', name: tk.value, start: tk.start, end: tk.end },
    ];
  } else if (isPunct(ps, '(') && isParenthesizedParams(ps)) {
    next(ps); // '('
    params = [];
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
  } else {
    return null;
  }
  next(ps); // '=>'
  const body = mustNode(ps, parseExpression(ps));
  return {
    type: 'ArrowFunctionExpression',
    params,
    body,
    start: tk.start,
    end: lastEnd(ps),
  };
};

const parseUnary = (ps: ParserState): ASTNode | null => {
  const tk = peek(ps);
  if (!tk) {
    return null;
  }
  if (tk.kind === 'operator' && prefixOps.has(tk.value)) {
    next(ps);
    const argument = mustNode(ps, parseUnary(ps));
    return {
      type: 'UnaryExpression',
      operator: tk.value as UnaryNode['operator'],
      argument,
      start: tk.start,
      end: lastEnd(ps),
    };
  }
  // Arrow functions have lower precedence than everything else and are never
  // postfixed directly (`x => x` can't be called without wrapping parens,
  // just like real JS), so this returns straight from the arrow branch.
  return tryParseArrowFunction(ps) ?? parsePostfix(ps, parsePrimary(ps));
};

const parseBinaryRHS = (
  ps: ParserState,
  minPrec: number,
  left: ASTNode,
): ASTNode => {
  let lhs = left;
  while (!eof(ps) && peek(ps).kind === 'operator') {
    const opTk = peek(ps);
    const prec = precedenceOf(opTk.value);
    if (prec === undefined || prec < minPrec) {
      break;
    }
    next(ps);
    let rhs = mustNode(ps, parseUnary(ps));
    // `**` is right-associative; tighter operators bind into the right side.
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
    const operator = opTk.value;
    const start = lhs.start;
    const end = lastEnd(ps);
    lhs = isLogicalOperator(operator)
      ? {
          type: 'LogicalExpression',
          operator,
          left: lhs,
          right: rhs,
          start,
          end,
        }
      : {
          type: 'BinaryExpression',
          operator: operator as BinaryNode['operator'],
          left: lhs,
          right: rhs,
          start,
          end,
        };
  }
  return lhs;
};

const parseConditional = (ps: ParserState, test: ASTNode): ASTNode => {
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
    end: lastEnd(ps),
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

const parseTokens = (tokens: Token[], src: string): ASTNode => {
  const ps: ParserState = { tokens, pos: 0, src };
  const node = mustNode(ps, parseExpression(ps));
  if (!eof(ps)) {
    fail(ps);
  }
  return node;
};

/**
 * Parses the tokens of `src` (from `tokenize(src)`). Throws `ExprSyntaxError`
 * unless they form exactly one expression.
 */
export const parse = (tokens: Token[], src: string): ASTNode =>
  parseTokens(tokens, src);

export type ParseResult =
  { ok: true; ast: ASTNode } | { ok: false; error: ExprSyntaxError };

/**
 * Tokenizes and parses `input` without throwing for invalid syntax: the
 * result holds either the AST or the `ExprSyntaxError` that `parse()` would
 * have thrown, with its `start`/`end` range and `detail`.
 */
export const tryParse = (input: string): ParseResult => {
  try {
    return { ok: true, ast: parseTokens(tokenize(input), input) };
  } catch (error) {
    if (error instanceof ExprSyntaxError) {
      return { ok: false, error };
    }
    throw error;
  }
};
