import { expr } from '@conf-ts/macro';

const THRESHOLD = 10;
const LABEL = 'line\n"quoted"\\path';
const ENABLED = true;
const EMPTY = null;
const COMPUTED_KEY = 'nested';

enum Status {
  Active = 'active',
}

type Context = {
  value: unknown;
  number: number;
  text: string;
  label: string;
  enabled: boolean;
  status: Status;
  left: unknown;
  right: unknown;
  user?: { profile: { score: number } } | null;
  nested: { score: number };
  extra: Record<string, unknown>;
  object: { removable?: number; present?: number };
  key: string;
  score?: number | null;
  Constructor: abstract new (...args: any[]) => object;
  instance: object;
  counter: {
    value: number;
    add(this: { value: number }, amount: number): number;
  };
  increment: number;
  fail(): never;
};

export default {
  capturedNumber: expr<Context, boolean>(
    ctx => ctx.number > THRESHOLD,
  ),
  capturedString: expr<Context, boolean>(ctx => ctx.label === LABEL),
  capturedBoolean: expr<Context, boolean>(ctx => ctx.enabled === ENABLED),
  capturedNull: expr<Context, boolean>(ctx => ctx.value === EMPTY),
  capturedEnum: expr<Context, boolean>(ctx => ctx.status === Status.Active),
  computedKey: expr<Context, number>(ctx => ctx[COMPUTED_KEY].score),
  asExpression: expr<Context, number>(ctx => ctx.number as number),
  satisfiesExpression: expr<Context, number>(
    ctx => ctx.number satisfies number,
  ),
  nonNullExpression: expr<Context, number>(ctx => ctx.number!),
  optionalChain: expr<Context, number | undefined>(
    ctx => ctx.user?.profile.score,
  ),
  objectExpression: expr<Context, Record<string, unknown>>(
    ctx => ({ value: ctx.number, ...ctx.extra }),
  ),
  arrayExpression: expr<Context, unknown[]>(
    ctx => [ctx.number, , THRESHOLD],
  ),
  templateExpression: expr<Context, string>(
    ctx => `value=${ctx.number}:${LABEL}`,
  ),
  unaryPlus: expr<Context, number>(ctx => +ctx.text),
  logicalAnd: expr<Context, unknown>(ctx => ctx.left && ctx.right),
  bitwise: expr<Context, number>(ctx => (ctx.number << 1) | 1),
  methodCall: expr<Context, number>(
    ctx => ctx.counter.add(ctx.increment),
  ),
  deleteProperty: expr<Context, boolean>(
    ctx => delete ctx.object.removable,
  ),
  inOperator: expr<Context, boolean>(ctx => ctx.key in ctx.object),
  instanceOf: expr<Context, boolean>(
    ctx => ctx.instance instanceof ctx.Constructor,
  ),
  missingMember: expr<Context, number>(
    ctx => ctx.user!.profile.score,
  ),
  throwingCall: expr<Context, never>(ctx => ctx.fail()),
  nullishCoalescing: expr<Context, unknown>(ctx => ctx.value ?? ctx.right),
  logicalOr: expr<Context, unknown>(ctx => ctx.left || ctx.right),
  conditional: expr<Context, string>(
    ctx => ctx.enabled ? ctx.status : ctx.right,
  ),
  voidExpr: expr<Context, undefined>(ctx => void ctx.number),
  typeofExpr: expr<Context, string>(ctx => typeof ctx.value),
  bitwiseNot: expr<Context, number>(ctx => ~ctx.number),
  unaryNegate: expr<Context, number>(ctx => -ctx.number),
  unaryNot: expr<Context, boolean>(ctx => !ctx.enabled),
  equality: expr<Context, boolean>(ctx => ctx.number == ctx.text),
  inequality: expr<Context, boolean>(ctx => ctx.number != ctx.text),
  strictInequality: expr<Context, boolean>(
    ctx => ctx.number !== THRESHOLD,
  ),
  exponentiation: expr<Context, number>(
    ctx => ctx.increment ** ctx.increment,
  ),
  modulo: expr<Context, number>(ctx => ctx.number % ctx.increment),
  nestedTernary: expr<Context, string>(
    ctx => ctx.number > THRESHOLD ? "high" : ctx.number > 5 ? "mid" : "low",
  ),
  comparison: expr<Context, boolean>(
    ctx => ctx.number >= THRESHOLD && ctx.number <= THRESHOLD,
  ),
  shiftRight: expr<Context, number>(ctx => ctx.number >> 1),
  shiftRightZeroFill: expr<Context, number>(ctx => ctx.number >>> 1),
  bitwiseXor: expr<Context, number>(ctx => ctx.number ^ ctx.increment),
  parenthesizedNullishComparison: expr<Context, boolean>(
    ctx => (ctx.score ?? 0) >= 80,
  ),
};
