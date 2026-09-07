import { isAbsolute, normalize, resolve } from 'node:path';

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
  z
    .object({
      owner: z.literal('provider-proxy'),
      hostKey: z.string(),
      ownerJobId: z.string().nullable(),
      pid: positiveSafeIntegerSchema.optional(),
      reclamationAttempts: positiveSafeIntegerSchema,
      reclamationFailure: z.string(),
      reclamationRetryable: z.boolean(),
    })
    .strict(),
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
export const coordinatorShutdownHeldProviderHostInventoryRecordSchema = z
  .object({
    ...providerHostInventoryCommonShape,
    status: z.literal('shutdown-held'),
    host: z
      .object({
        owner: z.literal('coordinator'),
        hostKey: z.string(),
        identityKey: z.string(),
        ownerJobId: z.string().nullable(),
        pid: positiveSafeIntegerSchema,
        processGroupId: positiveSafeIntegerSchema,
        observation: z.enum(['alive', 'unobservable']),
        successorOwner: z.string().min(1).nullable(),
        operatorExit: z.string().min(1),
      })
      .strict()
      .refine(({ pid, processGroupId }) => processGroupId === pid, {
        message: 'processGroupId must equal pid for a coordinator-owned provider host',
        path: ['processGroupId'],
      }),
  })
  .strict();

export const proxyShutdownHeldProviderHostInventoryRecordSchema = z
  .object({
    ...providerHostInventoryCommonShape,
    status: z.literal('shutdown-held'),
    host: z
      .object({
        owner: z.literal('provider-proxy'),
        hostKey: z.string(),
        ownerJobId: z.string().nullable(),
        pid: positiveSafeIntegerSchema,
        observation: z.enum(['alive', 'unobservable']),
        successorOwner: z.string().min(1).nullable(),
        operatorExit: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const providerHostInventoryV1NonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const providerHostInventoryV1PositiveSafeIntegerSchema = z.number().int().positive().safe();
const providerHostInventoryV1CanonicalWorkDirSchema = z
  .string()
  .refine(
    (value) => isAbsolute(value) && normalize(value) === value && resolve(value) === value,
    'Work directory must be absolute and normalized',
  )
  .describe('canonical-work-dir-wire')
  .brand<'CanonicalWorkDir'>();
const providerHostInventoryV1HostRefIdentitySchema = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    fingerprint: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    instanceId: z.string().min(1).max(1024),
  })
  .strict();
const providerHostInventoryV1HostRefSchema = z.discriminatedUnion('leaseMode', [
  z.object({ ...providerHostInventoryV1HostRefIdentitySchema.shape, leaseMode: z.literal('shared') }).strict(),
  z
    .object({
      ...providerHostInventoryV1HostRefIdentitySchema.shape,
      leaseMode: z.literal('job-exclusive'),
      ownerJobId: z.string().min(1).max(1024),
    })
    .strict(),
]);
const providerHostInventoryV1LogEntrySchema = z
  .object({
    seq: providerHostInventoryV1NonNegativeSafeIntegerSchema,
    observedAt: z.number(),
    stream: z.literal('stderr'),
    text: z.string(),
    startTruncated: z.literal(true).optional(),
  })
  .strict();
const providerHostInventoryV1LogSpanSchema = z
  .object({
    startSeq: providerHostInventoryV1NonNegativeSafeIntegerSchema,
    endSeq: providerHostInventoryV1NonNegativeSafeIntegerSchema,
    truncated: z.boolean(),
    historical: z.array(providerHostInventoryV1LogEntrySchema),
    during: z.array(providerHostInventoryV1LogEntrySchema),
    after: z.array(providerHostInventoryV1LogEntrySchema),
  })
  .strict();
const providerHostInventoryV1ResponseSchema = z.discriminatedUnion('kind', [
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
const providerHostInventoryV1DiagnosticFactSchema = z
  .object({
    factSeq: providerHostInventoryV1NonNegativeSafeIntegerSchema,
    generation: providerHostInventoryV1NonNegativeSafeIntegerSchema,
    requestId: providerHostInventoryV1NonNegativeSafeIntegerSchema,
    method: z.string(),
    response: providerHostInventoryV1ResponseSchema,
    hostLog: providerHostInventoryV1LogSpanSchema,
  })
  .strict();
const providerHostInventoryV1CommonShape = {
  ref: providerHostInventoryV1HostRefSchema,
  spec: z
    .object({
      provider: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()),
      cwd: providerHostInventoryV1CanonicalWorkDirSchema.nullable(),
      leaseMode: z.enum(['shared', 'job-exclusive']),
      idleRetirement: z.enum(['unleased', 'unleased-and-host-idle', 'never']).nullable(),
    })
    .strict(),
  diagnostics: z
    .object({
      hostLog: z
        .object({
          entries: z.array(providerHostInventoryV1LogEntrySchema),
          retainedBytes: providerHostInventoryV1NonNegativeSafeIntegerSchema,
          truncatedBeforeSeq: providerHostInventoryV1NonNegativeSafeIntegerSchema,
        })
        .strict(),
      completedObservations: z.array(providerHostInventoryV1DiagnosticFactSchema),
      factsTruncatedBeforeSeq: providerHostInventoryV1NonNegativeSafeIntegerSchema,
    })
    .strict(),
  diagnosticsRetention: z.object({ ownerBudgetTruncated: z.boolean() }).strict(),
};
const providerHostInventoryV1ReclamationFailureShape = {
  owner: z.literal('coordinator'),
  hostKey: z.string(),
  identityKey: z.string(),
  ownerJobId: z.string().nullable(),
  reclamationAttempts: providerHostInventoryV1PositiveSafeIntegerSchema,
  reclamationFailure: z.string(),
  reclamationRetryable: z.boolean(),
};

export const providerHostInventoryRecordV1Schema = z.discriminatedUnion('status', [
  z
    .object({
      ...providerHostInventoryV1CommonShape,
      status: z.literal('live'),
      host: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    })
    .strict(),
  z
    .object({
      ...providerHostInventoryV1CommonShape,
      status: z.literal('retired-blocked'),
      host: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    })
    .strict(),
  z
    .object({
      ...providerHostInventoryV1CommonShape,
      status: z.literal('reclamation-failed'),
      host: z.union([
        z.object(providerHostInventoryV1ReclamationFailureShape).strict(),
        z
          .object({
            ...providerHostInventoryV1ReclamationFailureShape,
            pid: providerHostInventoryV1PositiveSafeIntegerSchema,
            processGroupId: providerHostInventoryV1PositiveSafeIntegerSchema,
          })
          .strict()
          .refine(({ pid, processGroupId }) => processGroupId === pid, {
            message: 'processGroupId must equal pid for a coordinator-owned provider host',
            path: ['processGroupId'],
          }),
      ]),
    })
    .strict(),
]);

export const providerHostInventoryRecordSchema = z.union([
  liveProviderHostInventoryRecordSchema,
  retiredBlockedProviderHostInventoryRecordSchema,
  reclamationFailedProviderHostInventoryRecordSchema,
  coordinatorShutdownHeldProviderHostInventoryRecordSchema,
  proxyShutdownHeldProviderHostInventoryRecordSchema,
]);

export const providerHostInventorySchema = z.array(providerHostInventoryRecordSchema);

type DeepReadonly<Value> = Value extends readonly (infer Entry)[]
  ? readonly DeepReadonly<Entry>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export type ProviderHostInventoryRecordWire = DeepReadonly<z.output<typeof providerHostInventoryRecordSchema>>;
