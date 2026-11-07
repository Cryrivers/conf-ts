import { keywordKinds } from './lexer';
import { precedence as BINARY_PRECEDENCE } from './parser';
import type {
  ArrayNode,
  ArrowFunctionNode,
  ArrowParam,
  ASTNode,
  BinaryNode,
  IdentifierParam,
  LogicalNode,
  MemberNode,
  ObjectNode,
  SpreadElement,
  TemplateLiteralNode,
} from './types';

export interface PrintOptions {
  /** Quote character for string literals. Defaults to `'double'`. */
  quote?: 'double' | 'single';
}

// How tightly each printed form binds; an operand that binds more loosely
// than its position requires is parenthesized. Binary operators use the
// parser's levels, 2 (`||`, `??`) to 12 (`**`).
const ASSIGNMENT = 1; // arrow functions and conditional expressions
const SHORT_CIRCUIT = 2; // the lowest binary level, `||` and `??`
const MULTIPLICATIVE = 11;
const EXPONENT = 12;
const UNARY = 13;
const POSTFIX = 14; // member access, calls, tagged templates
const PRIMARY = 15;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DIGITS = /^\d+$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const UNARY_OPERATORS = new Set([
  '+',
  '-',
  '!',
  '~',
  'void',
  'delete',
  'typeof',
]);
const LOGICAL_OPERATORS = new Set(['&&', '||', '??']);

const hasOwn = (object: object, key: string) =>
  Object.prototype.hasOwnProperty.call(object, key);

const invalid = (message: string): never => {
  throw new TypeError(`print(): ${message}`);
};

/** A name that can be referenced or bound: not a keyword. */
const isBindingName = (name: unknown): name is string =>
  typeof name === 'string' && IDENTIFIER.test(name) && !keywordKinds.has(name);

/**
 * A name usable after `.` or as a bare object key. The parser also accepts
 * the operator keywords there (`a.in`), but not `true`, `false`, `null`, or
 * `undefined`, which lex as literals.
 */
const isPropertyName = (name: unknown): name is string =>
  typeof name === 'string' &&
  IDENTIFIER.test(name) &&
  (keywordKinds.get(name) ?? 'operator') === 'operator';

const bindingName = (name: unknown): string =>
  isBindingName(name)
    ? name
    : invalid(`${JSON.stringify(name)} is not a valid identifier`);

const hex4 = (code: number) => `\\u${`000${code.toString(16)}`.slice(-4)}`;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// Escapes only what the lexer needs, plus anything invisible or that would
// make the output ill-formed (control characters, line/paragraph
// separators, lone surrogates). The lexer has no `\b` or `\0` escapes, so
// those, like other control characters, are written as `\uXXXX`.
const printString = (value: string, quote: string): string => {
  let out = quote;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (ch === quote || ch === '\\') {
      out += `\\${ch}`;
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (ch === '\v') {
      out += '\\v';
    } else if (ch === '\f') {
      out += '\\f';
    } else if (
      code < 0x20 ||
      code === 0x7f ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      out += hex4(code);
    } else if (isHighSurrogate(code)) {
      const low = value.charCodeAt(i + 1);
      if (isLowSurrogate(low)) {
        out += value.slice(i, i + 2);
        i++;
      } else {
        out += hex4(code);
      }
    } else if (isLowSurrogate(code)) {
      out += hex4(code);
    } else {
      out += ch;
    }
  }
  return out + quote;
};

// Numbers the grammar has no literal for are written as equivalent
// expressions, e.g. `-1` as a unary minus and NaN as `0 / 0`.
const printNumber = (value: number): string => {
  if (Number.isNaN(value)) {
    return '0 / 0';
  }
  if (value === Infinity) {
    return '1 / 0';
  }
  if (value === -Infinity) {
    return '-1 / 0';
  }
  if (Object.is(value, -0)) {
    return '-0';
  }
  return value < 0 ? `-${String(-value)}` : String(value);
};

const numberPrecedence = (value: number): number =>
  !Number.isFinite(value)
    ? MULTIPLICATIVE
    : value < 0 || Object.is(value, -0)
      ? UNARY
      : PRIMARY;

