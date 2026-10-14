import fs from 'fs';
import path from 'path';
import expression from '@conf-ts/expression';
import {
  exprSchema,
  looseExprSchema,
  type ExprIssueParams,
} from '@conf-ts/macro/zod';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import * as zm from 'zod/mini';

import { AccessConfig } from './fixtures/macros/expr-zod.schema';
import {
  assertMacroOutput,
  compileJsWithMacro,
  compileNativeWithMacro,
} from './test-utils';

const issuesOf = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues ?? [];

const messagesOf = (schema: z.ZodType, input: unknown) =>
  issuesOf(schema, input).map(issue => issue.message);

const reasonsOf = (schema: z.ZodType, input: unknown) =>
  issuesOf(schema, input).map(
    issue => (issue as { params?: ExprIssueParams }).params?.reason,
  );

const expectValid = (schema: z.ZodType, ...sources: string[]) => {
  for (const source of sources) {
    expect(messagesOf(schema, source), source).toEqual([]);
  }
};

const Context = z.object({
  user: z.object({
    name: z.string(),
    age: z.number(),
    status: z.enum(['active', 'banned']),
    tags: z.array(z.string()),
    profile: z
      .object({ score: z.number(), nickname: z.string().nullable() })
      .optional(),
  }),
  threshold: z.number(),
  flags: z.record(z.string(), z.boolean()),
  pair: z.tuple([z.string(), z.number()]),
  createdAt: z.date(),
  isAdmin: z.function(),
});

describe('exprSchema()', () => {
  it('accepts expression strings and keeps them unchanged', () => {
    const schema = exprSchema();
    expect(schema.parse('a + b * 2')).toBe('a + b * 2');
    expect(z.object({ when: schema.optional() }).parse({})).toEqual({});
  });

  it('rejects values that are not strings', () => {
    const schema = exprSchema();
    for (const input of [1, null, undefined, {}, () => 'a']) {
      expect(issuesOf(schema, input)).toMatchObject([
        { code: 'invalid_type', expected: 'string' },
      ]);
    }
  });

  it('rejects expressions the runtime evaluator cannot parse', () => {
    const schema = exprSchema();
    for (const source of [
      '',
      ' ',
      'a +',
      'a ? : b',
      'a = 1',
      '"open',
      ']',
      'a b',
    ]) {
      expect(reasonsOf(schema, source), source).toEqual(['syntax']);
    }
    expect(messagesOf(schema, 'a +')).toEqual([
      'Invalid expression syntax: parse expression error: a +',
    ]);
  });

  it('reports issues at the path of the expression property', () => {
    const schema = z.object({ rules: z.array(exprSchema()) });
    expect(issuesOf(schema, { rules: ['a', 'b +'] })).toMatchObject([
      { code: 'custom', path: ['rules', 1], params: { reason: 'syntax' } },
    ]);
  });

  it('accepts any identifier when no context schema is given', () => {
    expectValid(exprSchema(), 'anything.goes(here) && String(x)');
  });

  it('throws for options that are not Zod schemas', () => {
    expect(() => exprSchema({ context: {} as z.ZodType })).toThrow(
      'exprSchema(): `context` must be a Zod 4 schema',
    );
    expect(() => looseExprSchema({ returns: 1 as never })).toThrow(
      'looseExprSchema(): `returns` must be a Zod 4 schema',
    );
  });
});

