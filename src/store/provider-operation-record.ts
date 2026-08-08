import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod';

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
const receiptSchema = z.string().min(1);
const MAX_PROVIDER_OPERATION_RECORD_BYTES = 64 * 1024;

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
    processStartedAtSeconds: nonNegativeSafeIntegerSchema,
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
        processStartedAtSeconds: nonNegativeSafeIntegerSchema,
        processGroupId: nonNegativeSafeIntegerSchema,
        kind: z.string().min(1).max(64),
      })
      .strict(),
  })
  .strict()
  .superRefine((locator, context) => {
    if (
      locator.containment.pid !== locator.proxy.pid ||
      locator.containment.processStartedAtSeconds !== locator.proxy.processStartedAtSeconds
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['containment'],
        message: 'containment must identify the proxy process',
      });
    }
  })
  .describe('containment pid and start time equal the proxy process identity');

const providerRootSchema = z
  .object({
    pid: nonNegativeSafeIntegerSchema,
    processStartedAtSeconds: nonNegativeSafeIntegerSchema,
  })
  .strict();

export const providerOperationActivationAckSchema = z
  .object({
    state: z.literal('executing'),
    committedThroughProviderSeq: nonNegativeSafeIntegerSchema,
  })
  .strict();

const lastErrorSchema = z
  .object({
    observedAtMs: nonNegativeSafeIntegerSchema,
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
  })
  .strict()
  .nullable();

const commonFields = {
  version: z.literal(1),
  operation: providerOperationIdentitySchema,
  locator: providerOperationSetLocatorSchema,
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
  })
  .strict();

const prestartCleanupPendingSchema = z
  .object({
    ...commonFields,
    reservation: canonicalUuidSchema,
    phase: z.literal('prestart-cleanup-pending'),
    cleanupIntent: z.literal('release-never-started'),
  })
  .strict();

const activationResolutionPendingSchema = z
  .object({
    ...commonFields,
    ...authorizedFields,
    phase: z.literal('activation-resolution-pending'),
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
export type ProviderOperationActivationAck = Readonly<z.infer<typeof providerOperationActivationAckSchema>>;
export type ProviderOperationRecord = Readonly<z.infer<typeof providerOperationRecordSchema>>;
export type ProviderOperationPhase = ProviderOperationRecord['phase'];

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
