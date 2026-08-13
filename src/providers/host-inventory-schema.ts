import { z } from 'zod';

import { canonicalWorkDirWireSchema } from '../runtime/canonical-work-dir.js';
import type { HostRef as CanonicalHostRef } from './contract.js';
import { hostRefSchema } from './host-ref-schema.js';

export type HostRef = CanonicalHostRef;

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const providerHostLogEntrySchema = z
  .object({
    seq: nonNegativeSafeIntegerSchema,
    observedAt: z.number(),
    stream: z.literal('stderr'),
    text: z.string(),
    startTruncated: z.literal(true).optional(),
  })
  .strict();
const providerHostLogSpanSchema = z
  .object({
    startSeq: nonNegativeSafeIntegerSchema,
    endSeq: nonNegativeSafeIntegerSchema,
    truncated: z.boolean(),
    historical: z.array(providerHostLogEntrySchema),
    during: z.array(providerHostLogEntrySchema),
    after: z.array(providerHostLogEntrySchema),
  })
  .strict();
const providerHostResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success') }).strict(),
  z
    .object({
      kind: z.literal('failure'),
      rpcCode: z.number().optional(),
      providerMessage: z.string().optional(),
      providerData: z.unknown().optional(),
    })
    .strict(),
]);
const providerHostDiagnosticFactSchema = z
  .object({
    factSeq: nonNegativeSafeIntegerSchema,
    generation: nonNegativeSafeIntegerSchema,
    requestId: nonNegativeSafeIntegerSchema,
    method: z.string(),
    response: providerHostResponseSchema,
    hostLog: providerHostLogSpanSchema,
  })
  .strict();
const providerHostDiagnosticsSchema = z
  .object({
    hostLog: z
      .object({
        entries: z.array(providerHostLogEntrySchema),
        retainedBytes: nonNegativeSafeIntegerSchema,
        truncatedBeforeSeq: nonNegativeSafeIntegerSchema,
      })
      .strict(),
    completedObservations: z.array(providerHostDiagnosticFactSchema),
    factsTruncatedBeforeSeq: nonNegativeSafeIntegerSchema,
  })
  .strict();
const providerHostSpecSchema = z
  .object({
    provider: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: canonicalWorkDirWireSchema.nullable(),
    leaseMode: z.enum(['shared', 'job-exclusive']),
    idleRetirement: z.enum(['unleased', 'unleased-and-host-idle', 'never']).nullable(),
  })
  .strict();
const providerHostMetadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const providerHostInventoryCommonShape = {
  ref: hostRefSchema,
  spec: providerHostSpecSchema,
  diagnostics: providerHostDiagnosticsSchema,
  diagnosticsRetention: z.object({ ownerBudgetTruncated: z.boolean() }).strict(),
};
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const reclamationFailureMetadataShape = {
  owner: z.literal('coordinator'),
  hostKey: z.string(),
  identityKey: z.string(),
  ownerJobId: z.string().nullable(),
  reclamationAttempts: positiveSafeIntegerSchema,
  reclamationFailure: z.string(),
  reclamationRetryable: z.boolean(),
};
const reclamationFailureMetadataSchema = z.union([
  z.object(reclamationFailureMetadataShape).strict(),
  z
    .object({
      ...reclamationFailureMetadataShape,
      pid: positiveSafeIntegerSchema,
      processGroupId: positiveSafeIntegerSchema,
    })
    .strict()
    .refine(({ pid, processGroupId }) => processGroupId === pid, {
      message: 'processGroupId must equal pid for a coordinator-owned provider host',
      path: ['processGroupId'],
    }),
]);

export const liveProviderHostInventoryRecordSchema = z
  .object({
    ...providerHostInventoryCommonShape,
    status: z.literal('live'),
    host: z.record(providerHostMetadataValueSchema),
  })
  .strict();
export const retiredBlockedProviderHostInventoryRecordSchema = z
  .object({
    ...providerHostInventoryCommonShape,
    status: z.literal('retired-blocked'),
    host: z.record(providerHostMetadataValueSchema),
  })
  .strict();
export const reclamationFailedProviderHostInventoryRecordSchema = z
  .object({
    ...providerHostInventoryCommonShape,
    status: z.literal('reclamation-failed'),
    host: reclamationFailureMetadataSchema,
  })
  .strict();

export const providerHostInventoryRecordSchema = z.discriminatedUnion('status', [
  liveProviderHostInventoryRecordSchema,
  retiredBlockedProviderHostInventoryRecordSchema,
  reclamationFailedProviderHostInventoryRecordSchema,
]);

export const providerHostInventorySchema = z.array(providerHostInventoryRecordSchema);

type DeepReadonly<Value> = Value extends readonly (infer Entry)[]
  ? readonly DeepReadonly<Entry>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export type ProviderHostInventoryRecordWire = DeepReadonly<z.output<typeof providerHostInventoryRecordSchema>>;