describe('context validation', () => {
  const schema = exprSchema({ context: Context });

  it('accepts expressions that read existing context properties', () => {
    expectValid(
      schema,
      'user.age >= threshold && user.status === "active"',
      'user["name"].toUpperCase() + user.tags.length',
      'user.tags[0].startsWith("a") || user.tags.includes(user.name)',
      'user.profile?.score ?? 0',
      'user.profile.nickname.trim()',
      'flags.beta && flags["dark-mode"]',
      'pair[0].length + pair[1].toFixed(2).length',
      'createdAt.getTime() > 0 && isAdmin(user)',
      'user.hasOwnProperty("age") && user.toString() !== ""',
      '`${user.name} (${user.age})`',
      '{ name: user.name, ...user.profile, [user.status]: true }',
    );
  });

  it('rejects unknown root identifiers with a suggestion', () => {
    expect(issuesOf(schema, 'usr.age > 1')).toMatchObject([
      {
        code: 'custom',
        message: 'Unknown context property "usr" (did you mean "user"?)',
        params: { reason: 'unknown_context_property' },
      },
    ]);
    expect(messagesOf(schema, 'missing')).toEqual([
      'Unknown context property "missing"',
    ]);
  });

  it('rejects unknown properties along a context path', () => {
    expect(issuesOf(schema, 'user.agee > threshold')).toMatchObject([
      {
        message:
          'Property "agee" does not exist on "user" (did you mean "age"?)',
        params: { reason: 'unknown_property' },
      },
    ]);
    expect(messagesOf(schema, 'user.profile.scroe')).toEqual([
      'Property "scroe" does not exist on "user.profile" (did you mean "score"?)',
    ]);
    expect(messagesOf(schema, 'user.name.lenght')).toEqual([
      'Property "lenght" does not exist on "user.name" (did you mean "length"?)',
    ]);
    expect(messagesOf(schema, 'user.tags[0].nmae')).toEqual([
      'Property "nmae" does not exist on "user.tags[0]"',
    ]);
    expect(messagesOf(schema, 'user.tags.size')).toEqual([
      'Property "size" does not exist on "user.tags"',
    ]);
    expect(messagesOf(schema, 'pair[2]')).toEqual([
      'Property "2" does not exist on "pair"',
    ]);
  });

  it('reports every problem in one pass', () => {
    expect(reasonsOf(schema, 'usr.age > user.agee')).toEqual([
      'unknown_context_property',
      'unknown_property',
    ]);
  });

  it('only resolves root identifiers to own context properties', () => {
    expect(reasonsOf(schema, 'toString()')).toEqual([
      'unknown_context_property',
    ]);
    expect(reasonsOf(schema, 'constructor')).toEqual([
      'unknown_context_property',
    ]);
  });

  it('resolves the evaluator builtins unless the context defines them', () => {
    expectValid(schema, 'String(user.age) + Number("1") + Boolean(threshold)');
    const shadowed = exprSchema({
      context: z.object({ String: z.object({ raw: z.string() }) }),
    });
    expectValid(shadowed, 'String.raw');
    expect(reasonsOf(shadowed, 'String.row')).toEqual(['unknown_property']);
  });

  it('treats callback parameters as local bindings', () => {
    expectValid(
      schema,
      'user.tags.filter(tag => tag.length > threshold)',
      'user.tags.map((tag, index) => index + tag.whatever)',
      'user.tags.reduce((total, tag = user.name) => total + tag.length, 0)',
      '[user].map(({ name, age: years = threshold }) => name + years)',
      '[user.tags].map(([first, , third]) => first + third)',
      '((...rest) => rest.length)(user)',
      '(user => user.anything)(1)',
    );
    expect(reasonsOf(schema, 'user.tags.map(tag => tga)')).toEqual([
      'unknown_context_property',
    ]);
    expect(reasonsOf(schema, 'user.tags.map((tag = usr) => tag)')).toEqual([
      'unknown_context_property',
    ]);
  });

  it('checks identifiers inside computed keys, spreads, and templates', () => {
    expect(reasonsOf(schema, 'flags[usr]')).toEqual([
      'unknown_context_property',
    ]);
    expect(reasonsOf(schema, '[...usr]')).toEqual(['unknown_context_property']);
    expect(reasonsOf(schema, '{ ...user.profle }')).toEqual([
      'unknown_property',
    ]);
    expect(reasonsOf(schema, '`${user.nam}`')).toEqual(['unknown_property']);
    expect(reasonsOf(schema, 'usr`tagged`')).toEqual([
      'unknown_context_property',
    ]);
  });

  it('allows any key on records and on objects with a catchall', () => {
    expectValid(schema, 'flags.anything');
    const loose = z.looseObject({ known: z.object({ a: z.number() }) });
    const strict = z.strictObject({ known: z.number() });
    const catchall = z.object({}).catchall(z.object({ a: z.number() }));
    expectValid(exprSchema({ context: loose }), 'unknown.deep.path');
    expect(reasonsOf(exprSchema({ context: loose }), 'known.b')).toEqual([
      'unknown_property',
    ]);
    expect(reasonsOf(exprSchema({ context: strict }), 'other')).toEqual([
      'unknown_context_property',
    ]);
    expectValid(exprSchema({ context: catchall }), 'anything.a');
    expect(reasonsOf(exprSchema({ context: catchall }), 'anything.b')).toEqual([
      'unknown_property',
    ]);
  });

  it('accepts a property that exists on any member of a union', () => {
    const Shape = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('circle'), radius: z.number() }),
      z.object({ kind: z.literal('square'), size: z.number() }),
    ]);
    const shapes = exprSchema({ context: z.object({ shape: Shape }) });
    expectValid(
      shapes,
      'shape.kind === "circle" ? shape.radius : shape.size',
      '"radius" in shape && shape.radius > 1',
    );
    expect(reasonsOf(shapes, 'shape.width')).toEqual(['unknown_property']);

    const mixed = exprSchema({
      context: z.object({
        value: z.union([z.string(), z.object({ a: z.number() })]),
      }),
    });
    expectValid(mixed, 'value.length', 'value.a');
    expect(reasonsOf(mixed, 'value.b')).toEqual(['unknown_property']);
  });

  it('merges the members of an intersection', () => {
    const both = exprSchema({
      context: z.intersection(
        z.object({ a: z.number() }),
        z.object({ b: z.string() }),
      ),
    });
    expectValid(both, 'a + b.length');
    expect(reasonsOf(both, 'c')).toEqual(['unknown_context_property']);
  });

  it('unwraps wrappers, pipes, and lazy or recursive schemas', () => {
    const Node: z.ZodType<{ name: string; children: unknown[] }> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(Node) }),
    );
    const Category = z.object({
      title: z.string(),
      get parent() {
        return Category.optional();
      },
    });
    const wrapped = exprSchema({
      context: z.object({
        node: Node,
        category: Category,
        settings: z
          .object({ mode: z.string() })
          .readonly()
          .default({ mode: 'a' })
          .catch({ mode: 'b' }),
        coerced: z.string().pipe(z.coerce.number()),
      }),
    });
    expectValid(
      wrapped,
      'node.children[0].children.length',
      'category.parent.parent.title',
      'settings.mode',
      'coerced.toFixed(1)',
    );
    expect(reasonsOf(wrapped, 'category.parent.titel')).toEqual([
      'unknown_property',
    ]);
    expect(reasonsOf(wrapped, 'settings.mod')).toEqual(['unknown_property']);
  });

  it('does not check values whose schema cannot be described statically', () => {
    const opaque = exprSchema({
      context: z.object({
        any: z.any(),
        unknown: z.unknown(),
        custom: z.custom<{ a: number }>(),
        transformed: z.string().transform(value => ({ value })),
      }),
    });
    expectValid(
      opaque,
      'any.a.b.c',
      'unknown.a',
      'custom.b',
      'transformed.value.length',
    );
    expectValid(exprSchema({ context: z.any() }), 'anything');
  });

  it('accepts Zod Mini schemas', () => {
    const schema = exprSchema({
      context: zm.object({ user: zm.object({ age: zm.number() }) }),
      returns: zm.boolean(),
    });
    expectValid(schema, 'user.age > 1');
    expect(reasonsOf(schema, 'user.agee > 1')).toEqual(['unknown_property']);
    expect(reasonsOf(schema, 'user.age')).toEqual(['return_type']);
  });

  it('resolves schemas lazily, on first validation', () => {
    const schema = exprSchema({ context: z.lazy(() => Later) });
    const Later = z.object({ ready: z.boolean() });
    expectValid(schema, 'ready');
    expect(reasonsOf(schema, 'redy')).toEqual(['unknown_context_property']);
  });
});

