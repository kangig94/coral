import { z } from 'zod';

/** Durable aggregate that owns a unit of executable work. */
export const executionOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider-session'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('workflow'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('discussion'), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('system-task'), id: z.string().min(1) }).strict(),
]);

export type ExecutionOwner = z.infer<typeof executionOwnerSchema>;
