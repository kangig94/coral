import { processIncarnationSchema } from '#src/infra/node-process.js';
import { z } from 'zod';

const canonicalUuidSchema = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

const historicalDurableCliProcessRuntimeMetaSchema = z
  .object({
    version: z.literal(1),
    jobId: canonicalUuidSchema,
    pid: nonNegativeSafeIntegerSchema,
    incarnation: processIncarnationSchema,
  })
  .strict();

type HistoricalDurableCliProcessRuntimeMeta = z.infer<typeof historicalDurableCliProcessRuntimeMetaSchema>;

export function encodeHistoricalDurableCliProcessRuntimeMeta(meta: HistoricalDurableCliProcessRuntimeMeta): string {
  const result = historicalDurableCliProcessRuntimeMetaSchema.safeParse(meta);
  if (!result.success) {
    throw new Error(`Historical durable CLI process runtime meta failed schema validation: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return JSON.stringify(result.data);
}
