import { raiseParseError } from './errors';
import { tokenize } from './lexer';
import type {
  ArrayPatternParam,
  ArrowParam,
  ASTNode,
  BinaryNode,
  ComputedObjectProperty,
  IdentifierParam,
  LogicalNode,
  ObjectPatternParam,
  ObjectPatternProperty,
  ObjectProperty,
  SpreadElement,
  Token,
  UnaryNode,
} from './types';

export interface ParserState {
  tokens: Token[];
  pos: number;
  src: string;
}

const createParser = (tokens: Token[], src: string): ParserState => ({
  tokens,
  pos: 0,
  src,
});

const peek = (ps: ParserState) => ps.tokens[ps.pos];
const next = (ps: ParserState) => ps.tokens[ps.pos++];
const eof = (ps: ParserState) => peek(ps)?.kind === 'eof';

const isPunct = (ps: ParserState, value: string) =>
  peek(ps)?.kind === 'punct' && peek(ps)?.value === value;
const isOp = (ps: ParserState, value?: string) =>
  peek(ps)?.kind === 'operator' && (value ? peek(ps)?.value === value : true);
const isIdentifierName = (token: Token | undefined) =>
  token?.kind === 'identifier' ||
  (token?.kind === 'operator' &&
    ['instanceof', 'in', 'typeof', 'void', 'delete'].includes(token.value));

const expectPunct = (ps: ParserState, value: string) => {
  if (!isPunct(ps, value)) {
    raiseParseError(ps.src);
  }
  next(ps);
};

const mustNode = (ps: ParserState, node: ASTNode | null) => {
  if (!node) {
    raiseParseError(ps.src);
  }
  return node as ASTNode;
};

