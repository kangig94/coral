import { z } from 'zod';

import { durableCliRuntimePublicationEvidenceSchema } from './durable-cli-runtime-evidence.js';
import { serializedThrownIdentifierSchema, serializedThrownSchema } from './error-format.js';

export const SHUTDOWN_REASONS = [
  'replaced',
  'sigterm',
  'sigint',
  'provider-proxy-lifecycle-fatal',
  'idle',
  'test-teardown',
] as const;

export type ShutdownReason = (typeof SHUTDOWN_REASONS)[number];

export const SHUTDOWN_MODES = ['handoff', 'hard'] as const;

export type ShutdownMode = (typeof SHUTDOWN_MODES)[number];

const SHUTDOWN_MODE_BY_REASON: Readonly<Record<ShutdownReason, ShutdownMode>> = {
  replaced: 'handoff',
  sigterm: 'handoff',
  'provider-proxy-lifecycle-fatal': 'handoff',
  sigint: 'hard',
  idle: 'hard',
  'test-teardown': 'hard',
};

export function shutdownModeFromReason(reason: ShutdownReason): ShutdownMode {
  return SHUTDOWN_MODE_BY_REASON[reason];
}

export function shutdownReasonModeMatches(reason: ShutdownReason, mode: ShutdownMode): boolean {
  return mode === shutdownModeFromReason(reason);
}

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

const PERSISTED_SINGLE_LINE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u;
const persistedFactSchema = z.string().min(1).max(256).regex(PERSISTED_SINGLE_LINE_PATTERN);
const settlementSchema = z.discriminatedUnion('cause', [
  z.object({ cause: z.literal('rejected'), error: serializedThrownSchema }),
  z.object({ cause: z.literal('aborted'), error: serializedThrownSchema }),
  z.object({ cause: z.literal('timed-out'), budgetMs: z.number().int().positive() }),
  z.object({ cause: z.literal('budget-exhausted') }),
  z.object({ cause: z.literal('unconfirmed'), detail: z.string() }),
]);
const shutdownRemainderSubjectSchema = z.object({ kind: z.literal('discuss-store'), source: z.string() });
const successorRecoveryEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('startup-adoption'),
    processes: z.array(durableCliRuntimePublicationEvidenceSchema).readonly(),
  }),
  z.object({ kind: z.literal('startup-store-recovery') }),
  z.object({ kind: z.literal('startup-liveness-recovery') }),
]);

export const shutdownHoldReasonSchema = z.literal('required-shutdown-step-unsettled');
export const shutdownHoldExitSchema = z.enum(['shutdown-budget-exhaustion', 'authority-release-settlement']);
export const shutdownRetainedAuthoritySchema = z.object({
  ipcSocket: z.boolean(),
  providerControlProxyInstanceIds: z.array(serializedThrownIdentifierSchema).readonly(),
  cleanupObligations: z.array(persistedFactSchema).readonly(),
});
export const shutdownRemainderEntrySchema = z.object({
  label: persistedFactSchema,
  subject: shutdownRemainderSubjectSchema.optional(),
  remainder: z.discriminatedUnion('owner', [
    z.object({ owner: z.literal('process-exit') }),
    z.object({
      owner: z.literal('successor-recovery'),
      evidence: successorRecoveryEvidenceSchema,
    }),
  ]),
  settlement: settlementSchema,
});
const scheduledShutdownAutomaticRetrySchema = z.object({
  status: z.literal('scheduled'),
  attemptsStarted: z.number().int().nonnegative(),
  attemptLimit: z.number().int().positive(),
});
const failedShutdownAutomaticRetrySchema = z.object({ status: z.literal('failed') });
const shutdownLastDeclinedSchema = z.object({
  attempt: z.number().int().positive(),
  reason: shutdownHoldReasonSchema,
  exit: shutdownHoldExitSchema,
  undischarged: z.array(shutdownRemainderEntrySchema).readonly(),
  retainedAuthority: shutdownRetainedAuthoritySchema,
});
const shutdownRemainderObservationSchema = z.object({
  elapsedMs: z.number().finite().nonnegative(),
  boundMs: z.number().finite().nonnegative(),
  attempt: z.object({
    started: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }),
  lastDeclined: shutdownLastDeclinedSchema.optional(),
});

function refineShutdownReasonMode(
  value: Readonly<{ reason: ShutdownReason; mode: ShutdownMode }>,
  context: z.RefinementCtx,
): void {
  if (!shutdownReasonModeMatches(value.reason, value.mode)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: 'mode does not match reason' });
  }
}

const shutdownRemainderProjectionBaseSchema = shutdownRemainderObservationSchema.extend({
  reason: z.enum(SHUTDOWN_REASONS),
  mode: z.enum(SHUTDOWN_MODES),
});