describe('return validation', () => {
  it('rejects results of a type the return schema does not accept', () => {
    const schema = exprSchema({ context: Context, returns: z.boolean() });
    expectValid(
      schema,
      'user.age > threshold',
      '!user.name',
      'user.tags.includes("a")',
      'user.age > 1 && user.status === "active"',
      'flags.beta',
      'Boolean(user.age)',
    );
    expect(issuesOf(schema, 'user.age')).toMatchObject([
      {
        message:
          'Expression evaluates to number, but the return schema expects boolean',
        params: { reason: 'return_type' },
      },
    ]);
    expect(reasonsOf(schema, 'user.age + 1')).toEqual(['return_type']);
    expect(reasonsOf(schema, '`${user.age}`')).toEqual(['return_type']);
    expect(reasonsOf(schema, 'String(user.age)')).toEqual(['return_type']);
    expect(reasonsOf(schema, 'user.age > 1 ? user.name : user.age')).toEqual([
      'return_type',
    ]);
    // number | string | null, which TypeScript wouldn't accept as boolean either
    expect(
      reasonsOf(schema, 'user.profile.score && user.profile.nickname'),
    ).toEqual(['return_type']);
  });

  it('accepts results whose type cannot be determined statically', () => {
    const schema = exprSchema({ context: Context, returns: z.boolean() });
    expectValid(
      schema,
      'isAdmin(user)',
      'user.tags.at(0)',
      'user.tags.some(tag => tag === user.name)',
      'user.age > 1 || isAdmin(user)',
      '(x => x)(1)',
    );
  });

  it('checks statically known results against the schema itself', () => {
    const schema = exprSchema({
      context: Context,
      returns: z.enum(['adult', 'minor']),
    });
    expectValid(schema, 'user.age >= 18 ? "adult" : "minor"', '"adult"');
    expect(messagesOf(schema, 'user.age >= 18 ? "adult" : "mnior"')).toEqual([
      'Expression can evaluate to "mnior", which the return schema rejects: Invalid option: expected one of "adult"|"minor"',
    ]);
    expect(messagesOf(schema, '"teen"')).toEqual([
      'Expression evaluates to "teen", which the return schema rejects: Invalid option: expected one of "adult"|"minor"',
    ]);

    const count = exprSchema({ returns: z.number().int().nonnegative() });
    expectValid(count, '1', '+"2"', 'x ? 1 : 2', 'x && 1 || 2');
    expect(reasonsOf(count, '-1')).toEqual(['return_type']);
    expect(reasonsOf(count, '1.5')).toEqual(['return_type']);
    expect(reasonsOf(count, 'x ? 1 : -1')).toEqual(['return_type']);
    expect(reasonsOf(count, 'true || x')).toEqual(['return_type']);
    expect(reasonsOf(count, 'null ?? 1')).toEqual([]);
    expect(
      reasonsOf(exprSchema({ returns: z.string() }), '`a${1 + 1}`'),
    ).toEqual([]);
    expect(
      reasonsOf(exprSchema({ returns: z.literal('a2') }), '`a${2}`'),
    ).toEqual([]);
  });

  it('accepts optional and nullable results', () => {
    const optional = exprSchema({
      context: Context,
      returns: z.number().optional(),
    });
    expectValid(optional, 'user.profile?.score', 'undefined', 'void 0');
    expect(reasonsOf(optional, 'null')).toEqual(['return_type']);
    expectValid(
      exprSchema({ context: Context, returns: z.string().nullable() }),
      'user.profile.nickname',
      'null',
    );
  });

  it('accepts never-typed results, which fit any return type', () => {
    const schema = exprSchema({
      context: z.object({ fail: z.never() }),
      returns: z.string(),
    });
    expectValid(schema, 'fail');
  });
});

