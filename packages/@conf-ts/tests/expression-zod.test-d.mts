// `Expr` is branded with a `unique symbol`, and @conf-ts/expr-core ships
// separate .d.mts and .d.cts declarations, each with its own symbol. This
// package is CommonJS, so expression-zod.test-d.ts resolves the `require`
// declarations; this file checks the `import` ones, so `z.infer` stays
// identical to the `Expr` @conf-ts/macro re-exports there too, e.g. if either
// build ever inlined `Expr` instead of importing it from @conf-ts/expr-core.
import { ExprSchema, LooseExprSchema } from '@conf-ts/expression/zod';
import type { Expr, LooseExpr } from '@conf-ts/macro';
import { describe, expectTypeOf, it } from 'vitest';
import * as z from 'zod';

const UserContext = z.object({
  user: z.object({ age: z.number() }),
});
type UserContext = z.infer<typeof UserContext>;

describe('@conf-ts/expression/zod ESM types', () => {
  it('infers the Expr and LooseExpr types exported by @conf-ts/macro', () => {
    const canEnter = ExprSchema({ context: UserContext, returns: z.boolean() });
    expectTypeOf<z.infer<typeof canEnter>>().toEqualTypeOf<
      Expr<UserContext, boolean>
    >();
    expectTypeOf<z.infer<ExprSchema<UserContext, boolean>>>().toEqualTypeOf<
      Expr<UserContext, boolean>
    >();

    const age = LooseExprSchema({ context: UserContext, returns: z.number() });
    expectTypeOf<z.infer<typeof age>>().toEqualTypeOf<
      LooseExpr<UserContext, number>
    >();
    expectTypeOf<z.infer<LooseExprSchema<UserContext, number>>>().toEqualTypeOf<
      LooseExpr<UserContext, number>
    >();
  });
});