const precedenceOf = (node: ASTNode): number => {
  switch (node.type) {
    case 'ArrowFunctionExpression':
    case 'ConditionalExpression':
      return ASSIGNMENT;
    case 'BinaryExpression':
    case 'LogicalExpression':
      return hasOwn(BINARY_PRECEDENCE, node.operator)
        ? BINARY_PRECEDENCE[node.operator]
        : PRIMARY; // rejected when printed
    case 'UnaryExpression':
      return UNARY;
    case 'MemberExpression':
    case 'CallExpression':
    case 'TaggedTemplateExpression':
    case 'ChainExpression':
      return POSTFIX;
    case 'Literal':
      return typeof node.value === 'number'
        ? numberPrecedence(node.value)
        : PRIMARY;
    default:
      return PRIMARY;
  }
};

// Whether a raw template chunk can be printed verbatim between backticks:
// every escape is complete (and its `\u` has 4 hex digits), and there is no
// unescaped backtick or `${`.
const isTemplateRaw = (raw: unknown): raw is string => {
  if (typeof raw !== 'string') {
    return false;
  }
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      if (i + 1 >= raw.length) {
        return false;
      }
      if (raw[i + 1] === 'u' && !HEX4.test(raw.slice(i + 2, i + 6))) {
        return false;
      }
      i++;
    } else if (ch === '`' || (ch === '$' && raw[i + 1] === '{')) {
      return false;
    }
  }
  return true;
};

class Printer {
  constructor(private readonly quote: string) {}

  /** `node` as an operand that must bind at least as tightly as `level`. */
  operand(node: ASTNode, level: number, parenthesize = false): string {
    const text = this.node(node);
    return parenthesize || precedenceOf(node) < level ? `(${text})` : text;
  }

  node(node: ASTNode): string {
    if (node === null || typeof node !== 'object') {
      return invalid(`expected an AST node, got ${String(node)}`);
    }
    switch (node.type) {
      case 'Literal':
        return this.literal(node.value);
      case 'Identifier':
        return bindingName(node.name);
      case 'Elision':
        return invalid('an Elision can only be an ArrayExpression element');
      case 'ParenthesizedExpression':
        return `(${this.node(node.expression)})`;
      case 'ChainExpression':
        // The `?.` links inside mark the chain; see `postfixBase`.
        return this.node(node.expression);
      case 'UnaryExpression': {
        const { operator } = node;
        if (!UNARY_OPERATORS.has(operator)) {
          return invalid(`unknown unary operator ${JSON.stringify(operator)}`);
        }
        const argument = this.operand(node.argument, UNARY);
        // Keep `- -a` from reading as `--a`, and words apart: `typeof a`.
        const space =
          IDENTIFIER.test(operator) ||
          ((operator === '+' || operator === '-') &&
            argument.startsWith(operator));
        return `${operator}${space ? ' ' : ''}${argument}`;
      }
      case 'BinaryExpression':
      case 'LogicalExpression':
        return this.binary(node);
      case 'ConditionalExpression':
        return `${this.operand(node.test, SHORT_CIRCUIT)} ? ${this.operand(node.consequent, ASSIGNMENT)} : ${this.operand(node.alternate, ASSIGNMENT)}`;
      case 'MemberExpression':
        return this.member(node);
      case 'CallExpression': {
        const callee = this.postfixBase(node.callee, false);
        const args = node.args.map(arg => this.operand(arg, ASSIGNMENT));
        return `${callee}${node.optional ? '?.' : ''}(${args.join(', ')})`;
      }
      case 'ArrayExpression':
        return this.array(node);
      case 'ObjectExpression':
        return this.object(node);
      case 'TemplateLiteral':
        return this.template(node);
      case 'TaggedTemplateExpression': {
        const { quasi } = node;
        if (quasi?.type !== 'TemplateLiteral') {
          return invalid('a tagged template needs a TemplateLiteral quasi');
        }
        return `${this.postfixBase(node.tag, false)}${this.template(quasi)}`;
      }
      case 'ArrowFunctionExpression':
        return this.arrow(node);
      default:
        return invalid(
          `unknown node type ${JSON.stringify((node as { type?: unknown }).type)}`,
        );
    }
  }

