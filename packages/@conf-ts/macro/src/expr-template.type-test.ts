import {
  expr,
  exprTemplate,
  type Expr,
  type ExprTemplate,
  type LooseExpr,
  type LooseExprTemplate,
} from './index';

type Context = {
  value: number;
  optional?: {
    deep?: {
      value: number;
    };
  };
};

const add = exprTemplate<Context, number, [number]>(
  (ctx, amount) => ctx.value + amount,
);
const addType: ExprTemplate<Context, number, [number]> = add;
const resultType: Expr<Context, number> = addType(1);

const loose: LooseExprTemplate<Context, boolean, [number]> = exprTemplate(
  (ctx, minimum) => (ctx.optional.deep.value ?? 0) > minimum,
);
const looseResult: LooseExpr<Context, boolean> = loose(1);

// @ts-expect-error the first callback parameter is always Context
exprTemplate<Context, number, [number]>((ctx: string, amount) => amount);

// @ts-expect-error the template parameter tuple controls invocation arity
add();

// @ts-expect-error the template parameter tuple controls invocation argument types
add('1');

void expr;
void resultType;
void looseResult;
