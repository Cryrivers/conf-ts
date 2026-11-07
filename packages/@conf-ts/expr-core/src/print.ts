import { HEX4, isIdentifierText, keywordKinds } from './lexer';
import { isLogicalOperator, precedenceOf, prefixOps } from './parser';
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

/** Printed text and how tightly it binds. */
type Printed = [text: string, level: number];

const invalid = (message: string): never => {
  throw new TypeError(`print(): ${message}`);
};

/** A name that can be referenced or bound: not a keyword. */
const isBindingName = (name: unknown): name is string =>
  typeof name === 'string' && isIdentifierText(name) && !keywordKinds.has(name);

/**
 * A name usable after `.` or as a bare object key. The parser also accepts
 * the operator keywords there (`a.in`), but not `true`, `false`, `null`, or
 * `undefined`, which lex as literals.
 */
const isPropertyName = (name: unknown): name is string =>
  typeof name === 'string' &&
  isIdentifierText(name) &&
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
const printNumber = (value: number): Printed => {
  if (Number.isNaN(value)) {
    return ['0 / 0', MULTIPLICATIVE];
  }
  if (value === Infinity) {
    return ['1 / 0', MULTIPLICATIVE];
  }
  if (value === -Infinity) {
    return ['-1 / 0', MULTIPLICATIVE];
  }
  if (Object.is(value, -0)) {
    return ['-0', UNARY];
  }
  return [String(value), value < 0 ? UNARY : PRIMARY];
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

const isSpread = (node: ASTNode | SpreadElement): node is SpreadElement =>
  node.type === 'SpreadElement';

class Printer {
  constructor(private readonly quote: string) {}

  /** `node` as an operand that must bind at least as tightly as `level`. */
  operand(node: ASTNode, level: number, parenthesize = false): string {
    const [text, own] = this.print(node);
    return parenthesize || own < level ? `(${text})` : text;
  }

  print(node: ASTNode): Printed {
    if (node === null || typeof node !== 'object') {
      return invalid(`expected an AST node, got ${String(node)}`);
    }
    switch (node.type) {
      case 'Literal':
        return this.literal(node.value);
      case 'Identifier':
        return [bindingName(node.name), PRIMARY];
      case 'Elision':
        return invalid('an Elision can only be an ArrayExpression element');
      case 'ParenthesizedExpression':
        return [`(${this.print(node.expression)[0]})`, PRIMARY];
      case 'ChainExpression':
        // The `?.` links inside mark the chain; see `postfixBase`.
        return [this.print(node.expression)[0], POSTFIX];
      case 'UnaryExpression': {
        const { operator } = node;
        if (!prefixOps.has(operator)) {
          return invalid(`unknown unary operator ${JSON.stringify(operator)}`);
        }
        const argument = this.operand(node.argument, UNARY);
        // Keep `- -a` from reading as `--a`, and words apart: `typeof a`.
        const space =
          isIdentifierText(operator) ||
          ((operator === '+' || operator === '-') &&
            argument.startsWith(operator));
        return [`${operator}${space ? ' ' : ''}${argument}`, UNARY];
      }
      case 'BinaryExpression':
      case 'LogicalExpression':
        return this.binary(node);
      case 'ConditionalExpression':
        return [
          `${this.operand(node.test, SHORT_CIRCUIT)} ? ${this.operand(node.consequent, ASSIGNMENT)} : ${this.operand(node.alternate, ASSIGNMENT)}`,
          ASSIGNMENT,
        ];
      case 'MemberExpression':
        return [this.member(node), POSTFIX];
      case 'CallExpression': {
        const callee = this.postfixBase(node.callee, false);
        const args = node.args.map(arg => this.operand(arg, ASSIGNMENT));
        const optional = node.optional ? '?.' : '';
        return [`${callee}${optional}(${args.join(', ')})`, POSTFIX];
      }
      case 'ArrayExpression':
        return [this.array(node), PRIMARY];
      case 'ObjectExpression':
        return [this.object(node), PRIMARY];
      case 'TemplateLiteral':
        return [this.template(node), PRIMARY];
      case 'TaggedTemplateExpression': {
        const { quasi } = node;
        if (quasi?.type !== 'TemplateLiteral') {
          return invalid('a tagged template needs a TemplateLiteral quasi');
        }
        const tag = this.postfixBase(node.tag, false);
        return [`${tag}${this.template(quasi)}`, POSTFIX];
      }
      case 'ArrowFunctionExpression':
        return [this.arrow(node), ASSIGNMENT];
      default:
        return invalid(
          `unknown node type ${JSON.stringify((node as { type?: unknown }).type)}`,
        );
    }
  }

  literal(value: unknown): Printed {
    if (value === undefined || value === null || typeof value === 'boolean') {
      return [String(value), PRIMARY];
    }
    if (typeof value === 'string') {
      return [printString(value, this.quote), PRIMARY];
    }
    if (typeof value === 'number') {
      return printNumber(value);
    }
    return invalid(`a Literal can't hold a ${typeof value} value`);
  }

  binary(node: BinaryNode | LogicalNode): Printed {
    const { operator } = node;
    const level = precedenceOf(operator);
    const isLogical = node.type === 'LogicalExpression';
    if (level === undefined || isLogical !== isLogicalOperator(operator)) {
      return invalid(
        `unknown ${isLogical ? 'logical' : 'binary'} operator ${JSON.stringify(operator)}`,
      );
    }
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
    return [`${left} ${operator} ${right}`, level];
  }

  /**
   * The object of a member access, callee, or tag. A chain containing `?.`
   * keeps its parentheses there, since `(a?.b).c` doesn't short-circuit `.c`
   * like `a?.b.c` does, and so does an integer before `.` (`(1).toFixed()`).
   */
  postfixBase(node: ASTNode, beforeDot: boolean): string {
    const text = this.operand(node, POSTFIX, node.type === 'ChainExpression');
    return beforeDot && node.type === 'Literal' && /^\d+$/.test(text)
      ? `(${text})`
      : text;
  }

  member(node: MemberNode): string {
    const optional = node.optional ? '?.' : '';
    if (node.computed) {
      const object = this.postfixBase(node.object, false);
      return `${object}${optional}[${this.print(node.property)[0]}]`;
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

  // An element of an array literal or an entry of an object literal.
  element(node: ASTNode | SpreadElement): string {
    return isSpread(node)
      ? `...${this.operand(node.argument, ASSIGNMENT)}`
      : this.operand(node, ASSIGNMENT);
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
      if ('type' in property) {
        return this.element(property);
      }
      const value = this.operand(property.value, ASSIGNMENT);
      if (property.computed) {
        return `[${this.print(property.key)[0]}]: ${value}`;
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
        invalid(`${JSON.stringify(raw)} isn't valid raw template literal text`);
      }
      out += raw;
      if (index < expressions.length) {
        out += `\${${this.print(expressions[index])[0]}}`;
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
 * body starting with `{`). The output targets this package's grammar, so it
 * is valid JavaScript only as far as the two agree (e.g. `this` is an
 * ordinary name here). Source positions and `Literal.raw` are ignored.
 *
 * Throws a `TypeError` for a tree that has no source form, e.g. an invalid
 * identifier name or a `Literal` holding an object.
 */
export const print = (node: ASTNode, options?: PrintOptions): string =>
  new Printer(options?.quote === 'single' ? "'" : '"').print(node)[0];