const shutdownRemainderProjectionEnvelopeUnionSchema = z.union([
  shutdownRemainderProjectionBaseSchema.extend({
    automaticRetry: z.undefined().optional(),
    lastDeclined: shutdownLastDeclinedSchema.optional(),
  }),
  shutdownRemainderProjectionBaseSchema.extend({
    automaticRetry: scheduledShutdownAutomaticRetrySchema,
    lastDeclined: shutdownLastDeclinedSchema,
  }),
  shutdownRemainderProjectionBaseSchema.extend({
    automaticRetry: failedShutdownAutomaticRetrySchema,
    lastDeclined: shutdownLastDeclinedSchema,
  }),
]);

type ShutdownRemainderProjectionCandidate = z.infer<typeof shutdownRemainderProjectionEnvelopeUnionSchema>;

function validateShutdownAttemptProgression(
  projection: ShutdownRemainderProjectionCandidate,
  context: z.RefinementCtx,
): void {
  if (projection.attempt.started > projection.attempt.limit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attempt', 'started'],
      message: 'started attempts exceed the attempt limit',
    });
  }
  if (projection.lastDeclined !== undefined && projection.lastDeclined.attempt > projection.attempt.started) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastDeclined', 'attempt'],
      message: 'declined attempt was not started',
    });
  }
  if (projection.lastDeclined !== undefined && projection.lastDeclined.attempt >= projection.attempt.limit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastDeclined', 'attempt'],
      message: 'declined attempt reached the terminal attempt limit',
    });
  }
  if (
    projection.automaticRetry === undefined &&
    projection.lastDeclined !== undefined &&
    projection.lastDeclined.attempt === projection.attempt.started
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastDeclined', 'attempt'],
      message: 'current declined attempt has no automatic retry disposition',
    });
  }
}

function validateScheduledShutdownRetry(
  projection: ShutdownRemainderProjectionCandidate,
  context: z.RefinementCtx,
): void {
  if (projection.automaticRetry?.status !== 'scheduled' || projection.lastDeclined === undefined) return;
  if (projection.automaticRetry.attemptsStarted !== projection.attempt.started) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['automaticRetry', 'attemptsStarted'],
      message: 'automatic retry attempts do not match the shutdown attempt',
    });
  }
  if (projection.automaticRetry.attemptLimit !== projection.attempt.limit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['automaticRetry', 'attemptLimit'],
      message: 'automatic retry limit does not match the shutdown attempt limit',
    });
  }
  if (projection.lastDeclined.attempt !== projection.attempt.started) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastDeclined', 'attempt'],
      message: 'scheduled automatic retry does not follow the current declined attempt',
    });
  }
}

function validateFailedShutdownRetry(projection: ShutdownRemainderProjectionCandidate, context: z.RefinementCtx): void {
  if (
    projection.automaticRetry?.status === 'failed' &&
    projection.lastDeclined !== undefined &&
    projection.lastDeclined.attempt + 1 !== projection.attempt.started
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['automaticRetry', 'status'],
      message: 'failed automatic retry does not follow the preceding declined attempt',
    });
  }
}

export const shutdownRemainderProjectionEnvelopeSchema = shutdownRemainderProjectionEnvelopeUnionSchema.superRefine(
  (projection, context) => {
    refineShutdownReasonMode(projection, context);
    validateShutdownAttemptProgression(projection, context);
    validateScheduledShutdownRetry(projection, context);
    validateFailedShutdownRetry(projection, context);
  },
);

export type ShutdownRemainderSubject = DeepReadonly<z.infer<typeof shutdownRemainderSubjectSchema>>;
export type SuccessorRecoveryEvidence = DeepReadonly<z.infer<typeof successorRecoveryEvidenceSchema>>;
export type UndischargedRemainder =
  | Readonly<{ owner: 'process-exit' }>
  | Readonly<{ owner: 'successor-recovery'; evidence: SuccessorRecoveryEvidence }>;
export type ShutdownHoldReason = z.infer<typeof shutdownHoldReasonSchema>;
export type ShutdownHoldExit = z.infer<typeof shutdownHoldExitSchema>;
export type ShutdownRetainedAuthority = DeepReadonly<z.infer<typeof shutdownRetainedAuthoritySchema>>;
export type ShutdownAutomaticRetry = NonNullable<ShutdownRemainderProjection['automaticRetry']>;
export type ShutdownUndischarged = DeepReadonly<z.infer<typeof shutdownRemainderEntrySchema>>;
export type ShutdownRemainderObservation = DeepReadonly<z.infer<typeof shutdownRemainderObservationSchema>>;
export type ShutdownRemainderProjection = DeepReadonly<z.infer<typeof shutdownRemainderProjectionEnvelopeSchema>>;
