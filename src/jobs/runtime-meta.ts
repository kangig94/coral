import { processIncarnationSchema } from '../infra/node-process.js';
import { z } from 'zod';

const MAX_RUNTIME_META_BYTES = 4096;

const canonicalUuidSchema = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

/**
 * `durable_cli_process.v1:<jobId>` — the recorded identity of one durable CLI child.
 *
 * Small on purpose. A durable CLI has no operation tuple and no control channel, so the only thing that can
 * later be checked against it is which process was launched — and a pid alone cannot answer that, because
 * the OS recycles it. Pairing the pid with the process's incarnation token is what makes "the process we
 * launched is still running" distinguishable from "some unrelated process now holds that number".
 *
 * This is ordinary key/value `meta`, not domain history or a substitute for `job.runtime.started`, because
 * its only consumer is conservative process observation after restart.
 */
export const durableCliProcessRuntimeMetaSchema = z
  .object({
    version: z.literal(1),
    jobId: canonicalUuidSchema,
    pid: nonNegativeSafeIntegerSchema,
    incarnation: processIncarnationSchema,
  })
  .strict();

export type DurableCliProcessRuntimeMeta = z.infer<typeof durableCliProcessRuntimeMetaSchema>;

/** The meta table key for one durable CLI child's recorded identity. Only the coordinator writes this key. */
export function durableCliProcessRuntimeMetaKey(jobId: string): string {
  return `durable_cli_process.v1:${jobId}`;
}

export function encodeDurableCliProcessRuntimeMeta(meta: DurableCliProcessRuntimeMeta): string {
  const result = durableCliProcessRuntimeMetaSchema.safeParse(meta);
  if (!result.success) {
    throw new Error(`Durable CLI process runtime meta failed schema validation: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return JSON.stringify(result.data);
}

/**
 * Decodes a recorded durable CLI identity, or reports that there is nothing usable to check against.
 *
 * `null` rather than a throw, and deliberately so: every failure here — absent row, corrupt bytes, a shape
 * from some other writer — means the same thing to the only caller that asks, which is that observation has
 * no recorded identity and must answer `unknown`. Making that an exception would push a decision the
 * classifier already models into a `catch` at every call site.
 */
export function decodeDurableCliProcessRuntimeMeta(
  raw: string | null | undefined,
): DurableCliProcessRuntimeMeta | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_RUNTIME_META_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = durableCliProcessRuntimeMetaSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