describe('looseExprSchema()', () => {
  it('validates context paths like exprSchema()', () => {
    const schema = looseExprSchema({ context: Context, returns: z.number() });
    expectValid(schema, 'user.profile.score', 'user.tags[0].length');
    expect(reasonsOf(schema, 'user.profile.scor')).toEqual([
      'unknown_property',
    ]);
    expect(reasonsOf(schema, 'usr.profile.score')).toEqual([
      'unknown_context_property',
    ]);
  });

  it('accounts for loose access short-circuiting to undefined', () => {
    const schema = looseExprSchema({
      context: Context,
      returns: z.undefined(),
    });
    // `profile` may be missing, so loose evaluation can yield undefined.
    expectValid(schema, 'user.profile.score');
    expect(reasonsOf(schema, 'user.age')).toEqual(['return_type']);
  });
});

const MACRO_DIR = path.resolve(__dirname, 'fixtures/macros');

function readFixtureOutput(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(MACRO_DIR, `${name}.json`), 'utf8'),
  );
}

// JSON output of both macro transformers, so validation never depends on
// formatting that only one of them produces.
function compileBoth(name: string): Record<string, unknown>[] {
  const file = path.join(MACRO_DIR, `${name}.conf.ts`);
  return [compileJsWithMacro, compileNativeWithMacro].map(compile =>
    JSON.parse(compile(file, 'json', { macro: true }).output),
  );
}

