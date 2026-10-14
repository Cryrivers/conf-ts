import { exprSchema, looseExprSchema } from '@conf-ts/macro/zod';
import * as z from 'zod';

export const AccessContext = z.object({
  user: z.object({
    age: z.number(),
    roles: z.array(z.enum(['admin', 'editor', 'viewer'])),
    profile: z.object({ verified: z.boolean() }).optional(),
  }),
  minimumAge: z.number(),
});

export const AccessConfig = z.object({
  canEnter: exprSchema({ context: AccessContext, returns: z.boolean() }),
  tier: exprSchema({
    context: AccessContext,
    returns: z.enum(['staff', 'member']),
  }),
  verified: looseExprSchema({
    context: AccessContext,
    returns: z.boolean().optional(),
  }),
});

export type AccessConfig = z.infer<typeof AccessConfig>;
