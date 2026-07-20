import { parse, tokenize, type Token } from '@conf-ts/expr-core';

import type { QuoteStyle } from './types';

const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/;

type RewriteContextOptions = {
  quote?: QuoteStyle;
};

type OutputToken = Pick<Token, 'kind' | 'value'>;

function validatedTokens(source: string): Token[] {
  const tokens = tokenize(source);
  parse(tokens, source);
  return tokens;
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

// Keep this in sync with macro-transformer-native/src/transform.rs encode_string.
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

function isUnarySymbolOperator(
  token: OutputToken,
  previous?: OutputToken,
): boolean {
  if (token.value === '!' || token.value === '~') {
    return true;
  }
  if (token.value !== '+' && token.value !== '-') {
    return false;
  }
  return (
    !previous ||
    previous.kind === 'operator' ||
    ['(', '[', '{', ',', ':', '?'].includes(previous.value)
  );
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
      if (value === '...') {
        output = trimRight(output) + value;
      } else if (isUnarySymbolOperator(token, previous)) {
        if ((value === '+' || value === '-') && output.endsWith(value)) {
          output += ' ';
        }
        output += value;
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
      } else if (value === '(' && /\s$/u.test(output)) {
        // Preserve the separator emitted after a binary/keyword operator,
        // while calls and unary operators still render compactly (`fn()` /
        // `!(value)`). This also matches the native expression encoder.
        output += value;
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
