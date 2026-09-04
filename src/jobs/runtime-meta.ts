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
export const DURABLE_CLI_PROCESS_RUNTIME_META_PREDECESSOR_VERSION = 1 as const;
export const DURABLE_CLI_CONTAINMENT_STATUS_VERSION = 1 as const;

export const durableCliProcessRuntimeMetaV1Schema = z
  .object({
    jobId: canonicalUuidSchema,
    pid: positiveSafeIntegerSchema,
    incarnation: processIncarnationSchema,
  })
  .strict()
  .readonly();

export type DurableCliProcessRuntimeMetaV1 = z.infer<typeof durableCliProcessRuntimeMetaV1Schema>;

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

export const durableCliProcessRuntimeEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('current'),
      record: durableCliProcessRuntimeMetaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('predecessor'),
      record: durableCliProcessRuntimeMetaV1Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      reason: z.enum(['missing', 'corrupt-current', 'corrupt-predecessor', 'identity-mismatch']),
    })
    .strict(),
]);

export type DurableCliProcessRuntimeEvidence = z.infer<typeof durableCliProcessRuntimeEvidenceSchema>;

export const durableCliContainmentStatusSchema = z
  .object({
    jobId: canonicalUuidSchema,
    evidence: durableCliProcessRuntimeEvidenceSchema,
    disposition: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('held'),
          reason: z.string().min(1),
          retryIntervalMs: positiveSafeIntegerSchema,
          abandonment: z.literal('abort-job'),
        })
        .strict(),
      z
        .object({
          kind: z.literal('operator-abandoned'),
          processAbsenceProven: z.literal(false),
        })
        .strict(),
    ]),
  })
  .strict()
  .readonly();

export type DurableCliContainmentStatus = z.infer<typeof durableCliContainmentStatusSchema>;

/** Only the coordinator may write this key. */
export function durableCliProcessRuntimeMetaKey(jobId: string): string {
  return `durable_cli_process.v${DURABLE_CLI_PROCESS_RUNTIME_META_VERSION}:${jobId}`;
}

export function durableCliProcessRuntimeMetaV1Key(jobId: string): string {
  return `durable_cli_process.v${DURABLE_CLI_PROCESS_RUNTIME_META_PREDECESSOR_VERSION}:${jobId}`;
}

export function durableCliContainmentStatusKey(jobId: string): string {
  return `durable_cli_containment_status.v${DURABLE_CLI_CONTAINMENT_STATUS_VERSION}:${jobId}`;
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

/** Unusable durable identity bytes must degrade to evidence-unavailable rather than abort coordinator startup. */
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

export function decodeDurableCliProcessRuntimeMetaV1(
  raw: string | null | undefined,
): DurableCliProcessRuntimeMetaV1 | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_RUNTIME_META_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = durableCliProcessRuntimeMetaV1Schema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function encodeDurableCliContainmentStatus(status: DurableCliContainmentStatus): string {
  const result = durableCliContainmentStatusSchema.safeParse(status);
  if (!result.success) {
    throw new Error(`Durable CLI containment status failed schema validation: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return JSON.stringify(result.data);
}

export function decodeDurableCliContainmentStatus(raw: string | null | undefined): DurableCliContainmentStatus | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_RUNTIME_META_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = durableCliContainmentStatusSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