const stringsIn = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : value !== null && typeof value === 'object'
      ? Object.values(value).flatMap(stringsIn)
      : [];

const callable = z.custom<(...args: never[]) => unknown>(
  value => typeof value === 'function',
);

// Zod mirrors of the `Context` types declared by the fixtures.
const FIXTURE_CONTEXTS: Record<string, z.ZodType> = {
  expr: z.object({
    a: z.number(),
    b: z.number(),
    user: z.object({ age: z.number() }),
    limit: z.number(),
  }),
  'expr-array-callback': z.object({
    quota: z.number(),
    queue: z.array(z.number()),
    scores: z.array(z.number()),
    threshold: z.number(),
    matrix: z.array(z.array(z.number())),
  }),
  'expr-array-callback-patterns': z.object({
    pairs: z.array(z.object({ a: z.number(), b: z.number() })),
    matrix: z.array(z.array(z.number())),
    queue: z.array(z.number()),
    threshold: z.number(),
  }),
  'expr-compose': z.object({
    a: z.boolean(),
    b: z.boolean(),
    c: z.boolean(),
    name: z.string(),
    score: z.number(),
  }),
  'expr-metadata': z.object({
    value: z.number(),
    formatter: z.object({ format: callable, tag: callable }),
  }),
  'expr-new-syntax': z.object({
    items: z.array(z.number()),
    key: z.string(),
    value: z.number(),
  }),
  'expr-operators': z.object({
    base: z.number(),
    exponent: z.number(),
    left: z.number(),
    right: z.number(),
    value: z.object({}),
    Constructor: callable,
    key: z.string(),
    object: z.object({ removable: z.number().optional() }),
  }),
  'expr-template': z.object({ a: z.number(), enabled: z.boolean() }),
  'expr-template-prune': z.object({
    expressionA: z.number(),
    expressionB: z.number(),
    enabled: z.boolean(),
  }),
};

enum Status {
  Active = 'active',
}

const ParityContext = z.object({
  value: z.unknown(),
  number: z.number(),
  text: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  status: z.enum(Status),
  left: z.unknown(),
  right: z.unknown(),
  user: z.object({ profile: z.object({ score: z.number() }) }).nullish(),
  nested: z.object({ score: z.number() }),
  extra: z.record(z.string(), z.unknown()),
  object: z.object({
    removable: z.number().optional(),
    present: z.number().optional(),
  }),
  key: z.string(),
  score: z.number().nullish(),
  Constructor: callable,
  instance: z.object({}),
  counter: z.object({ value: z.number(), add: z.function() }),
  increment: z.number(),
  fail: z.function(),
});

const parity = <Returns extends z.ZodType>(returns: Returns) =>
  exprSchema({ context: ParityContext, returns });