const parsePrimary = (ps: ParserState): ASTNode | null => {
  const tk = peek(ps);
  if (!tk) {
    return null;
  }
  if (tk.kind === 'number') {
    next(ps);
    return { type: 'Literal', value: Number(tk.value) };
  }
  if (tk.kind === 'string') {
    next(ps);
    return { type: 'Literal', value: tk.value };
  }
  if (tk.kind === 'boolean') {
    next(ps);
    return { type: 'Literal', value: tk.value === 'true' };
  }
  if (tk.kind === 'null') {
    next(ps);
    return { type: 'Literal', value: null };
  }
  if (tk.kind === 'undefined') {
    next(ps);
    return { type: 'Literal', value: undefined };
  }
  if (tk.kind === 'identifier') {
    next(ps);
    return { type: 'Identifier', name: tk.value };
  }
  if (tk.kind === 'template') {
    next(ps);
    const t = tk.template!;
    const exprAsts = t.expressionsSrc.map(src => {
      const subTokens = tokenize(src);
      const subAst = parse(subTokens, src);
      if (!subAst) {
        raiseParseError(src);
      }
      return subAst as ASTNode;
    });
    return {
      type: 'TemplateLiteral',
      quasis: t.quasis,
      rawQuasis: t.rawQuasis,
      expressions: exprAsts,
    };
  }
  if (isPunct(ps, '(')) {
    next(ps);
    const e = parseExpression(ps);
    expectPunct(ps, ')');
    return {
      type: 'ParenthesizedExpression',
      expression: e ?? { type: 'Literal', value: undefined },
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

const parseArray = (ps: ParserState): ASTNode => {
  expectPunct(ps, '[');
  const elements: Array<ASTNode | SpreadElement> = [];
  while (!eof(ps) && !isPunct(ps, ']')) {
    if (isPunct(ps, ',')) {
      elements.push({ type: 'Elision' });
      next(ps);
      continue;
    }
    if (isOp(ps, '...')) {
      next(ps);
      const arg = mustNode(ps, parseExpression(ps));
      elements.push({ type: 'SpreadElement', argument: arg });
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
  return { type: 'ArrayExpression', elements };
};

const parseObject = (ps: ParserState): ASTNode => {
  expectPunct(ps, '{');
  const properties: Array<
    ObjectProperty | ComputedObjectProperty | SpreadElement
  > = [];
  while (!eof(ps) && !isPunct(ps, '}')) {
    // support spread in object literal: ...expr
    if (isOp(ps, '...')) {
      next(ps);
      const arg = mustNode(ps, parseExpression(ps));
      properties.push({ type: 'SpreadElement', argument: arg });
      if (isPunct(ps, ',')) {
        next(ps);
      }
      continue;
    }

    // computed key: { [expr]: value }
    if (isPunct(ps, '[')) {
      next(ps);
      const keyExpr = mustNode(ps, parseExpression(ps));
      if (!isPunct(ps, ']')) {
        raiseParseError(ps.src);
      }
      next(ps);
      if (!isPunct(ps, ':')) {
        raiseParseError(ps.src);
      }
      next(ps);
      const value = mustNode(ps, parseExpression(ps));
      properties.push({ key: keyExpr, computed: true, value });
      if (isPunct(ps, ',')) {
        next(ps);
      }
      continue;
    }

    const keyTk = peek(ps);
    if (!keyTk || (!isIdentifierName(keyTk) && keyTk.kind !== 'string')) {
      raiseParseError(ps.src);
    }
    next(ps);
    const key = keyTk.value;
    if (isPunct(ps, ':')) {
      next(ps);
      const value = mustNode(ps, parseExpression(ps));
      properties.push({ key, value });
    } else {
      // shorthand property: { a } is short for { a: a }, and only a plain
      // identifier can stand in for its own value (matching real JS, where
      // e.g. `in`/`typeof` can be property keys but not shorthand ones).
      if (keyTk.kind !== 'identifier') {
        raiseParseError(ps.src);
      }
      properties.push({ key, value: { type: 'Identifier', name: key } });
    }
    if (isPunct(ps, ',')) {
      next(ps); // allow trailing comma
    }
  }
  expectPunct(ps, '}');
  return { type: 'ObjectExpression', properties };
};

const parsePostfix = (
  ps: ParserState,
  base: ASTNode | null,
): ASTNode | null => {
  let expr = base;
  let optionalChain = false;
  while (expr) {
    // Tagged template: Identifier/MemberExpression immediately followed by template token
    if (peek(ps)?.kind === 'template') {
      const tk = next(ps);
      const t = tk.template!;
      const exprAsts = t.expressionsSrc.map(src => {
        const subTokens = tokenize(src);
        const subAst = parse(subTokens, src);
        if (!subAst) {
          raiseParseError(src);
        }
        return subAst as ASTNode;
      });
      const quasi: ASTNode = {
        type: 'TemplateLiteral',
        quasis: t.quasis,
        rawQuasis: t.rawQuasis,
        expressions: exprAsts,
      } as any;
      expr = { type: 'TaggedTemplateExpression', tag: expr, quasi } as any;
      continue;
    }

    // Optional chaining: '?.', '?[', '?.('
    if (isPunct(ps, '?')) {
      const nextTk = ps.tokens[ps.pos + 1];
      // If '?' is part of conditional (not followed by '.', '[' or '('), stop postfix parsing
      if (
        !nextTk ||
        nextTk.kind !== 'punct' ||
        (nextTk.value !== '.' && nextTk.value !== '[' && nextTk.value !== '(')
      ) {
        break;
      }
      next(ps); // consume '?'
      optionalChain = true;
      if (isPunct(ps, '.')) {
        next(ps); // consume '.'
        // Support '?.[' (optional computed property)
        if (isPunct(ps, '[')) {
          next(ps);
          const propExpr = mustNode(ps, parseExpression(ps));
          if (!isPunct(ps, ']')) {
            raiseParseError(ps.src);
          }
          next(ps);
          expr = {
            type: 'MemberExpression',
            object: expr,
            property: propExpr,
            computed: true,
            optional: true,
          };
          continue;
        }
        // Otherwise, expect identifier for '?.prop'
        const prop = peek(ps);
        if (!isIdentifierName(prop)) {
          raiseParseError(ps.src);
        }
        next(ps);
        expr = {
          type: 'MemberExpression',
          object: expr,
          property: { type: 'Literal', value: prop.value },
          computed: false,
          optional: true,
        };
        continue;
      }
      if (isPunct(ps, '[')) {
        next(ps);
        const propExpr = mustNode(ps, parseExpression(ps));
        if (!isPunct(ps, ']')) {
          raiseParseError(ps.src);
        }
        next(ps);
        expr = {
          type: 'MemberExpression',
          object: expr,
          property: propExpr,
          computed: true,
          optional: true,
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
        expr = { type: 'CallExpression', callee: expr, args, optional: true };
        continue;
      }
    }

    if (isPunct(ps, '.')) {
      next(ps);
      const prop = peek(ps);
      if (!isIdentifierName(prop)) {
        raiseParseError(ps.src);
      }
      next(ps);
      expr = {
        type: 'MemberExpression',
        object: expr,
        property: { type: 'Literal', value: prop.value },
        computed: false,
      };
      continue;
    }
    if (isPunct(ps, '[')) {
      next(ps);
      const propExpr = mustNode(ps, parseExpression(ps));
      if (!isPunct(ps, ']')) {
        raiseParseError(ps.src);
      }
      next(ps);
      expr = {
        type: 'MemberExpression',
        object: expr,
        property: propExpr,
        computed: true,
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
      expr = { type: 'CallExpression', callee: expr, args };
      continue;
    }
    break;
  }
  return expr && optionalChain
    ? { type: 'ChainExpression', expression: expr }
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
  name: string,
): IdentifierParam => ({
  kind: 'identifier',
  name,
  default: parseParamDefault(ps),
});

const consumeIdentifierName = (ps: ParserState): string => {
  const tk = peek(ps);
  if (tk?.kind !== 'identifier') {
    raiseParseError(ps.src);
  }
  next(ps);
  return tk.value;
};

const parseIdentifierParam = (ps: ParserState): IdentifierParam =>
  parseDefaultedIdentifier(ps, consumeIdentifierName(ps));

// One level of destructuring only: each property/element binds a plain
// (optionally renamed, optionally defaulted) identifier, never another
// nested pattern — matching the restriction the macro-transformer already
// enforces when down-leveling TypeScript source into this DSL.
const parseObjectPatternParam = (ps: ParserState): ObjectPatternParam => {
  expectPunct(ps, '{');
  const properties: ObjectPatternProperty[] = [];
  while (!isPunct(ps, '}')) {
    const keyTk = peek(ps);
    if (!isIdentifierName(keyTk)) {
      raiseParseError(ps.src);
    }
    next(ps);
    const key = keyTk.value;
    let bindingName = key;
    if (isPunct(ps, ':')) {
      next(ps);
      bindingName = consumeIdentifierName(ps);
    }
    properties.push({ key, value: parseDefaultedIdentifier(ps, bindingName) });
    if (isPunct(ps, ',')) {
      next(ps);
      continue;
    }
    break;
  }
  expectPunct(ps, '}');
  return { kind: 'object', properties, default: parseParamDefault(ps) };
};

const parseArrayPatternParam = (ps: ParserState): ArrayPatternParam => {
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
  return { kind: 'array', elements, default: parseParamDefault(ps) };
};

const parseArrowParam = (ps: ParserState): ArrowParam => {
  if (isOp(ps, '...')) {
    next(ps);
    const tk = peek(ps);
    if (tk?.kind !== 'identifier') {
      raiseParseError(ps.src);
    }
    next(ps);
    return { kind: 'rest', name: tk.value };
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
  if (tk?.kind === 'identifier' && isArrowToken(ps.tokens[ps.pos + 1])) {
    next(ps); // identifier
    next(ps); // '=>'
    const body = mustNode(ps, parseExpression(ps));
    return {
      type: 'ArrowFunctionExpression',
      params: [{ kind: 'identifier', name: tk.value }],
      body,
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
      return { type: 'ArrowFunctionExpression', params, body };
    }
  }
  return null;
};

const prefixOps = new Set(['+', '-', '!', '~', 'void', 'delete', 'typeof']);

const parseUnary = (ps: ParserState): ASTNode | null => {
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

const precedence: Record<string, number> = {
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

const parseBinaryRHS = (
  ps: ParserState,
  minPrec: number,
  left: ASTNode,
): ASTNode => {
  let lhs = left;
  while (!eof(ps) && peek(ps).kind === 'operator') {
    const opTk = peek(ps);
    const prec = precedence[opTk.value];
    if (prec === undefined || prec < minPrec) {
      break;
    }
    next(ps);
    let rhs = mustNode(ps, parseUnary(ps));
    // handle right-assoc? none here
    while (!eof(ps) && peek(ps).kind === 'operator') {
      const nextPrec = precedence[peek(ps).value];
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
    if (op === '&&' || op === '||' || op === '??') {
      lhs = { type: 'LogicalExpression', operator: op, left: lhs, right: rhs };
    } else {
      lhs = { type: 'BinaryExpression', operator: op, left: lhs, right: rhs };
    }
  }
  return lhs;
};

const parseConditional = (ps: ParserState, test: ASTNode): ASTNode => {
  if (!isPunct(ps, '?')) {
    return test;
  }
  next(ps);
  const consequent = mustNode(ps, parseExpression(ps));
  if (!isPunct(ps, ':')) {
    raiseParseError(ps.src);
  }
  next(ps);
  const alternate = mustNode(ps, parseExpression(ps));
  return { type: 'ConditionalExpression', test, consequent, alternate };
};

export const parseExpression = (ps: ParserState): ASTNode | null => {
  const lhs = parseUnary(ps);
  if (!lhs) {
    return null;
  }
  const rhs = parseBinaryRHS(ps, 1, lhs);
  return parseConditional(ps, rhs);
};

export const parse = (tokens: Token[], src: string): ASTNode | null => {
  const ps = createParser(tokens, src);
  const node = parseExpression(ps);
  if (!node || !eof(ps)) {
    raiseParseError(src);
  }
  return node;
};
