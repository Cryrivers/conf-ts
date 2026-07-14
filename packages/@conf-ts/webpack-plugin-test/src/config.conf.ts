import a from './a';
import b from './b';
import c from './c';
import {
  arrayFilter,
  arrayFlatMap,
  arrayMap,
  Boolean,
  env,
  expr,
  Number,
  String,
  type LooseExpr,
} from '@conf-ts/macro';

const services = [
  { name: 'api', replicas: 3, enabled: true },
  { name: 'worker', replicas: 2, enabled: false },
  { name: 'scheduler', replicas: 1, enabled: true },
];
const MIN_SCORE = 80;

type RequestContext = {
  user?: { score: number } | null;
  stage: string;
  region: string;
  retries: number;
  primary?: string;
  fallback: string;
};

const x: { a: LooseExpr<RequestContext, string> } = {
  a: expr<RequestContext, string>(ctx => ctx.user?.score.toString() ?? '0'),
};

export const d = c.value + 1;
export default {
  name: 'test-config',
  version: '1.0.0',
  env: 'development',
  port: 3000,
  a,
  b,
  macros: {
    activeServices: arrayMap(
      arrayFilter(services, service => service.enabled),
      service => `${service.name}:${String(service.replicas)}`,
    ),
    replicaSlots: arrayFlatMap(services, service =>
      service.enabled
        ? [service.name, `${service.name}-backup`]
        : [],
    ),
    casts: {
      number: Number('42'),
      boolean: Boolean(1),
      string: String(2026),
    },
    target: env('CONF_TS_WEBPACK_TARGET', 'local'),
  },
  expressions: {
    canRelease: expr<RequestContext, boolean>(
      ctx =>
        (ctx.user?.score ?? 0) >= MIN_SCORE &&
        ctx.stage === env('CONF_TS_WEBPACK_STAGE', 'production'),
    ),
    label: expr<RequestContext, string>(
      ctx => `${ctx.region}:${String(ctx.retries)}`,
    ),
    destination: expr<RequestContext, string>(
      ctx => ctx.primary ?? ctx.fallback,
    ),
    priority: expr<RequestContext, string>(ctx =>
      ctx.retries === 0 ? 'high' : ctx.retries < 3 ? 'normal' : 'low',
    ),
  },
};
