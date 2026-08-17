import { processIncarnationSchema } from '../infra/node-process.js';
import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod';

import { persistedProviderNameSchema } from '../providers/registry.js';

const canonicalUuidSchema = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const fingerprintSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
const canonicalEndpointSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => isAbsolute(value) && normalize(value) === value, 'endpoint must be an absolute canonical path')
  .describe('absolute normalized filesystem path');
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const receiptSchema = z.string().min(1).max(4096);
const directiveReasonSchema = z.string().min(1).max(4096);
const directiveCodeSchema = z.string().min(1).max(128);
const providerAbortCauseSchema = z.enum(['signal_abort', 'user_abort', 'queue_shutdown']);
const providerStopCauseSchema = z.enum(['restart', 'handoff', 'signal_abort', 'user_abort', 'queue_shutdown']);
const MAX_PROVIDER_OPERATION_RECORD_BYTES = 64 * 1024;
const MAX_PRINCIPAL_WIRE_BYTES = 64 * 1024;

const persistedPrincipalWireSchema = z
  .object({
    subject: z.enum(['operator', 'agent', 'system']),
    binding: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('unbound') }).strict(),
      z.object({ kind: z.literal('project'), root: z.string().min(1) }).strict(),
    ]),
    attenuatedCaps: z
      .array(
        z.enum([
          'liveness',
          'kb:read',
          'kb:write',
          'kb:source:import',
          'jobs:read',
          'jobs:control',
          'discuss:participate',
          'expansion:manage',
          'system:shutdown',
          'system:debug',
        ]),
      )
      .optional(),
  })
  .strict();

export const providerOperationIdentitySchema = z
  .object({
    jobId: canonicalUuidSchema,
    operationId: canonicalUuidSchema,
    proxyInstanceId: canonicalUuidSchema,
    buildSetId: canonicalUuidSchema,
  })
  .strict();

const processLocatorSchema = z
  .object({
    instanceId: canonicalUuidSchema,
    pid: nonNegativeSafeIntegerSchema,
    incarnation: processIncarnationSchema,
    controlEndpoint: canonicalEndpointSchema,
  })
  .strict();

export const providerOperationSetLocatorSchema = z
  .object({
    hostFingerprint: fingerprintSchema,
    proxy: processLocatorSchema,
    guardian: processLocatorSchema,
    reaper: processLocatorSchema,
    containment: z
      .object({
        pid: nonNegativeSafeIntegerSchema,
        incarnation: processIncarnationSchema,
        processGroupId: nonNegativeSafeIntegerSchema,
        kind: z.string().min(1).max(64),
      })
      .strict(),
  })
  .strict()
  .superRefine((locator, context) => {
    if (
      locator.containment.pid !== locator.proxy.pid ||
      locator.containment.incarnation !== locator.proxy.incarnation
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['containment'],
        message: 'containment must identify the proxy process',
      });
    }
  })
  .describe('containment pid and incarnation equal the proxy process identity');

const providerRootSchema = z
  .object({
    pid: nonNegativeSafeIntegerSchema,
    incarnation: processIncarnationSchema,
  })
  .strict();

export const providerOperationActivationAckSchema = z
  .object({
    state: z.literal('executing'),
    activationFingerprint: fingerprintSchema,
    startedAt: z.string().datetime(),
    hostRef: z.discriminatedUnion('leaseMode', [
      z
        .object({
          provider: persistedProviderNameSchema,
          fingerprint: fingerprintSchema,
          instanceId: z.string().min(1).max(1024),
          leaseMode: z.literal('shared'),
        })
        .strict(),
      z
        .object({
          provider: persistedProviderNameSchema,
          fingerprint: fingerprintSchema,
          instanceId: z.string().min(1).max(1024),
          leaseMode: z.literal('job-exclusive'),
          ownerJobId: canonicalUuidSchema,
        })
        .strict(),
    ]),
    committedThroughProviderSeq: nonNegativeSafeIntegerSchema,
  })
  .strict();

const childAuthorizationSchema = z
  .object({
    principalWire: persistedPrincipalWireSchema,
    namespace: z.string().min(1).max(1024),
    expiresAtMs: nonNegativeSafeIntegerSchema,
  })
  .strict()
  .superRefine((authorization, context) => {
    if (Buffer.byteLength(JSON.stringify(authorization.principalWire), 'utf8') > MAX_PRINCIPAL_WIRE_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['principalWire'],
        message: `principal wire exceeds the ${MAX_PRINCIPAL_WIRE_BYTES}-byte limit`,
      });
    }
  });

export const providerOperationPrepareSourceSchema = z
  .object({
    jobLaunchEventSeq: nonNegativeSafeIntegerSchema,
    sessionId: canonicalUuidSchema,
    sessionVersion: z.number().int().positive().safe(),
    platform: z.string().min(1).max(64),
    childAuthorization: childAuthorizationSchema,
  })
  .strict();

const localAuthorizedDirectiveSchema = z
  .object({ kind: z.literal('local-authorized'), reason: directiveReasonSchema })
  .strict();
