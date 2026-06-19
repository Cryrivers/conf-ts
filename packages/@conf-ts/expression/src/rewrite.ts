import { tokenize } from './ast/lexer';
import { parse } from './ast/parser';
import type { Token } from './ast/types';

const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/;

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
    tokens[index + 2 + offset]?.kind === 'identifier'
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

function rewriteContext(tokens: Token[], contextName: string): OutputToken[] {
  const output: OutputToken[] = [];
  for (let i = 0; i < tokens.length && tokens[i].kind !== 'eof'; ) {
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

function renderTokenValue(token: OutputToken): string {
  if (token.kind === 'string') {
    return JSON.stringify(token.value);
  }
  return token.value;
}

function trimRight(value: string): string {
  return value.replace(/\s+$/u, '');
}

function renderTokens(tokens: OutputToken[]): string {
  let output = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const value = renderTokenValue(token);
    const previous = tokens[i - 1];

    if (token.kind === 'operator') {
      if (value === '...' || (['+', '-', '!'].includes(value) && !previous)) {
        output = trimRight(output) + value;
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

    if (output && !/[\s.([{]$/u.test(output)) {
      output += ' ';
    }
    output += value;
  }
  return trimRight(output);
}

export function rewriteContextExpression(
  source: string,
  contextName: string,
): string {
  const tokens = rewriteContext(validatedTokens(source), contextName);
  const expressionSource = renderTokens(tokens);
  validatedTokens(expressionSource);
  return expressionSource;
}