  literal(value: unknown): string {
    if (value === undefined) {
      return 'undefined';
    }
    if (value === null || typeof value === 'boolean') {
      return String(value);
    }
    if (typeof value === 'string') {
      return printString(value, this.quote);
    }
    if (typeof value === 'number') {
      return printNumber(value);
    }
    return invalid(`a Literal can't hold a ${typeof value} value`);
  }

  binary(node: BinaryNode | LogicalNode): string {
    const { operator } = node;
    const isLogical = node.type === 'LogicalExpression';
    if (
      !hasOwn(BINARY_PRECEDENCE, operator) ||
      isLogical !== LOGICAL_OPERATORS.has(operator)
    ) {
      return invalid(
        `unknown ${isLogical ? 'logical' : 'binary'} operator ${JSON.stringify(operator)}`,
      );
    }
    const level = BINARY_PRECEDENCE[operator];
    // JavaScript rejects `??` next to an unparenthesized `&&` or `||`.
    const mixesNullish = (child: ASTNode) =>
      isLogical &&
      child.type === 'LogicalExpression' &&
      (operator === '??') !== (child.operator === '??');
    // `**` is right-associative and its base can't be a unary expression:
    // `(-a) ** b`, `(a ** b) ** c`, but `a ** b ** c` and `a ** -b`.
    const left = this.operand(
      node.left,
      operator === '**' ? POSTFIX : level,
      mixesNullish(node.left),
    );
    const right = this.operand(
      node.right,
      operator === '**' ? EXPONENT : level + 1,
      mixesNullish(node.right),
    );
    return `${left} ${operator} ${right}`;
  }

  /**
   * The object of a member access, callee, or tag. A chain containing `?.`
   * keeps its parentheses there, since `(a?.b).c` doesn't short-circuit `.c`
   * like `a?.b.c` does, and so does an integer before `.` (`(1).toFixed()`).
   */
  postfixBase(node: ASTNode, beforeDot: boolean): string {
    const text = this.operand(
      node,
      POSTFIX,
      node.type === 'ChainExpression',
    );
    return beforeDot && node.type === 'Literal' && DIGITS.test(text)
      ? `(${text})`
      : text;
  }

  member(node: MemberNode): string {
    const optional = node.optional ? '?.' : '';
    if (node.computed) {
      const object = this.postfixBase(node.object, false);
      return `${object}${optional}[${this.node(node.property)}]`;
    }
    const { property } = node;
    if (property?.type !== 'Literal') {
      return invalid(
        'the property of a non-computed MemberExpression must be a Literal',
      );
    }
    const key = String(property.value);
    if (!isPropertyName(key)) {
      // e.g. `a["x-y"]`, or `a["true"]`, which can't follow a dot
      const object = this.postfixBase(node.object, false);
      return `${object}${optional}[${printString(key, this.quote)}]`;
    }
    return `${this.postfixBase(node.object, true)}${optional || '.'}${key}`;
  }

  // A spread or element in an array, argument list position, or property.
  element(node: ASTNode | SpreadElement): string {
    return (node as SpreadElement).type === 'SpreadElement'
      ? `...${this.operand((node as SpreadElement).argument, ASSIGNMENT)}`
      : this.operand(node as ASTNode, ASSIGNMENT);
  }

  array(node: ArrayNode): string {
    const { elements } = node;
    const items = elements.map(element =>
      element.type === 'Elision' ? '' : this.element(element),
    );
    // A trailing hole needs its own comma: `[a, ,]` has length 2.
    const trailingHole = elements[elements.length - 1]?.type === 'Elision';
    return `[${items.join(', ')}${trailingHole ? ',' : ''}]`;
  }