export const providerOperationTerminalFailedDirectiveSchema = z
  .object({ kind: z.literal('terminal-failed'), code: directiveCodeSchema, reason: directiveReasonSchema })
  .strict();
const terminalAbortedDirectiveSchema = z
  .object({
    kind: z.literal('terminal-aborted'),
    cause: providerAbortCauseSchema,
    requestedAt: z.string().datetime(),
  })
  .strict();

export const providerOperationAfterReleaseDirectiveSchema = z.discriminatedUnion('kind', [
  localAuthorizedDirectiveSchema,
  providerOperationTerminalFailedDirectiveSchema,
  terminalAbortedDirectiveSchema,
]);

export const providerOperationNeverStartedDirectiveSchema = z.discriminatedUnion('kind', [
  localAuthorizedDirectiveSchema,
  terminalAbortedDirectiveSchema,
]);

export const providerOperationControlIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run') }).strict(),
  z.object({ kind: z.literal('stop'), cause: providerStopCauseSchema, requestedAt: z.string().datetime() }).strict(),
]);

const lastErrorSchema = z
  .object({
    observedAtMs: nonNegativeSafeIntegerSchema,
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
  })
  .strict()
  .nullable();

/**
 * The generation of this record, and the only place it is written down.
 *
 * It is not only the payload's `version` field — `provider-operation-journal.ts` derives the meta-key namespace
 * from it, so moving this number moves the address the rows live at. That coupling is the point. A shipped
 * reader selects rows by key prefix and then parses them strictly; a payload field it never reaches cannot warn
 * it. v0.10.8 renamed nothing and moved nothing, so its `provider_operation_saga.v1:` selector would have
 * matched the incarnation-bearing rows this build writes, and its bare strict decode on the startup claim scan
 * would have thrown — the older daemon simply would not boot. The rows have to be somewhere it does not look.
 *
 * Bump this whenever the durable shape stops satisfying the previous generation's schema, moving the old
 * current generation into `retainedSuperseded` so its jobs keep their fence.
 *
 * Two fields rather than a derived pair because TypeScript loses the literal through a slice, and the literal
 * is what makes `z.literal` and every downstream narrowing work. What keeps them honest is
 * `tests/invariants/provider-operation-generation-registry.test.ts`, which asserts they are contiguous and
 * disjoint — so raising `current` while forgetting `retainedSuperseded` fails there rather than leaving a
 * generation neither decoded nor fenced.
 */
export const PROVIDER_OPERATION_RECORD_GENERATIONS = {
  retainedSuperseded: [1],
  current: 2,
} as const;

export const PROVIDER_OPERATION_RECORD_VERSION = PROVIDER_OPERATION_RECORD_GENERATIONS.current;

const commonFields = {
  version: z.literal(PROVIDER_OPERATION_RECORD_VERSION),
  operation: providerOperationIdentitySchema,
  locator: providerOperationSetLocatorSchema,
  prepareAttemptNumber: z.number().int().positive().safe(),
  prepareAttemptKey: fingerprintSchema,
  revision: nonNegativeSafeIntegerSchema,
  retryNotBeforeMs: nonNegativeSafeIntegerSchema,
  retryCount: nonNegativeSafeIntegerSchema,
  lastError: lastErrorSchema,
} as const;

const preparationEvidenceFields = {
  reservation: canonicalUuidSchema,
  providerRoot: providerRootSchema,
  jointContainmentReceipt: receiptSchema,
} as const;

const authorizedFields = {
  ...preparationEvidenceFields,
  jointActivationReceipt: receiptSchema,
} as const;

const executingFields = {
  ...authorizedFields,
  activationAck: providerOperationActivationAckSchema,
  committedThroughProviderSeq: nonNegativeSafeIntegerSchema,
} as const;

const preparePendingSchema = z
  .object({
    ...commonFields,
    phase: z.literal('prepare-pending'),
    prepareSource: providerOperationPrepareSourceSchema,
  })
  .strict();

const guardianActivationPendingSchema = z
  .object({
    ...commonFields,
    ...preparationEvidenceFields,
    phase: z.literal('guardian-activation-pending'),
  })
  .strict();

const proxyActivationPendingSchema = z
  .object({
    ...commonFields,
    ...authorizedFields,
    phase: z.literal('proxy-activation-pending'),
  })
  .strict();

const executingSchema = z
  .object({
    ...commonFields,
    ...executingFields,
    phase: z.literal('executing'),
    controlIntent: providerOperationControlIntentSchema,
  })
  .strict();

const prestartCleanupPendingSchema = z
  .object({
    ...commonFields,
    phase: z.literal('prestart-cleanup-pending'),
    cleanupIntent: z.literal('release-never-started'),
    afterRelease: providerOperationAfterReleaseDirectiveSchema,
  })
  .strict();

// This is not an unknown phase: remote cleanup is complete and generic job recovery is the exact next owner.
const localRecoveryPendingSchema = z
  .object({
    ...commonFields,
    phase: z.literal('local-recovery-pending'),
    recoveryIntent: z.literal('recover-local'),
    reason: directiveReasonSchema,
  })
  .strict();

