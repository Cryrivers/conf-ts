import { parse, tokenize, type Token } from '@conf-ts/expr-core';
import ts from 'typescript';

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

// Normalize only after every context/constant/type replacement has been
// applied, because those rewrites can change which grouping is necessary.
// Each candidate is parsed again and accepted only when its parenthesis-free
// semantic tree is identical. Keep this in sync with the native implementation
// in macro_eval.rs.
const EXPRESSION_WRAPPER_PREFIX = 'const __confTsExpression = ';

function parseExpressionForParentheses(source: string): {
  expression: ts.Expression;
  sourceFile: ts.SourceFile;
} | null {
  const sourceFile = ts.createSourceFile(
    'expression.ts',
    `${EXPRESSION_WRAPPER_PREFIX}${source};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  if (parseDiagnostics?.length) {
    return null;
  }
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) {
    return null;
  }
  const declaration = statement.declarationList.declarations[0];
  if (!declaration?.initializer) {
    return null;
  }
  return { expression: declaration.initializer, sourceFile };
}

function mixesNullishAndLogicalWithoutParentheses(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    const isNullish = operator === ts.SyntaxKind.QuestionQuestionToken;
    const isLogical =
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken;
    const childHasOperator = (
      child: ts.Expression,
      predicate: (kind: ts.SyntaxKind) => boolean,
    ): boolean => {
      return (
        !ts.isParenthesizedExpression(child) &&
        ts.isBinaryExpression(child) &&
        predicate(child.operatorToken.kind)
      );
    };
    if (
      (isNullish &&
        (childHasOperator(
          node.left,
          kind =>
            kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            kind === ts.SyntaxKind.BarBarToken,
        ) ||
          childHasOperator(
            node.right,
            kind =>
              kind === ts.SyntaxKind.AmpersandAmpersandToken ||
              kind === ts.SyntaxKind.BarBarToken,
          ))) ||
      (isLogical &&
        (childHasOperator(
          node.left,
          kind => kind === ts.SyntaxKind.QuestionQuestionToken,
        ) ||
          childHasOperator(
            node.right,
            kind => kind === ts.SyntaxKind.QuestionQuestionToken,
          )))
    ) {
      return true;
    }
  }
  return (
    ts.forEachChild(node, child =>
      mixesNullishAndLogicalWithoutParentheses(child) ? true : undefined,
    ) === true
  );
}

function semanticNodesEqual(
  left: ts.Node,
  leftSourceFile: ts.SourceFile,
  right: ts.Node,
  rightSourceFile: ts.SourceFile,
): boolean {
  if (ts.isParenthesizedExpression(left)) {
    return semanticNodesEqual(
      left.expression,
      leftSourceFile,
      right,
      rightSourceFile,
    );
  }
  if (ts.isParenthesizedExpression(right)) {
    return semanticNodesEqual(
      left,
      leftSourceFile,
      right.expression,
      rightSourceFile,
    );
  }
  if (left.kind !== right.kind) {
    return false;
  }

  const semanticChildren = (node: ts.Node, sourceFile: ts.SourceFile) =>
    node
      .getChildren(sourceFile)
      .filter(
        child =>
          !ts.isArrowFunction(node) ||
          (child.kind !== ts.SyntaxKind.OpenParenToken &&
            child.kind !== ts.SyntaxKind.CloseParenToken),
      );
  const leftChildren = semanticChildren(left, leftSourceFile);
  const rightChildren = semanticChildren(right, rightSourceFile);
  if (leftChildren.length !== rightChildren.length) {
    return false;
  }
  if (leftChildren.length === 0) {
    return left.getText(leftSourceFile) === right.getText(rightSourceFile);
  }
  return leftChildren.every((leftChild, index) =>
    semanticNodesEqual(
      leftChild,
      leftSourceFile,
      rightChildren[index],
      rightSourceFile,
    ),
  );
}

function collectParenthesizedSpans(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const offset = EXPRESSION_WRAPPER_PREFIX.length;
  const visit = (node: ts.Node): void => {
    if (ts.isParenthesizedExpression(node)) {
      spans.push([node.getStart(sourceFile) - offset, node.getEnd() - offset]);
    } else if (
      ts.isArrowFunction(node) &&
      node.parameters.length === 1 &&
      ts.isIdentifier(node.parameters[0].name) &&
      !node.parameters[0].dotDotDotToken &&
      !node.parameters[0].initializer &&
      !node.parameters[0].type
    ) {
      const children = node.getChildren(sourceFile);
      const open = children.find(
        child => child.kind === ts.SyntaxKind.OpenParenToken,
      );
      const close = children.find(
        child => child.kind === ts.SyntaxKind.CloseParenToken,
      );
      if (open && close) {
        spans.push([
          open.getStart(sourceFile) - offset,
          close.getEnd() - offset,
        ]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return spans;
}

function removeRedundantParentheses(source: string): string {
  let output = source;

  while (true) {
    const parsed = parseExpressionForParentheses(output);
    if (!parsed) return output;
    const spans = collectParenthesizedSpans(
      parsed.expression,
      parsed.sourceFile,
    ).sort(([startA, endA], [startB, endB]) => {
      return endA - startA - (endB - startB);
    });

    let simplified = false;
    for (const [start, end] of spans) {
      if (
        start < 0 ||
        end > output.length ||
        output[start] !== '(' ||
        output[end - 1] !== ')'
      ) {
        continue;
      }
      const candidate =
        output.slice(0, start) +
        output.slice(start + 1, end - 1) +
        output.slice(end);
      try {
        validatedTokens(candidate);
      } catch {
        continue;
      }
      const candidateParsed = parseExpressionForParentheses(candidate);
      if (
        candidateParsed &&
        !mixesNullishAndLogicalWithoutParentheses(candidateParsed.expression) &&
        semanticNodesEqual(
          parsed.expression,
          parsed.sourceFile,
          candidateParsed.expression,
          candidateParsed.sourceFile,
        )
      ) {
        output = candidate;
        simplified = true;
        break;
      }
    }
    if (!simplified) return output;
  }
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
  // A ':' is ambiguous in a flat token stream: it closes a ternary
  // (`cond ? a : b`, spaced on both sides) or separates an object/computed
  // property's key from its value (`key: value` / `[key]: value`, compact —
  // matching the native encoder and ordinary Prettier style). This stack
  // tracks which one is currently open — a bare (non-optional-chaining) '?'
  // pushes 'ternary'; '{'/'('/'[' push 'bracket' and pop on their closer —
  // so a ':' renders ternary-style only when it closes a 'ternary' on top.
  const stack: Array<'ternary' | 'bracket'> = [];
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
      } else if (value === '=>') {
        output = `${trimRight(output)} => `;
      } else if (value === '(' && /\s$/u.test(output)) {
        // Preserve the separator emitted after a binary/keyword operator,
        // while calls and unary operators still render compactly (`fn()` /
        // `!(value)`). This also matches the native expression encoder.
        output += value;
        stack.push('bracket');
      } else if (['.', '[', '(', '{'].includes(value)) {
        output = trimRight(output) + value;
        if (value !== '.') {
          stack.push('bracket');
        }
      } else if ([']', ')', '}'].includes(value)) {
        output = trimRight(output) + value;
        stack.pop();
      } else if (value === ',') {
        // Drop a trailing comma before a call/object closer (Prettier
        // commonly adds one when a call wraps its sole argument — e.g. a
        // nested callback — onto multiple lines). `]` is deliberately
        // excluded: a trailing comma there can be a real elision
        // (`[1, 2, ,]`), so dropping it could silently change the array.
        const next = tokens[i + 1];
        const isTrailingComma =
          next?.kind === 'punct' && (next.value === ')' || next.value === '}');
        if (!isTrailingComma) {
          output = trimRight(output) + ', ';
        }
      } else if (value === '?') {
        stack.push('ternary');
        output = `${trimRight(output)} ${value} `;
      } else if (value === ':') {
        if (stack[stack.length - 1] === 'ternary') {
          stack.pop();
          output = `${trimRight(output)} ${value} `;
        } else {
          output = `${trimRight(output)}${value} `;
        }
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
  const expressionSource = removeRedundantParentheses(
    renderTokens(tokens, quote),
  );
  validatedTokens(expressionSource);
  return expressionSource;
}
