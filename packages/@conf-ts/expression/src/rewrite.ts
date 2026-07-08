import { tokenize } from './ast/lexer';
import { parse } from './ast/parser';
import type { ASTNode, Token } from './ast/types';
import type { QuoteStyle, RewriteContextOptions } from './types';

const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/;

type OutputToken = Pick<Token, 'kind' | 'value'>;

function validatedTokens(source: string): Token[] {
  const tokens = tokenize(source);
  parse(tokens, source);
  return tokens;
}

function validateContextNode(
  node: ASTNode,
  contextName: string,
  contextAccess = false,
): void {
  if (node.type === 'Identifier') {
    if (node.name === contextName && !contextAccess) {
      throw new Error(
        'expr callback cannot use the context parameter directly',
      );
    }
    return;
  }

  switch (node.type) {
    case 'Literal':
    case 'Elision':
      return;
    case 'ParenthesizedExpression':
      validateContextNode(node.expression, contextName);
      return;
    case 'ChainExpression':
      validateContextNode(node.expression, contextName, contextAccess);
      return;
    case 'MemberExpression': {
      if (
        node.object.type === 'Identifier' &&
        node.object.name === contextName &&
        node.computed &&
        node.property.type === 'Literal' &&
        (typeof node.property.value !== 'string' ||
          !IDENTIFIER_RE.test(node.property.value))
      ) {
        throw new Error(
          'expr callback can only access context properties with identifier property names',
        );
      }
      validateContextNode(node.object, contextName, true);
      validateContextNode(node.property, contextName);
      return;
    }
    case 'UnaryExpression':
      validateContextNode(node.argument, contextName);
      return;
    case 'BinaryExpression':
    case 'LogicalExpression':
      validateContextNode(node.left, contextName);
      validateContextNode(node.right, contextName);
      return;
    case 'ConditionalExpression':
      validateContextNode(node.test, contextName);
      validateContextNode(node.consequent, contextName);
      validateContextNode(node.alternate, contextName);
      return;
    case 'CallExpression':
      validateContextNode(node.callee, contextName);
      node.args.forEach(arg => validateContextNode(arg, contextName));
      return;
    case 'ArrayExpression':
      node.elements.forEach(element =>
        validateContextNode(element, contextName),
      );
      return;
    case 'ObjectExpression':
      node.properties.forEach(property =>
        validateContextNode(
          property.type === 'SpreadElement'
            ? property.argument
            : property.value,
          contextName,
        ),
      );
      return;
    case 'TemplateLiteral':
      node.expressions.forEach(expression =>
        validateContextNode(expression, contextName),
      );
      return;
    case 'TaggedTemplateExpression':
      validateContextNode(node.tag, contextName);
      validateContextNode(node.quasi, contextName);
  }
}

export function validateContextExpression(
  source: string,
  contextName: string,
): void {
  const ast = parse(tokenize(source), source);
  if (!ast) {
    throw new Error('parse expression error: ' + source);
  }
  validateContextNode(ast, contextName);
}

function contextProperty(tokens: Token[], index: number): [string, number] {
  const next = tokens[index + 1];
  const maybeDot = next?.value === '?' ? tokens[index + 2] : next;
  const offset = next?.value === '?' ? 1 : 0;

  if (
    maybeDot?.value === '.' &&
    (tokens[index + 2 + offset]?.kind === 'identifier' ||
      (tokens[index + 2 + offset]?.kind === 'operator' &&
        ['instanceof', 'in', 'typeof', 'void', 'delete'].includes(
          tokens[index + 2 + offset].value,
        )))
  ) {
    return [tokens[index + 2 + offset].value, index + 3 + offset];
  }

  const maybeOpen = maybeDot?.value === '.' ? tokens[index + 2 + offset] : next;
  const openOffset = maybeDot?.value === '.' ? 1 + offset : 0;
  const key = tokens[index + 2 + openOffset];
  const close = tokens[index + 3 + openOffset];
  if (
    maybeOpen?.value === '[' &&
    key?.kind === 'string' &&
    close?.value === ']'
  ) {
    if (IDENTIFIER_RE.test(key.value)) {
      return [key.value, index + 4 + openOffset];
    }
  }

  throw new Error(
    next?.value === '[' || maybeOpen?.value === '['
      ? 'expr callback can only access context properties with identifier property names'
      : 'expr callback cannot use the context parameter directly',
  );
}

export function encodeStringLiteral(
  value: string,
  quote: QuoteStyle = 'double',
): string {
  const json = JSON.stringify(value);
  if (quote === 'double') {
    return json;
  }
  const inner = json.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'");
  return `'${inner}'`;
}

function rewriteContext(
  tokens: Token[],
  contextName: string,
  options?: RewriteContextOptions,
): OutputToken[] {
  const output: OutputToken[] = [];
  for (let i = 0; i < tokens.length && tokens[i].kind !== 'eof';) {
    const token = tokens[i];
    if (token.kind === 'identifier' && token.value === contextName) {
      const [property, nextIndex] = contextProperty(tokens, i);
      output.push({ kind: 'identifier', value: property });
      i = nextIndex;
      continue;
    }
    if (token.kind === 'template' && token.template) {
      const { rawQuasis, expressionsSrc } = token.template;
      output.push({
        kind: 'template',
        value: `\`${rawQuasis
          .map((raw, index) =>
            index < expressionsSrc.length
              ? `${raw}\${${rewriteContextExpression(
                  expressionsSrc[index],
                  contextName,
                  options,
                )}}`
              : raw,
          )
          .join('')}\``,
      });
    } else {
      output.push(token);
    }
    i++;
  }
  return output;
}

function renderTokenValue(token: OutputToken, quote: QuoteStyle): string {
  if (token.kind === 'string') {
    return encodeStringLiteral(token.value, quote);
  }
  return token.value;
}

function trimRight(value: string): string {
  return value.replace(/\s+$/u, '');
}

function renderTokens(tokens: OutputToken[], quote: QuoteStyle): string {
  let output = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const value = renderTokenValue(token, quote);
    const previous = tokens[i - 1];

    if (token.kind === 'operator') {
      if (previous?.value === '.') {
        output = trimRight(output) + value;
        continue;
      }
      if (
        value === '...' ||
        (['+', '-', '!', '~'].includes(value) && !previous)
      ) {
        output = trimRight(output) + value;
      } else if (['typeof', 'void', 'delete'].includes(value)) {
        if (output && !/\s$/u.test(output)) {
          output += ' ';
        }
        output += `${value} `;
      } else {
        output = `${trimRight(output)} ${value} `;
      }
      continue;
    }

    if (token.kind === 'punct') {
      if (value === '?' && tokens[i + 1]?.value === '.') {
        output = trimRight(output) + '?.';
        i++;
      } else if (['.', '[', '(', '{'].includes(value)) {
        output = trimRight(output) + value;
      } else if ([']', ')', '}'].includes(value)) {
        output = trimRight(output) + value;
      } else if (value === ',') {
        output = trimRight(output) + ', ';
      } else if (value === ':' || value === '?') {
        output = `${trimRight(output)} ${value} `;
      } else {
        output += value;
      }
      continue;
    }

    if (output && !/[\s.([{!~+\-]$/u.test(output)) {
      output += ' ';
    }
    output += value;
  }
  return trimRight(output);
}

export function rewriteContextExpression(
  source: string,
  contextName: string,
  options?: RewriteContextOptions,
): string {
  const quote = options?.quote ?? 'double';
  const tokens = rewriteContext(validatedTokens(source), contextName, options);
  const expressionSource = renderTokens(tokens, quote);
  validatedTokens(expressionSource);
  return expressionSource;
}