const activationResolutionPendingSchema = z
  .object({
    ...commonFields,
    ...authorizedFields,
    phase: z.literal('activation-resolution-pending'),
    onNeverStarted: providerOperationNeverStartedDirectiveSchema,
    activationIndeterminate: providerOperationTerminalFailedDirectiveSchema,
  })
  .strict();

const settlementPendingSchema = z
  .object({
    ...commonFields,
    ...executingFields,
    phase: z.literal('settlement-pending'),
    terminalProviderSeq: nonNegativeSafeIntegerSchema,
    settlementIntent: z.literal('release-after-terminal'),
  })
  .strict();

export const providerOperationRecordSchema = z
  .discriminatedUnion('phase', [
    preparePendingSchema,
    guardianActivationPendingSchema,
    proxyActivationPendingSchema,
    executingSchema,
    prestartCleanupPendingSchema,
    localRecoveryPendingSchema,
    activationResolutionPendingSchema,
    settlementPendingSchema,
  ])
  .superRefine((record, context) => {
    if (record.operation.proxyInstanceId !== record.locator.proxy.instanceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locator', 'proxy', 'instanceId'],
        message: 'locator must identify the operation proxy',
      });
    }
    if (
      (record.phase === 'executing' || record.phase === 'settlement-pending') &&
      record.committedThroughProviderSeq < record.activationAck.committedThroughProviderSeq
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['committedThroughProviderSeq'],
        message: 'provider watermark cannot precede the activation acknowledgement',
      });
    }
    if (
      (record.phase === 'executing' || record.phase === 'settlement-pending') &&
      record.activationAck.hostRef.fingerprint !== record.locator.hostFingerprint
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activationAck', 'hostRef', 'fingerprint'],
        message: 'activation host fingerprint must equal the durable locator',
      });
    }
    if (
      (record.phase === 'executing' || record.phase === 'settlement-pending') &&
      record.activationAck.hostRef.leaseMode === 'job-exclusive' &&
      record.activationAck.hostRef.ownerJobId !== record.operation.jobId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activationAck', 'hostRef', 'ownerJobId'],
        message: 'job-exclusive activation host must belong to the operation job',
      });
    }
    if (record.phase === 'settlement-pending' && record.terminalProviderSeq !== record.committedThroughProviderSeq) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminalProviderSeq'],
        message: 'terminal watermark must equal the committed provider watermark',
      });
    }
  })
  .describe(
    'operation proxy equals its locator; provider watermark follows activation and equals terminal watermark at settlement',
  );

export type ProviderOperationIdentity = Readonly<z.infer<typeof providerOperationIdentitySchema>>;
export type ProviderOperationPrepareSource = Readonly<z.infer<typeof providerOperationPrepareSourceSchema>>;
export type ProviderOperationActivationAck = Readonly<z.infer<typeof providerOperationActivationAckSchema>>;
export type ProviderOperationAfterReleaseDirective = Readonly<
  z.infer<typeof providerOperationAfterReleaseDirectiveSchema>
>;
export type ProviderOperationNeverStartedDirective = Readonly<
  z.infer<typeof providerOperationNeverStartedDirectiveSchema>
>;
export type ProviderOperationTerminalDirective = Extract<
  ProviderOperationAfterReleaseDirective,
  { kind: 'terminal-failed' | 'terminal-aborted' }
>;
export type ProviderOperationRecord = Readonly<z.infer<typeof providerOperationRecordSchema>>;
export type ProviderOperationPhase = ProviderOperationRecord['phase'];

export function providerOperationJobRecoveryOwner(
  record: ProviderOperationRecord,
): 'provider-operation-saga' | 'generic-job-recovery' {
  return record.phase === 'local-recovery-pending' ? 'generic-job-recovery' : 'provider-operation-saga';
}

export class ProviderOperationRecordCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderOperationRecordCodecError';
    Object.setPrototypeOf(this, ProviderOperationRecordCodecError.prototype);
  }
}

export function encodeProviderOperationRecord(record: ProviderOperationRecord): string {
  const parsed = providerOperationRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new ProviderOperationRecordCodecError(
      `Provider operation record failed schema validation: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  const encoded = JSON.stringify(parsed.data);
  assertProviderOperationRecordSize(encoded);
  return encoded;
}

export function decodeProviderOperationRecord(encoded: string): ProviderOperationRecord {
  assertProviderOperationRecordSize(encoded);
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error: unknown) {
    throw new ProviderOperationRecordCodecError('Provider operation record is not valid JSON.', { cause: error });
  }
  const parsed = providerOperationRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderOperationRecordCodecError(
      `Provider operation record failed schema validation: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function assertProviderOperationRecordSize(encoded: string): void {
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > MAX_PROVIDER_OPERATION_RECORD_BYTES) {
    throw new ProviderOperationRecordCodecError(
      `Provider operation record is ${bytes} bytes, exceeding the ${MAX_PROVIDER_OPERATION_RECORD_BYTES}-byte limit.`,
    );
  }
}
