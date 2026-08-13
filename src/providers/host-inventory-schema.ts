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

export const providerHostInventoryRecordSchema = z
  .object({
    ref: hostRefSchema,
    status: z.enum(['live', 'retired-blocked', 'reclamation-failed']),
    spec: providerHostSpecSchema,
    host: z.record(providerHostMetadataValueSchema),
    diagnostics: providerHostDiagnosticsSchema,
    diagnosticsRetention: z.object({ ownerBudgetTruncated: z.boolean() }).strict(),
  })
  .strict();

export const providerHostInventorySchema = z.array(providerHostInventoryRecordSchema);

type DeepReadonly<Value> = Value extends readonly (infer Entry)[]
  ? readonly DeepReadonly<Entry>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export type ProviderHostDiagnosticsWire = DeepReadonly<z.output<typeof providerHostDiagnosticsSchema>>;
export type ProviderHostInventoryRecordWire = Omit<
  DeepReadonly<z.output<typeof providerHostInventoryRecordSchema>>,
  'diagnostics'
> &
  Readonly<{ diagnostics: ProviderHostDiagnosticsWire }>;
