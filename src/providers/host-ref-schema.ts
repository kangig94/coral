import { z } from 'zod';

import { persistedProviderNameSchema } from './registry.js';

const hostRefIdentitySchema = z
  .object({
    provider: persistedProviderNameSchema,
    fingerprint: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    instanceId: z.string().min(1).max(1024),
  })
  .strict();

export const hostRefSchema = z.discriminatedUnion('leaseMode', [
  z.object({ ...hostRefIdentitySchema.shape, leaseMode: z.literal('shared') }).strict(),
  z
    .object({
      ...hostRefIdentitySchema.shape,
      leaseMode: z.literal('job-exclusive'),
      ownerJobId: z.string().min(1).max(1024),
    })
    .strict(),
]);