  object(node: ObjectNode): string {
    const properties = node.properties.map(property => {
      if ((property as SpreadElement).type === 'SpreadElement') {
        return this.element(property as SpreadElement);
      }
      if (!('key' in property)) {
        return invalid('expected an object property');
      }
      const value = this.operand(property.value, ASSIGNMENT);
      if (property.computed) {
        return `[${this.node(property.key)}]: ${value}`;
      }
      const { key } = property;
      if (typeof key !== 'string') {
        return invalid('a non-computed object property key must be a string');
      }
      if (
        property.value.type === 'Identifier' &&
        property.value.name === key &&
        isBindingName(key)
      ) {
        return key; // shorthand: `{a}`
      }
      const name = isPropertyName(key) ? key : printString(key, this.quote);
      return `${name}: ${value}`;
    });
    return `{${properties.join(', ')}}`;
  }

  // Printed from `rawQuasis`, the chunks' source text, as a tag function
  // receives them; `quasis` (their cooked values) aren't consulted.
  template(node: TemplateLiteralNode): string {
    const { rawQuasis, expressions } = node;
    if (
      !Array.isArray(rawQuasis) ||
      !Array.isArray(expressions) ||
      rawQuasis.length !== expressions.length + 1
    ) {
      return invalid(
        'a TemplateLiteral needs one more raw quasi than expressions',
      );
    }
    let out = '`';
    rawQuasis.forEach((raw, index) => {
      if (!isTemplateRaw(raw)) {
        return invalid(
          `${JSON.stringify(raw)} isn't valid raw template literal text`,
        );
      }
      out += raw;
      if (index < expressions.length) {
        out += `\${${this.node(expressions[index])}}`;
      }
    });
    return `${out}\``;
  }

  param(param: ArrowParam): string {
    const withDefault = (text: string, value: ASTNode | undefined) =>
      value === undefined
        ? text
        : `${text} = ${this.operand(value, ASSIGNMENT)}`;
    const binding = (element: IdentifierParam) =>
      withDefault(bindingName(element.name), element.default);
    switch (param.kind) {
      case 'identifier':
        return binding(param);
      case 'rest':
        return `...${bindingName(param.name)}`;
      case 'object': {
        const properties = param.properties.map(({ key, value }) => {
          if (key === value.name) {
            return binding(value); // shorthand: `{a}` or `{a = 1}`
          }
          if (!isPropertyName(key)) {
            return invalid(
              `${JSON.stringify(key)} can't be an object pattern key`,
            );
          }
          return `${key}: ${binding(value)}`;
        });
        return withDefault(`{${properties.join(', ')}}`, param.default);
      }
      case 'array': {
        const { elements } = param;
        const items = elements.map(element =>
          element === null ? '' : binding(element),
        );
        const trailingHole =
          elements.length > 0 && elements[elements.length - 1] === null;
        return withDefault(
          `[${items.join(', ')}${trailingHole ? ',' : ''}]`,
          param.default,
        );
      }
      default:
        return invalid(
          `unknown parameter kind ${JSON.stringify((param as { kind?: unknown }).kind)}`,
        );
    }
  }

  arrow(node: ArrowFunctionNode): string {
    const { params } = node;
    params.forEach((param, index) => {
      if (param.kind === 'rest' && index !== params.length - 1) {
        invalid('a rest parameter must be the last parameter');
      }
    });
    const [first] = params;
    const head =
      params.length === 1 &&
      first.kind === 'identifier' &&
      first.default === undefined
        ? this.param(first)
        : `(${params.map(param => this.param(param)).join(', ')})`;
    // A body starting with `{` would read as a block in JavaScript.
    const body = this.operand(node.body, ASSIGNMENT);
    return `${head} => ${body.startsWith('{') ? `(${body})` : body}`;
  }
}

/**
 * Prints an AST as expression source text that `parse()` reads back as the
 * same tree, give or take parentheses. `ParenthesizedExpression` nodes are
 * kept; otherwise parentheses are added only where precedence, associativity,
 * or an optional chain's extent requires them, or where JavaScript would
 * misread the text (`??` mixed with `&&`/`||`, a unary base of `**`, an arrow
 * body starting with `{`). Source positions and `Literal.raw` are ignored.
 *
 * Throws a `TypeError` for a tree that has no source form, e.g. an invalid
 * identifier name or a `Literal` holding an object.
 */
export const print = (node: ASTNode, options?: PrintOptions): string =>
  new Printer(options?.quote === 'single' ? "'" : '"').node(node);