// Return schemas mirror the `ReturnType` each parity fixture entry declares.
const ParityConfig = z.strictObject({
  capturedNumber: parity(z.boolean()),
  capturedString: parity(z.boolean()),
  capturedBoolean: parity(z.boolean()),
  capturedNull: parity(z.boolean()),
  capturedEnum: parity(z.boolean()),
  computedKey: parity(z.number()),
  asExpression: parity(z.number()),
  satisfiesExpression: parity(z.number()),
  nonNullExpression: parity(z.number()),
  optionalChain: parity(z.number().optional()),
  objectExpression: parity(z.record(z.string(), z.unknown())),
  arrayExpression: parity(z.array(z.unknown())),
  templateExpression: parity(z.string()),
  unaryPlus: parity(z.number()),
  logicalAnd: parity(z.unknown()),
  bitwise: parity(z.number()),
  methodCall: parity(z.number()),
  deleteProperty: parity(z.boolean()),
  inOperator: parity(z.boolean()),
  instanceOf: parity(z.boolean()),
  missingMember: parity(z.number()),
  throwingCall: parity(z.never()),
  nullishCoalescing: parity(z.unknown()),
  logicalOr: parity(z.unknown()),
  conditional: parity(z.string()),
  voidExpr: parity(z.undefined()),
  typeofExpr: parity(z.string()),
  bitwiseNot: parity(z.number()),
  unaryNegate: parity(z.number()),
  unaryNot: parity(z.boolean()),
  equality: parity(z.boolean()),
  inequality: parity(z.boolean()),
  strictInequality: parity(z.boolean()),
  exponentiation: parity(z.number()),
  modulo: parity(z.number()),
  nestedTernary: parity(z.enum(['high', 'mid', 'low'])),
  comparison: parity(z.boolean()),
  shiftRight: parity(z.number()),
  shiftRightZeroFill: parity(z.number()),
  bitwiseXor: parity(z.number()),
  parenthesizedNullishComparison: parity(z.boolean()),
});

describe('@conf-ts/macro/zod with macro transformer output', () => {
  it('accepts every expression emitted by the expr fixtures', () => {
    const fixtures = fs
      .readdirSync(MACRO_DIR)
      .filter(file => /^expr.*\.json$/.test(file))
      .map(file => file.replace(/\.json$/, ''));
    expect(fixtures.length).toBeGreaterThan(10);

    for (const fixture of fixtures) {
      const schema = exprSchema({ context: FIXTURE_CONTEXTS[fixture] });
      for (const source of stringsIn(readFixtureOutput(fixture))) {
        expect(issuesOf(schema, source), `${fixture}: ${source}`).toEqual([]);
      }
    }
  });

  it('accepts output that matches the declared context and return types', () => {
    for (const output of compileBoth('expr-parity')) {
      expect(issuesOf(ParityConfig, output)).toEqual([]);
    }
  });

  it('validates and evaluates a config authored against zod-inferred types', () => {
    assertMacroOutput('expr-zod');

    for (const output of compileBoth('expr-zod')) {
      const config = AccessConfig.parse(output);
      const admin = {
        user: { age: 30, roles: ['admin' as const] },
        minimumAge: 18,
      };
      const viewer = {
        user: {
          age: 16,
          roles: ['viewer' as const],
          profile: { verified: true },
        },
        minimumAge: 18,
      };

      expect(expression(config.canEnter)(admin)).toBe(true);
      expect(expression(config.canEnter)(viewer)).toBe(false);
      expect(expression(config.tier)(admin)).toBe('staff');
      expect(expression(config.tier)(viewer)).toBe('member');
      expect(expression(config.verified, { loose: true })(admin)).toBe(
        undefined,
      );
      expect(expression(config.verified, { loose: true })(viewer)).toBe(true);
    }
  });

  it('reports hand-edited expressions at their config path', () => {
    const output = readFixtureOutput('expr-zod') as Record<string, string>;
    const issues = issuesOf(AccessConfig, {
      canEnter: output.canEnter.replace('minimumAge', 'minimunAge'),
      tier: output.tier.replace('"staff"', '"staf"'),
      verified: `${output.verified} +`,
    });

    expect(issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['canEnter'],
        message:
          'Unknown context property "minimunAge" (did you mean "minimumAge"?)',
      },
      {
        path: ['tier'],
        message:
          'Expression can evaluate to "staf", which the return schema rejects: Invalid option: expected one of "staff"|"member"',
      },
      {
        path: ['verified'],
        message:
          'Invalid expression syntax: parse expression error: user.profile.verified +',
      },
    ]);
  });
});
