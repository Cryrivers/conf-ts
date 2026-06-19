import { raiseParseError } from './errors';
import { tokenize } from './lexer';
import type { ASTNode, BinaryNode, LogicalNode, ObjectProperty, SpreadElement, Token, UnaryNode } from './types';

export interface ParserState {
  tokens: Token[];
  pos: number;
  src: string;
}

const createParser = (tokens: Token[], src: string): ParserState => ({ tokens, pos: 0, src });

const peek = (ps: ParserState) => ps.tokens[ps.pos];
const next = (ps: ParserState) => ps.tokens[ps.pos++];
const eof = (ps: ParserState) => peek(ps)?.kind === 'eof';

const isPunct = (ps: ParserState, value: string) => peek(ps)?.kind === 'punct' && peek(ps)?.value === value;
const isOp = (ps: ParserState, value?: string) =>
  peek(ps)?.kind === 'operator' && (value ? peek(ps)?.value === value : true);

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
    const exprAsts = t.expressionsSrc.map((src) => {
      const subTokens = tokenize(src);
      const subAst = parse(subTokens, src);
      if (!subAst) {
        raiseParseError(src);
      }
      return subAst as ASTNode;
    });
    return { type: 'TemplateLiteral', quasis: t.quasis, rawQuasis: t.rawQuasis, expressions: exprAsts };
  }
  if (isPunct(ps, '(')) {
    next(ps);
    const e = parseExpression(ps);
    expectPunct(ps, ')');
    return e ?? { type: 'Literal', value: undefined };
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
  const elements: ASTNode[] = [];
  while (!eof(ps) && !isPunct(ps, ']')) {
    const el = parseExpression(ps);
    if (el) {
      elements.push(el);
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
  const properties: Array<ObjectProperty | SpreadElement> = [];
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

    const keyTk = peek(ps);
    if (!keyTk || (keyTk.kind !== 'identifier' && keyTk.kind !== 'string')) {
      raiseParseError(ps.src);
    }
    next(ps);
    const key = keyTk.value;
    if (!isPunct(ps, ':')) {
      raiseParseError(ps.src);
    }
    next(ps);
    const value = mustNode(ps, parseExpression(ps));
    properties.push({ key, value });
    if (isPunct(ps, ',')) {
      next(ps); // allow trailing comma
    } else {
      // continue until '}' or error
      if (!isPunct(ps, '}')) {
        // if next is not closing brace and not comma, it's an error
        // but we let loop handle it
      }
    }
  }
  expectPunct(ps, '}');
  return { type: 'ObjectExpression', properties };
};

const parsePostfix = (ps: ParserState, base: ASTNode | null): ASTNode | null => {
  let expr = base;
  while (expr) {
    // Tagged template: Identifier/MemberExpression immediately followed by template token
    if (peek(ps)?.kind === 'template') {
      const tk = next(ps);
      const t = tk.template!;
      const exprAsts = t.expressionsSrc.map((src) => {
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
          expr = { type: 'MemberExpression', object: expr, property: propExpr, computed: true, optional: true };
          continue;
        }
        // Otherwise, expect identifier for '?.prop'
        const prop = peek(ps);
        if (!prop || prop.kind !== 'identifier') {
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
        expr = { type: 'MemberExpression', object: expr, property: propExpr, computed: true, optional: true };
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
      if (!prop || prop.kind !== 'identifier') {
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
      expr = { type: 'MemberExpression', object: expr, property: propExpr, computed: true };
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
  return expr;
};

const prefixOps = new Set(['+', '-', '!']);

const parseUnary = (ps: ParserState): ASTNode | null => {
  const tk = peek(ps);
  if (!tk) {
    return null;
  }
  if (tk.kind === 'operator' && prefixOps.has(tk.value)) {
    next(ps);
    const arg = mustNode(ps, parseUnary(ps));
    return { type: 'UnaryExpression', operator: tk.value as UnaryNode['operator'], argument: arg };
  }
  const primary = parsePrimary(ps);
  return parsePostfix(ps, primary);
};

const precedence: Record<string, number> = {
  '*': 7,
  '/': 7,
  '%': 7,
  '+': 6,
  '-': 6,
  '>': 5,
  '<': 5,
  '>=': 5,
  '<=': 5,
  '==': 4,
  '!=': 4,
  '===': 4,
  '!==': 4,
  '&&': 3,
  '||': 2,
  '??': 2,
};

const parseBinaryRHS = (ps: ParserState, minPrec: number, left: ASTNode): ASTNode => {
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
      if (nextPrec !== undefined && nextPrec > prec) {
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
