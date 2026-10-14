import { expr, type Expr, type LooseExpr } from '@conf-ts/macro';
import {
  exprSchema,
  looseExprSchema,
  type ExprSchema,
  type LooseExprSchema,
} from '@conf-ts/macro/zod';
import { describe, expectTypeOf, it } from 'vitest';
import * as z from 'zod';
import * as zm from 'zod/mini';

const UserContext = z.object({
  user: z.object({
    age: z.number(),
    profile: z.object({ score: z.number() }).optional(),
  }),
});
type UserContext = z.infer<typeof UserContext>;

describe('exprSchema() types', () => {
  it('infers Context and ReturnType from the context and returns schemas', () => {
    const canEnter = exprSchema({ context: UserContext, returns: z.boolean() });
    expectTypeOf(canEnter).toEqualTypeOf<ExprSchema<UserContext, boolean>>();
    expectTypeOf<z.infer<typeof canEnter>>().toEqualTypeOf<
      Expr<UserContext, boolean>
    >();
    expectTypeOf<z.input<typeof canEnter>>().toEqualTypeOf<
      Expr<UserContext, boolean>
    >();

    const score = looseExprSchema({
      context: UserContext,
      returns: z.number().optional(),
    });
    expectTypeOf(score).toEqualTypeOf<
      LooseExprSchema<UserContext, number | undefined>
    >();
    expectTypeOf<z.infer<typeof score>>().toEqualTypeOf<
      LooseExpr<UserContext, number | undefined>
    >();
  });

  it('accepts type arguments instead, with unknown defaults', () => {
    expectTypeOf<z.infer<ExprSchema<UserContext, number>>>().toEqualTypeOf<
      Expr<UserContext, number>
    >();
    expectTypeOf(exprSchema<UserContext, number>()).toEqualTypeOf<
      ExprSchema<UserContext, number>
    >();
    expectTypeOf(exprSchema()).toEqualTypeOf<ExprSchema<unknown, unknown>>();
    expectTypeOf(exprSchema({ context: UserContext })).toEqualTypeOf<
      ExprSchema<UserContext, unknown>
    >();
    expectTypeOf(exprSchema({ returns: z.string() })).toEqualTypeOf<
      ExprSchema<unknown, string>
    >();
  });

  it('infers from schema outputs, not inputs', () => {
    expectTypeOf(
      exprSchema({
        context: z.object({ count: z.string().transform(Number) }),
        returns: z.enum(['a', 'b']).default('a'),
      }),
    ).toEqualTypeOf<ExprSchema<{ count: number }, 'a' | 'b'>>();
  });

  it('accepts Zod Mini schemas', () => {
    expectTypeOf(
      exprSchema({
        context: zm.object({ a: zm.number() }),
        returns: zm.boolean(),
      }),
    ).toEqualTypeOf<ExprSchema<{ a: number }, boolean>>();
  });

  it('checks schemas against explicit type arguments', () => {
    exprSchema<UserContext, boolean>({
      context: UserContext,
      returns: z.boolean(),
    });
    // @ts-expect-error the context schema must produce the declared Context
    exprSchema<{ user: string }, boolean>({ context: UserContext });
    // @ts-expect-error the return schema must produce the declared ReturnType
    exprSchema<UserContext, boolean>({ returns: z.number() });
    // @ts-expect-error options must be Zod schemas
    exprSchema({ context: { user: z.string() } });
  });
});

describe('zod-inferred config types', () => {
  const Config = z.object({
    canEnter: exprSchema({ context: UserContext, returns: z.boolean() }),
    score: looseExprSchema({ context: UserContext, returns: z.number() }),
    label: exprSchema({
      context: UserContext,
      returns: z.enum(['adult', 'minor']),
    }).optional(),
  });
  type Config = z.infer<typeof Config>;

  it('contextually types expr() callbacks like an Expr annotation', () => {
    ({
      canEnter: expr(
        ctx => ctx.user.age >= 18 && (ctx.user.profile?.score ?? 0) > 1,
      ),
      // LooseExpr: no `?.` needed through the optional profile.
      score: expr(ctx => ctx.user.profile.score ?? 0),
      label: expr(ctx => (ctx.user.age >= 18 ? 'adult' : 'minor')),
    }) satisfies Config;
  });

  it('rejects callbacks that do not match the schemas', () => {
    const strictProfile: Config['canEnter'] = expr(
      // @ts-expect-error a strict Expr context still requires `?.` on optional paths
      ctx => ctx.user.profile.score > 1,
    );

    // @ts-expect-error the `returns` schema fixes the callback's return type
    const wrongReturn: Config['canEnter'] = expr(ctx => ctx.user.age);

    const wrongProperty: Config['canEnter'] = expr(
      // @ts-expect-error the `context` schema fixes the available properties
      ctx => ctx.user.agee > 1,
    );

    ({
      // @ts-expect-error enum return schemas narrow the allowed results
      label: expr(ctx => (ctx.user.age >= 18 ? 'adult' : 'teen')),
    }) satisfies Partial<Config>;
  });

  it('types parsed values the same way', () => {
    const parsed = Config.parse({});
    expectTypeOf(parsed.canEnter).toEqualTypeOf<Expr<UserContext, boolean>>();
    expectTypeOf(parsed.score).toEqualTypeOf<LooseExpr<UserContext, number>>();
    expectTypeOf(parsed.label).toEqualTypeOf<
      Expr<UserContext, 'adult' | 'minor'> | undefined
    >();
  });
});
