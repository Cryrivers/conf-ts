import fs from 'fs';
import path from 'path';
import expression from '@conf-ts/expression';
import {
  ExprSyntaxError,
  print,
  tryParse,
  type ASTNode,
} from '@conf-ts/expression/core';
import { describe, expect, it } from 'vitest';

const MACRO_DIR = path.resolve(__dirname, 'fixtures/macros');

const stringsIn = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : value !== null && typeof value === 'object'
      ? Object.values(value).flatMap(stringsIn)
      : [];

// The tree without source positions, raw texts, or parentheses.
const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(shape);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const node = value as Record<string, unknown>;
  if (node.type === 'ParenthesizedExpression') {
    return shape(node.expression);
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(
        ([key, item]) =>
          !['start', 'end', 'raw'].includes(key) && item !== undefined,
      )
      .map(([key, item]) => [key, shape(item)]),
  );
};

const parseOk = (source: string): ASTNode => {
  const result = tryParse(source);
  if (!result.ok) {
    throw result.error;
  }
  return result.ast;
};

describe('@conf-ts/expression/core with macro transformer output', () => {
  it('prints every expression emitted by the expr fixtures back to the same tree', () => {
    const sources = fs
      .readdirSync(MACRO_DIR)
      .filter(file => /^expr.*\.json$/.test(file))
      .flatMap(file =>
        stringsIn(
          JSON.parse(fs.readFileSync(path.join(MACRO_DIR, file), 'utf8')),
        ),
      );
    expect(sources.length).toBeGreaterThan(100);

    for (const source of sources) {
      const ast = parseOk(source);
      const printed = print(ast);
      expect(shape(parseOk(printed)), `${source}\n${printed}`).toEqual(
        shape(ast),
      );
      expect(print(parseOk(printed)), source).toBe(printed);
    }
  });

  it('shares its ExprSyntaxError with the evaluator', () => {
    expect(() => expression('a +')).toThrow(ExprSyntaxError);
  });
});
