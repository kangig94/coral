import { MAX_PROCESS_INCARNATION_LENGTH, type ProcessIncarnation } from '../infra/node-process.js';
import type { DurableCliProcessSubject } from '../runtime/ports.js';
import { z } from 'zod';

const MAX_RUNTIME_META_BYTES = 4096;
const TRUNCATED_CONTAINMENT_REASON_SUFFIX = ' [truncated]';

const canonicalUuidSchema = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const positiveSafeIntegerSchema = z.number().int().positive().safe();

function durableProcessIncarnation() {
  return z.string().min(1).max(MAX_PROCESS_INCARNATION_LENGTH) as unknown as z.ZodType<ProcessIncarnation>;
}

export const DURABLE_CLI_PROCESS_RUNTIME_META_VERSION = 2 as const;
export const DURABLE_CLI_PROCESS_RUNTIME_META_PREDECESSOR_VERSION = 1 as const;
export const DURABLE_CLI_PROVISIONAL_PROCESS_RUNTIME_META_VERSION = 1 as const;
export const DURABLE_CLI_CONTAINMENT_STATUS_VERSION = 1 as const;

export const durableCliProcessRuntimeMetaV1Schema = z
  .object({
    version: z.literal(DURABLE_CLI_PROCESS_RUNTIME_META_PREDECESSOR_VERSION),
    jobId: canonicalUuidSchema,
    pid: nonNegativeSafeIntegerSchema,
    incarnation: durableProcessIncarnation(),
  })
  .strict()
  .readonly();

export type DurableCliProcessRuntimeMetaV1 = z.infer<typeof durableCliProcessRuntimeMetaV1Schema>;

/** A new payload generation must move to a new key generation. */
export const durableCliProcessRuntimeMetaSchema: z.ZodType<DurableCliProcessRuntimeMeta> = z
  .object({
    jobId: canonicalUuidSchema,
    pid: positiveSafeIntegerSchema,
    incarnation: durableProcessIncarnation(),
    processGroupId: positiveSafeIntegerSchema,
    childRoot: z
      .object({
        pid: positiveSafeIntegerSchema,
        incarnation: durableProcessIncarnation(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export type DurableCliProcessRuntimeMeta = Readonly<{ jobId: string }> & DurableCliProcessSubject;

export const durableCliProvisionalProcessRuntimeMetaSchema = z
  .object({
    jobId: canonicalUuidSchema,
    pid: positiveSafeIntegerSchema,
    incarnation: durableProcessIncarnation(),
    processGroupId: positiveSafeIntegerSchema,
  })
  .strict()
  .readonly();

export type DurableCliProvisionalProcessRuntimeMeta = z.infer<typeof durableCliProvisionalProcessRuntimeMetaSchema>;

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

export function durableCliProvisionalProcessRuntimeMetaKey(jobId: string): string {
  return `durable_cli_provisional_process.v${DURABLE_CLI_PROVISIONAL_PROCESS_RUNTIME_META_VERSION}:${jobId}`;
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

export function encodeDurableCliProvisionalProcessRuntimeMeta(meta: DurableCliProvisionalProcessRuntimeMeta): string {
  const result = durableCliProvisionalProcessRuntimeMetaSchema.safeParse(meta);
  if (!result.success) {
    throw new Error(`Durable CLI provisional process runtime meta failed schema validation: ${result.error.message}`, {
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

export function decodeDurableCliProvisionalProcessRuntimeMeta(
  raw: string | null | undefined,
): DurableCliProvisionalProcessRuntimeMeta | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_RUNTIME_META_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = durableCliProvisionalProcessRuntimeMetaSchema.safeParse(parsed);
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
  const encoded = JSON.stringify(result.data);
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_RUNTIME_META_BYTES) return encoded;
  if (result.data.disposition.kind !== 'held') {
    throw new Error('Durable CLI containment status exceeds the maximum serialized size.');
  }

  const truncatedStatus = truncateContainmentReason(result.data);
  const truncatedEncoded = JSON.stringify(truncatedStatus);
  if (Buffer.byteLength(truncatedEncoded, 'utf8') > MAX_RUNTIME_META_BYTES) {
    throw new Error('Durable CLI containment status fixed fields exceed the maximum serialized size.');
  }
  return truncatedEncoded;
}

function truncateContainmentReason(status: DurableCliContainmentStatus): DurableCliContainmentStatus {
  if (status.disposition.kind !== 'held') return status;

  const statusWithSuffix = {
    ...status,
    disposition: { ...status.disposition, reason: TRUNCATED_CONTAINMENT_REASON_SUFFIX },
  };
  const reasonByteBudget = MAX_RUNTIME_META_BYTES - Buffer.byteLength(JSON.stringify(statusWithSuffix), 'utf8');
  let retainedReason = '';
  let retainedBytes = 0;
  for (const character of status.disposition.reason) {
    const characterBytes = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (retainedBytes + characterBytes > reasonByteBudget) break;
    retainedReason += character;
    retainedBytes += characterBytes;
  }

  return {
    ...status,
    disposition: {
      ...status.disposition,
      reason: `${retainedReason}${TRUNCATED_CONTAINMENT_REASON_SUFFIX}`,
    },
  };
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
