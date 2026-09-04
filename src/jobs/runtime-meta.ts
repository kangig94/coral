import { processIncarnationSchema } from '../infra/node-process.js';
import type { DurableCliProcessSubject } from '../runtime/ports.js';
import { z } from 'zod';

const MAX_RUNTIME_META_BYTES = 4096;

const canonicalUuidSchema = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const positiveSafeIntegerSchema = z.number().int().positive().safe();

export const DURABLE_CLI_PROCESS_RUNTIME_META_VERSION = 2 as const;

/** A new payload generation must move to a new key generation. */
export const durableCliProcessRuntimeMetaSchema: z.ZodType<DurableCliProcessRuntimeMeta> = z
  .object({
    jobId: canonicalUuidSchema,
    pid: positiveSafeIntegerSchema,
    incarnation: processIncarnationSchema,
    processGroupId: positiveSafeIntegerSchema,
    childRoot: z
      .object({
        pid: positiveSafeIntegerSchema,
        incarnation: processIncarnationSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export type DurableCliProcessRuntimeMeta = Readonly<{ jobId: string }> & DurableCliProcessSubject;

/** Only the coordinator may write this key. */
export function durableCliProcessRuntimeMetaKey(jobId: string): string {
  return `durable_cli_process.v${DURABLE_CLI_PROCESS_RUNTIME_META_VERSION}:${jobId}`;
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
