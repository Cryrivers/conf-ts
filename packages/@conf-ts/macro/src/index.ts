import {
  parse,
  tokenize,
  type Expr,
  type RuntimeEnv,
  type Token,
} from '@conf-ts/expression';

console.warn(
  '@conf-ts/macro has been imported. This package is intended for compile-time macro expansion and should not be directly imported into runtime code.',
);

export { createElement, type JsxOutputOptions } from './jsx-runtime';
export type { Expr, RuntimeEnv } from '@conf-ts/expression';

const EXPR_CALLBACK_ERROR =
  'expr callback must be an arrow function with a single identifier parameter and expression body';
const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/;

type ParsedCallback = {
  paramName: string;
  body: string;
};

type OutputToken = Pick<Token, 'kind' | 'value'>;

function parseCallback(callback: Function): ParsedCallback {
  const source = callback.toString().trim();
  const arrowIndex = source.indexOf('=>');
  if (arrowIndex === -1) {
    throw new Error(EXPR_CALLBACK_ERROR);
  }

  if (/^async\b\s*(?:\(|[A-Za-z_$])/.test(source)) {
    throw new Error(EXPR_CALLBACK_ERROR);
  }

  const params = source.slice(0, arrowIndex).trim();
  const body = source.slice(arrowIndex + 2).trim();
  if (!body || body.startsWith('{')) {
    throw new Error(EXPR_CALLBACK_ERROR);
  }

  const parenthesized = params.match(/^\(\s*([A-Za-z_$][0-9A-Za-z_$]*)\s*\)$/);
  if (parenthesized) {
    return { paramName: parenthesized[1], body };
  }

  const bare = params.match(/^([A-Za-z_$][0-9A-Za-z_$]*)$/);
  if (bare) {
    return { paramName: bare[1], body };
  }

  throw new Error(EXPR_CALLBACK_ERROR);
}

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

function rewriteContext(tokens: Token[], paramName: string): OutputToken[] {
  const output: OutputToken[] = [];
  for (let i = 0; i < tokens.length && tokens[i].kind !== 'eof'; ) {
    const token = tokens[i];
    if (token.kind === 'identifier' && token.value === paramName) {
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
              ? `${raw}\${${rewriteExpression(expressionsSrc[index], paramName)}}`
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

function rewriteExpression(source: string, paramName: string): string {
  const tokens = rewriteContext(validatedTokens(source), paramName);
  const expressionSource = renderTokens(tokens);
  validatedTokens(expressionSource);
  return expressionSource;
}

export function expr<
  Context extends RuntimeEnv = RuntimeEnv,
  ReturnType = unknown,
>(callback: (ctx: Context) => ReturnType): Expr<Context, ReturnType> {
  const { paramName, body } = parseCallback(callback);
  return rewriteExpression(body, paramName) as Expr<Context, ReturnType>;
}

export function String(value: any): string {
  return globalThis.String(value);
}

export function Number(value: any): number {
  return globalThis.Number(value);
}

export function Boolean(value: any): boolean {
  return globalThis.Boolean(value);
}

export function arrayMap<T, U>(array: T[], callback: (item: T) => U): U[] {
  return array.map(callback);
}

export function arrayFlatMap<T, U>(
  array: T[],
  callback: (item: T) => U | U[],
): U[] {
  return array.flatMap(callback);
}

export function arrayFilter<T>(
  array: T[],
  predicate: (item: T) => boolean,
): T[] {
  return array.filter(predicate);
}

export function env(key: string): string | undefined;
export function env(key: string, defaultValue: string): string;
export function env(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}
