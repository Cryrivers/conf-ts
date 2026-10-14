import { expr } from '@conf-ts/macro';

import type { AccessConfig } from './expr-zod.schema';

const MINIMUM_ROLES = 1;

// No type arguments: satisfying the zod-inferred config type gives every
// callback its context and return type, and LooseExpr fields skip `?.`.
export default {
  canEnter: expr(
    ctx =>
      ctx.user.age >= ctx.minimumAge && ctx.user.roles.length >= MINIMUM_ROLES,
  ),
  tier: expr(ctx => (ctx.user.roles.includes('admin') ? 'staff' : 'member')),
  verified: expr(ctx => ctx.user.profile.verified),
} satisfies AccessConfig;
