import { z } from 'zod';

import { strictBundleManifestSchema, type StrictBundleIdentityFailure } from '../infra/bundle-manifest.js';
import { assertNever } from '../infra/error-format.js';
import { createMonotonicClock } from '../infra/monotonic-clock.js';
import { processIncarnationSchema } from '../infra/node-process.js';
import type { IdPort, Runtime } from '../runtime/ports.js';
import type { RecordedProcessIdentity } from '../infra/process-containment.js';
import {
  HandoffRoutingStoreInvalidRecordError,
  HandoffRoutingStoreUnreadableError,
  HandoffRoutingStoreUnsupportedGenerationError as UnsupportedGenerationError,
  publishHandoffRoutingStoreTransaction,
  readHandoffRoutingStoreSnapshot,
  SQLITE_BUSY,
  SQLITE_CORRUPT,
  SQLITE_ERROR,
  SQLITE_FULL,
  SQLITE_NOTADB,
  type HandoffRoutingRecordInput,
  type HandoffRoutingRecordValidationFailure,
  type HandoffRoutingRecordValidationResult,
  type HandoffRoutingStatusTransaction,
  type HandoffRoutingStatusStoreSchema,
} from '../store/handoff-routing-status-store.js';
import {
  tryAcquireGenerationWriterLease,
  type GenerationWriterLease,
} from '../store/generation-mutation-coordination.js';
import {
  HANDOFF_ROUTING_BASIS_OBLIGATIONS,
  buildSummarySchema,
  incumbentIdentitySummarySchema,
  type BuildSummary,
  type HandoffRoutingBasis,
  type RoutingBasisObligation,
} from './handoff-routing.js';
import type { ABSENT_HANDOFF_RESULT_OBLIGATION, HANDOFF_CONTINUATION_REASON_OBLIGATIONS } from './handoff-runner.js';

export const HANDOFF_ROUTING_STATUS_GENERATION = 1;
export const MAX_HANDOFF_ROUTING_STATUS_BYTES = 1_048_576;
export const MAX_RETIREMENT_TOMBSTONES = 128;
export const MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES = 2_161;
export const MAX_RETIREMENT_TOMBSTONE_BYTES = MAX_RETIREMENT_TOMBSTONES * MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES;
export const MAX_UNRESOLVED_INVOCATIONS = 64;
export const MAX_HANDOFF_ROUTING_OWNER_SWEEP_MS = 500;
export const MAX_COMPLETED_HANDOFF_ROUTING_PAIRS = 256;
export const HANDOFF_ROUTING_COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const MAX_BOUNDED_TERMINAL_HISTORY = MAX_COMPLETED_HANDOFF_ROUTING_PAIRS;

const MAX_IDENTIFIER_LENGTH = 58;
const MAX_OBSERVED_AT_LENGTH = 24;
const MAX_SIGNAL_LENGTH = 16;

const sequenceSchema = z.number().int().nonnegative().safe();
const positiveSequenceSchema = z.number().int().positive().safe();
const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
const observedAtSchema = z.string().datetime({ offset: false, precision: 3 }).length(MAX_OBSERVED_AT_LENGTH);

export const validatedTargetSummarySchema = z.object({ build: buildSummarySchema }).strict().readonly();

export type ValidatedTargetSummary = z.infer<typeof validatedTargetSummarySchema>;

const invalidTargetFailureSchema = z.enum([
  'bundle-dir-not-canonical',
  'bundle-dir-unavailable',
  'expected-manifest-invalid',
  'adjacent-manifest-unavailable',
  'adjacent-manifest-invalid',
  'adjacent-manifest-mismatch',
  'adjacent-bundle-mismatch',
]);

export const invalidTargetSummarySchema = z
  .object({
    failure: invalidTargetFailureSchema,
    expectedBuild: buildSummarySchema.optional(),
  })
  .strict()
  .readonly();

export type InvalidTargetSummary = z.infer<typeof invalidTargetSummarySchema>;

const strictBundleIdentityFailureSchema: z.ZodType<StrictBundleIdentityFailure> = z.enum([
  'embedded_identity_unavailable',
  'adjacent_manifest_unavailable',
  'adjacent_manifest_invalid',
  'adjacent_manifest_mismatch',
]);

export const durableHandoffRoutingBasisSchema = z.union([
  z
    .object({ kind: z.literal('incumbent-absent') })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('incumbent-unresolved'),
      cause: z.enum(['unreadable-record', 'health-request-failed', 'health-shape-rejected']),
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('incumbent-unusable'), cause: z.enum(['draining', 'identity-mismatch']) })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('invoking-identity-unavailable'), failure: strictBundleIdentityFailureSchema })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('incumbent-identity-unavailable'), incumbent: incumbentIdentitySummarySchema })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('same-build-set'), buildSetId: strictBundleManifestSchema.shape.buildSetId })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('invoking-build-not-older'),
      comparison: z.enum(['same-version', 'newer-version']),
      invoking: buildSummarySchema,
      incumbent: buildSummarySchema,
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('invalid-incumbent-target'), evidence: invalidTargetSummarySchema })
    .strict()
    .readonly(),
]);

export type DurableHandoffRoutingBasis = z.infer<typeof durableHandoffRoutingBasisSchema>;

export type RoutingStatusPolicy =
  | Readonly<{ durability: 'ephemeral'; severity: 'info' | 'warning'; exitContribution: 0 | 75 }>
  | Readonly<{
      durability: 'lifecycle-journal';
      retention: 'until-terminal' | 'until-superseded' | 'bounded-history' | 'until-resolved';
      severity: 'info' | 'warning';
      exitContribution: 0 | 75;
    }>;

export type ObligationPolicyProjection =
  | Readonly<{ kind: 'ephemeral'; policy: Extract<RoutingStatusPolicy, { durability: 'ephemeral' }> }>
  | Readonly<{ kind: 'persisted'; policy: Extract<RoutingStatusPolicy, { durability: 'lifecycle-journal' }> }>;

type ObligationPolicyProjectionFor<Obligation extends RoutingBasisObligation> =
  Obligation['requiredDurability'] extends 'ephemeral-allowed'
    ? Readonly<{
        kind: 'ephemeral';
        policy: Readonly<{
          durability: 'ephemeral';
          severity: Obligation['severity'];
          exitContribution: Obligation['exitContribution'];
        }>;
      }>
    : Readonly<{
        kind: 'persisted';
        policy: Readonly<{
          durability: 'lifecycle-journal';
          retention: Obligation['requiredRetention'];
          severity: Obligation['severity'];
          exitContribution: Obligation['exitContribution'];
        }>;
      }>;

export function projectRoutingObligationToPolicy(obligation: RoutingBasisObligation): ObligationPolicyProjection {
  if (obligation.requiredDurability === 'ephemeral-allowed') {
    return {
      kind: 'ephemeral',
      policy: {
        durability: 'ephemeral',
        severity: obligation.severity,
        exitContribution: obligation.exitContribution,
      },
    };
  }

  return {
    kind: 'persisted',
    policy: {
      durability: 'lifecycle-journal',
      retention: obligation.requiredRetention,
      severity: obligation.severity,
      exitContribution: obligation.exitContribution,
    },
  };
}

function requirePersistedProjection(
  obligation: RoutingBasisObligation,
): Extract<RoutingStatusPolicy, { durability: 'lifecycle-journal' }> {
  const projection = projectRoutingObligationToPolicy(obligation);
  if (projection.kind === 'persisted') return projection.policy;
  throw new Error('A routing basis cannot project to ephemeral status.');
}

export const HANDOFF_ROUTING_BASIS_POLICIES: Readonly<
  Record<HandoffRoutingBasis['kind'], Extract<RoutingStatusPolicy, { durability: 'lifecycle-journal' }>>
> = Object.freeze({
  'incumbent-absent': requirePersistedProjection(HANDOFF_ROUTING_BASIS_OBLIGATIONS['incumbent-absent']),
  'incumbent-unresolved': requirePersistedProjection(HANDOFF_ROUTING_BASIS_OBLIGATIONS['incumbent-unresolved']),
  'incumbent-unusable': requirePersistedProjection(HANDOFF_ROUTING_BASIS_OBLIGATIONS['incumbent-unusable']),
  'invoking-identity-unavailable': requirePersistedProjection(
    HANDOFF_ROUTING_BASIS_OBLIGATIONS['invoking-identity-unavailable'],
  ),
  'incumbent-identity-unavailable': requirePersistedProjection(
    HANDOFF_ROUTING_BASIS_OBLIGATIONS['incumbent-identity-unavailable'],
  ),
  'same-build-set': requirePersistedProjection(HANDOFF_ROUTING_BASIS_OBLIGATIONS['same-build-set']),
  'invoking-build-not-older': requirePersistedProjection(HANDOFF_ROUTING_BASIS_OBLIGATIONS['invoking-build-not-older']),
  'invalid-incumbent-target': requirePersistedProjection(HANDOFF_ROUTING_BASIS_OBLIGATIONS['invalid-incumbent-target']),
});

type HandoffContinuationReasonObligations = typeof HANDOFF_CONTINUATION_REASON_OBLIGATIONS;

export const HANDOFF_CONTINUATION_REASON_POLICY_PROJECTIONS: Readonly<{
  [Kind in keyof HandoffContinuationReasonObligations]: ObligationPolicyProjectionFor<
    HandoffContinuationReasonObligations[Kind]
  >;
}> = Object.freeze({
  'handoff-not-applicable': {
    kind: 'ephemeral',
    policy: { durability: 'ephemeral', severity: 'info', exitContribution: 0 },
  },
  'handoff-abandoned': {
    kind: 'persisted',
    policy: {
      durability: 'lifecycle-journal',
      retention: 'bounded-history',
      severity: 'warning',
      exitContribution: 75,
    },
  },
});

export const ABSENT_HANDOFF_RESULT_POLICY_PROJECTION: ObligationPolicyProjectionFor<
  typeof ABSENT_HANDOFF_RESULT_OBLIGATION
> = Object.freeze({
  kind: 'ephemeral',
  policy: { durability: 'ephemeral', severity: 'info', exitContribution: 0 },
} as const);

const recordedProcessIdentitySchema: z.ZodType<RecordedProcessIdentity> = z
  .object({
    pid: z.number().int().positive().safe(),
    incarnation: processIncarnationSchema,
  })
  .strict()
  .readonly();

const selectedDispositionSchema = z.union([
  z
    .object({ kind: z.literal('continue-current'), basis: durableHandoffRoutingBasisSchema })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('handoff-selected'),
      source: z.enum(['live-incumbent', 'active-selection']),
      target: validatedTargetSummarySchema,
    })
    .strict()
    .readonly(),
]);

export type SelectedHandoffDisposition = z.infer<typeof selectedDispositionSchema>;

const executionThrowPhaseSchema = z.enum([
  'double-delegation-guard',
  'target-authority',
  'executable-check',
  'child-spawn',
  'child-outcome-wait',
]);

const signalSchema = z.custom<NodeJS.Signals>(
  (value) =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_SIGNAL_LENGTH && /^SIG[A-Z0-9+]+$/.test(value),
  { message: 'must be a bounded signal name' },
);

const finalizedDispositionSchema = z.union([
  z
    .object({
      kind: z.literal('continued-current'),
      reason: z.union([
        z
          .object({ kind: z.literal('routing'), basis: durableHandoffRoutingBasisSchema })
          .strict()
          .readonly(),
        z
          .object({ kind: z.literal('handoff-abandoned-stdout') })
          .strict()
          .readonly(),
      ]),
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('delegated-success'), version: strictBundleManifestSchema.shape.version })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('delegated-exit'),
      version: strictBundleManifestSchema.shape.version,
      exitCode: z.number().int().min(0).max(255),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('delegated-signal'),
      version: strictBundleManifestSchema.shape.version,
      signal: signalSchema,
    })
    .strict()
    .readonly(),
]);

const directTerminalDispositionSchema = z.union([
  z
    .object({ kind: z.literal('execution-failed'), throwPhase: executionThrowPhaseSchema })
    .strict()
    .readonly(),
  ...finalizedDispositionSchema.options,
]);

export type DirectTerminalDisposition = z.infer<typeof directTerminalDispositionSchema>;

const resolutionReasonSchema = z.enum(['owner-absent', 'operator-abandoned-unobservable']);

const retiredSelectionEvidenceSchema = z
  .object({
    selectionSequence: positiveSequenceSchema,
    selectedAt: observedAtSchema,
    owner: recordedProcessIdentitySchema,
    selectedDisposition: selectedDispositionSchema,
  })
  .strict()
  .readonly();

const storedTerminalDispositionSchema = z.union([
  ...directTerminalDispositionSchema.options,
  z
    .object({ kind: z.literal('failed-without-selection'), throwPhase: executionThrowPhaseSchema })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('finalized-without-selection'), terminal: finalizedDispositionSchema })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('terminal-without-retained-selection'),
      knowledge: z.literal('identity-expired-or-selection-unavailable'),
      terminal: directTerminalDispositionSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('terminal-after-operator-resolution'),
      resolutionReason: resolutionReasonSchema,
      retiredSelection: retiredSelectionEvidenceSchema,
      terminal: directTerminalDispositionSchema,
    })
    .strict()
    .readonly(),
]);

export type StoredTerminalDisposition = z.infer<typeof storedTerminalDispositionSchema>;

const eventEnvelopeSchema = z
  .object({
    generation: z.literal(HANDOFF_ROUTING_STATUS_GENERATION),
    sequence: positiveSequenceSchema,
    eventId: identifierSchema,
    invocationId: identifierSchema,
    observedAt: observedAtSchema,
  })
  .strict();

export const routingSelectedEventSchema = eventEnvelopeSchema
  .extend({
    eventKind: z.literal('routing-selected'),
    phase: z.literal('selection'),
    owner: recordedProcessIdentitySchema,
    disposition: selectedDispositionSchema,
  })
  .strict()
  .readonly();

const terminalSelectionLinkSchema = z.union([
  z
    .object({ kind: z.literal('with-selection-sequence'), selectionSequence: positiveSequenceSchema })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('without-selection') })
    .strict()
    .readonly(),
]);

export const terminalEventSchema = eventEnvelopeSchema
  .extend({
    eventKind: z.enum(['execution-failed', 'continuation-finalized']),
    phase: z.literal('terminal'),
    selection: terminalSelectionLinkSchema,
    disposition: storedTerminalDispositionSchema,
  })
  .strict()
  .superRefine((event, context) => {
    const withoutSelection = event.selection.kind === 'without-selection';
    const gapDisposition =
      event.disposition.kind === 'failed-without-selection' || event.disposition.kind === 'finalized-without-selection';
    if (withoutSelection !== gapDisposition) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal selection link does not match disposition' });
    }
    const failed =
      event.disposition.kind === 'execution-failed' || event.disposition.kind === 'failed-without-selection';
    const nestedTerminal =
      event.disposition.kind === 'finalized-without-selection' ||
      event.disposition.kind === 'terminal-without-retained-selection' ||
      event.disposition.kind === 'terminal-after-operator-resolution'
        ? event.disposition.terminal
        : null;
    const dispositionFailed = nestedTerminal === null ? failed : nestedTerminal.kind === 'execution-failed';
    if ((event.eventKind === 'execution-failed') !== dispositionFailed) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal event kind does not match disposition' });
    }
  })
  .readonly();

export type RoutingSelectedEvent = z.infer<typeof routingSelectedEventSchema>;
export type HandoffRoutingTerminalEvent = z.infer<typeof terminalEventSchema>;
export type HandoffRoutingJournalEvent = RoutingSelectedEvent | HandoffRoutingTerminalEvent;

const retirementCauseSchema = z.enum([
  'selection-evicted-at-capacity',
  'completed-pair-compaction',
  'operator-resolved',
]);

export const retirementTombstoneSchema = eventEnvelopeSchema
  .extend({
    eventKind: z.literal('retirement-tombstone'),
    phase: z.literal('retirement'),
    selectionSequence: positiveSequenceSchema,
    selectedAt: observedAtSchema,
    owner: recordedProcessIdentitySchema,
    selectedDisposition: selectedDispositionSchema,
    retirementCause: retirementCauseSchema,
    terminalExisted: z.boolean(),
    resolutionReason: resolutionReasonSchema.optional(),
  })
  .strict()
  .superRefine((tombstone, context) => {
    const resolved = tombstone.retirementCause === 'operator-resolved';
    if (resolved !== (tombstone.resolutionReason !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'operator resolution must carry its reason' });
    }
    if (resolved && tombstone.terminalExisted) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'operator resolution cannot replace a terminal pair' });
    }
  })
  .readonly();

export type RetirementTombstone = z.infer<typeof retirementTombstoneSchema>;

type StoredStatusRecord = RoutingSelectedEvent | HandoffRoutingTerminalEvent | RetirementTombstone;

type HandoffRoutingRecordEnvelope = Readonly<{
  generation: number;
  sequence: number;
  eventId: string;
  invocationId: string;
  observedAt: string;
  recordKind: string;
  eventKind: string;
  selectionSequence: number | null;
  retirementCause: string | null;
  terminalExisted: boolean | number | null;
}>;

function decodeStatusRecordBody(record: HandoffRoutingRecordEnvelope, body: unknown): StoredStatusRecord | null {
  const parsed =
    record.recordKind === 'selection'
      ? routingSelectedEventSchema.safeParse(body)
      : record.recordKind === 'terminal'
        ? terminalEventSchema.safeParse(body)
        : record.recordKind === 'retirement'
          ? retirementTombstoneSchema.safeParse(body)
          : null;
  if (parsed === null || !parsed.success) return null;

  const decoded = parsed.data;
  if (
    record.sequence !== decoded.sequence ||
    record.generation !== decoded.generation ||
    record.eventId !== decoded.eventId ||
    record.invocationId !== decoded.invocationId ||
    record.observedAt !== decoded.observedAt ||
    record.eventKind !== decoded.eventKind
  ) {
    return null;
  }
  if (decoded.phase === 'selection') {
    return record.selectionSequence === null && record.retirementCause === null && record.terminalExisted === null
      ? decoded
      : null;
  }
  if (decoded.phase === 'terminal') {
    const selectionSequence =
      decoded.selection.kind === 'with-selection-sequence' ? decoded.selection.selectionSequence : null;
    return record.selectionSequence === selectionSequence &&
      record.retirementCause === null &&
      record.terminalExisted === null
      ? decoded
      : null;
  }
  return record.selectionSequence === decoded.selectionSequence &&
    record.retirementCause === decoded.retirementCause &&
    record.terminalExisted !== null &&
    Number(record.terminalExisted) === Number(decoded.terminalExisted)
    ? decoded
    : null;
}

export function validateStatusRecordBody(record: HandoffRoutingRecordInput): HandoffRoutingRecordValidationResult {
  let body: unknown;
  try {
    body = JSON.parse(record.bodyJson);
  } catch {
    return { kind: 'malformed-json' };
  }

  const parsed =
    record.recordKind === 'selection'
      ? routingSelectedEventSchema.safeParse(body)
      : record.recordKind === 'terminal'
        ? terminalEventSchema.safeParse(body)
        : retirementTombstoneSchema.safeParse(body);
  if (!parsed.success) return { kind: 'schema-violation' };
  return decodeStatusRecordBody(record, parsed.data) === null
    ? { kind: 'envelope-body-disagreement' }
    : { kind: 'valid' };
}

export const retirementHistoryTruncatedSchema = z
  .object({
    kind: z.literal('retirement-history-truncated'),
    expiredIdentityCount: sequenceSchema,
    causes: z
      .object({
        'selection-evicted-at-capacity': sequenceSchema,
        'completed-pair-compaction': sequenceSchema,
        'operator-resolved': sequenceSchema,
      })
      .strict()
      .readonly(),
    minSelectionSequence: positiveSequenceSchema.nullable(),
    maxSelectionSequence: positiveSequenceSchema.nullable(),
    earliestSelectedAt: observedAtSchema.nullable(),
    latestSelectedAt: observedAtSchema.nullable(),
  })
  .strict()
  .superRefine((aggregate, context) => {
    const empty = aggregate.expiredIdentityCount === 0;
    const rangesEmpty =
      aggregate.minSelectionSequence === null &&
      aggregate.maxSelectionSequence === null &&
      aggregate.earliestSelectedAt === null &&
      aggregate.latestSelectedAt === null;
    if (empty !== rangesEmpty) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'retirement aggregate ranges must match its identity count',
      });
    }
    const causeTotal = Object.values(aggregate.causes).reduce((sum, count) => sum + count, 0);
    if (causeTotal !== aggregate.expiredIdentityCount) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'retirement aggregate cause counts must be total' });
    }
  })
  .readonly();

export type RetirementHistoryTruncated = z.infer<typeof retirementHistoryTruncatedSchema>;

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function completedPairIsStable(event: HandoffRoutingJournalEvent | RetirementTombstone): boolean {
  switch (event.phase) {
    case 'selection': {
      const policy = persistedHandoffDispositionPolicy(event.disposition);
      return policy.durability === 'lifecycle-journal' && policy.retention === 'until-superseded';
    }
    case 'terminal':
      switch (event.disposition.kind) {
        case 'delegated-success':
          return true;
        case 'continued-current':
        case 'delegated-exit':
        case 'delegated-signal':
        case 'execution-failed':
        case 'failed-without-selection':
        case 'finalized-without-selection':
        case 'terminal-without-retained-selection':
        case 'terminal-after-operator-resolution':
          return false;
        default:
          return assertNever(event.disposition);
      }
    case 'retirement':
      return false;
    default:
      return assertNever(event);
  }
}

const transitionEnvelopeSchema = z
  .object({
    eventId: identifierSchema,
    invocationId: identifierSchema,
    observedAt: observedAtSchema,
  })
  .strict();

const routingSelectedTransitionSchema = transitionEnvelopeSchema
  .extend({
    kind: z.literal('routing-selected'),
    owner: recordedProcessIdentitySchema,
    disposition: selectedDispositionSchema,
  })
  .strict()
  .readonly();

const terminalTransitionSchema = transitionEnvelopeSchema
  .extend({
    kind: z.enum(['execution-failed', 'continuation-finalized']),
    selection: terminalSelectionLinkSchema,
    disposition: directTerminalDispositionSchema,
  })
  .strict()
  .superRefine((transition, context) => {
    if ((transition.kind === 'execution-failed') !== (transition.disposition.kind === 'execution-failed')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal transition kind does not match disposition' });
    }
  })
  .readonly();

const operatorResolvedTransitionSchema = transitionEnvelopeSchema
  .extend({
    kind: z.literal('operator-resolved'),
    selectionSequence: positiveSequenceSchema,
    reason: resolutionReasonSchema,
  })
  .strict()
  .readonly();

export const handoffRoutingTransitionSchema = z.union([
  routingSelectedTransitionSchema,
  terminalTransitionSchema,
  operatorResolvedTransitionSchema,
]);

export type HandoffRoutingTransition = z.infer<typeof handoffRoutingTransitionSchema>;

export type PublicationOutcome =
  | Readonly<{ kind: 'committed'; sequence: number }>
  | Readonly<{
      kind: 'not-published';
      cause: 'invalid-record';
      validation: HandoffRoutingRecordValidationFailure;
    }>
  | Readonly<{
      kind: 'not-published';
      cause:
        | 'contended'
        | 'generation-maintenance'
        | 'capacity-exhausted'
        | 'io-failed'
        | 'unreadable'
        | 'unsupported-generation'
        | 'rejected-transition'
        | 'coordination-unavailable';
    }>
  | Readonly<{
      kind: 'undeterminable';
      cause: 'contended' | 'capacity-exhausted' | 'io-failed' | 'unreadable' | 'unsupported-generation';
      errcode: number;
    }>;

type HandoffRoutingPublicationPorts = Readonly<{
  time: Pick<Runtime['time'], 'monotonicNow' | 'sleep'>;
  storage: Runtime['storage'];
  ids: Pick<Runtime['ids'], 'uuid'>;
}>;

const PUBLICATION_CONTENTION_TIMEOUT_MS = 1_000;
const PUBLICATION_RETRY_DELAY_MS = 10;

class RejectedTransitionError extends Error {}

class CapacityExhaustedError extends Error {
  readonly errcode = SQLITE_FULL;
}

function insertRecord(
  transaction: HandoffRoutingStatusTransaction,
  recordKind: 'selection' | 'terminal' | 'retirement',
  event: HandoffRoutingJournalEvent | RetirementTombstone,
): number {
  const retirement = event.eventKind === 'retirement-tombstone' ? event : null;
  const selectionSequence =
    retirement?.selectionSequence ??
    (event.phase === 'terminal' && event.selection.kind === 'with-selection-sequence'
      ? event.selection.selectionSequence
      : null);
  return transaction.insertRecord({
    generation: event.generation,
    sequence: event.sequence,
    eventId: event.eventId,
    invocationId: event.invocationId,
    observedAt: event.observedAt,
    recordKind,
    eventKind: event.eventKind,
    selectionSequence,
    retirementCause: retirement?.retirementCause ?? null,
    terminalExisted: retirement?.terminalExisted ?? null,
    completedPairStable: completedPairIsStable(event),
    bodyJson: JSON.stringify(event),
  });
}

function parseRecordBody<Schema extends z.ZodTypeAny>(
  bodyJson: string | undefined,
  schema: Schema,
): z.output<Schema> | undefined {
  if (bodyJson === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(bodyJson));
  } catch {
    throw new HandoffRoutingStoreUnreadableError();
  }
}

function selectionForInvocation(
  transaction: HandoffRoutingStatusTransaction,
  invocationId: string,
): RoutingSelectedEvent | undefined {
  return parseRecordBody(transaction.recordBody(invocationId, 'selection'), routingSelectedEventSchema);
}

function terminalForInvocation(
  transaction: HandoffRoutingStatusTransaction,
  invocationId: string,
): HandoffRoutingTerminalEvent | undefined {
  return parseRecordBody(transaction.recordBody(invocationId, 'terminal'), terminalEventSchema);
}

function tombstoneForInvocation(
  transaction: HandoffRoutingStatusTransaction,
  invocationId: string,
): RetirementTombstone | undefined {
  return parseRecordBody(transaction.recordBody(invocationId, 'retirement'), retirementTombstoneSchema);
}

function insertSelection(
  transaction: HandoffRoutingStatusTransaction,
  transition: z.infer<typeof routingSelectedTransitionSchema>,
): number {
  const sequence = transaction.nextRecordSequence();
  const event = routingSelectedEventSchema.parse({
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequence,
    eventId: transition.eventId,
    invocationId: transition.invocationId,
    observedAt: transition.observedAt,
    eventKind: 'routing-selected',
    phase: 'selection',
    owner: transition.owner,
    disposition: transition.disposition,
  });
  const inserted = insertRecord(transaction, 'selection', event);
  transaction.insertClosingReserve(event.invocationId, event.eventId, event.observedAt);
  return inserted;
}

function releaseClosingReserve(transaction: HandoffRoutingStatusTransaction, invocationId: string): void {
  if (!transaction.releaseClosingReserve(invocationId)) throw new HandoffRoutingStoreUnreadableError();
}

function terminalGapDisposition(
  transition: z.infer<typeof terminalTransitionSchema>,
): Extract<StoredTerminalDisposition, { kind: 'failed-without-selection' | 'finalized-without-selection' }> {
  return transition.disposition.kind === 'execution-failed'
    ? { kind: 'failed-without-selection', throwPhase: transition.disposition.throwPhase }
    : { kind: 'finalized-without-selection', terminal: transition.disposition };
}

function insertTerminal(
  transaction: HandoffRoutingStatusTransaction,
  transition: z.infer<typeof terminalTransitionSchema>,
  disposition: StoredTerminalDisposition,
): number {
  const sequence = transaction.nextRecordSequence();
  const event = terminalEventSchema.parse({
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequence,
    eventId: transition.eventId,
    invocationId: transition.invocationId,
    observedAt: transition.observedAt,
    eventKind: transition.kind,
    phase: 'terminal',
    selection: transition.selection,
    disposition,
  });
  return insertRecord(transaction, 'terminal', event);
}

function insertTombstone(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  selection: RoutingSelectedEvent,
  retirementCause: RetirementTombstone['retirementCause'],
  terminalExisted: boolean,
  observedAt: string,
  resolutionReason?: RetirementTombstone['resolutionReason'],
  eventId = `retirement-${ids.uuid()}`,
): number {
  const sequence = transaction.nextRecordSequence();
  const tombstone = retirementTombstoneSchema.parse({
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequence,
    eventId,
    invocationId: selection.invocationId,
    observedAt,
    eventKind: 'retirement-tombstone',
    phase: 'retirement',
    selectionSequence: selection.sequence,
    selectedAt: selection.observedAt,
    owner: selection.owner,
    selectedDisposition: selection.disposition,
    retirementCause,
    terminalExisted,
    ...(resolutionReason === undefined ? {} : { resolutionReason }),
  });
  return insertRecord(transaction, 'retirement', tombstone);
}

function readRetirementHistory(transaction: HandoffRoutingStatusTransaction): RetirementHistoryTruncated {
  const row = transaction.readRetirementHistory();
  if (row === undefined) throw new HandoffRoutingStoreUnreadableError();
  return retirementHistoryTruncatedSchema.parse({
    kind: 'retirement-history-truncated',
    expiredIdentityCount: row.expired_identity_count,
    causes: {
      'selection-evicted-at-capacity': row.capacity_eviction_count,
      'completed-pair-compaction': row.completed_pair_compaction_count,
      'operator-resolved': row.operator_resolved_count,
    },
    minSelectionSequence: row.min_selection_sequence,
    maxSelectionSequence: row.max_selection_sequence,
    earliestSelectedAt: row.earliest_selected_at,
    latestSelectedAt: row.latest_selected_at,
  });
}

function rollUpTombstone(transaction: HandoffRoutingStatusTransaction, tombstone: RetirementTombstone): void {
  const aggregate = readRetirementHistory(transaction);
  const next = retirementHistoryTruncatedSchema.parse({
    kind: 'retirement-history-truncated',
    expiredIdentityCount: aggregate.expiredIdentityCount + 1,
    causes: {
      ...aggregate.causes,
      [tombstone.retirementCause]: aggregate.causes[tombstone.retirementCause] + 1,
    },
    minSelectionSequence:
      aggregate.minSelectionSequence === null
        ? tombstone.selectionSequence
        : Math.min(aggregate.minSelectionSequence, tombstone.selectionSequence),
    maxSelectionSequence:
      aggregate.maxSelectionSequence === null
        ? tombstone.selectionSequence
        : Math.max(aggregate.maxSelectionSequence, tombstone.selectionSequence),
    earliestSelectedAt:
      aggregate.earliestSelectedAt === null || tombstone.selectedAt < aggregate.earliestSelectedAt
        ? tombstone.selectedAt
        : aggregate.earliestSelectedAt,
    latestSelectedAt:
      aggregate.latestSelectedAt === null || tombstone.selectedAt > aggregate.latestSelectedAt
        ? tombstone.selectedAt
        : aggregate.latestSelectedAt,
  });
  transaction.updateRetirementHistory({
    expiredIdentityCount: next.expiredIdentityCount,
    capacityEvictionCount: next.causes['selection-evicted-at-capacity'],
    completedPairCompactionCount: next.causes['completed-pair-compaction'],
    operatorResolvedCount: next.causes['operator-resolved'],
    minSelectionSequence: next.minSelectionSequence,
    maxSelectionSequence: next.maxSelectionSequence,
    earliestSelectedAt: next.earliestSelectedAt,
    latestSelectedAt: next.latestSelectedAt,
  });
  transaction.deleteRecord(tombstone.sequence);
}

function enforceTombstoneBounds(transaction: HandoffRoutingStatusTransaction): void {
  while (true) {
    const bounds = transaction.tombstoneBounds();
    if (bounds.count <= MAX_RETIREMENT_TOMBSTONES && bounds.bytes <= MAX_RETIREMENT_TOMBSTONE_BYTES) return;
    const tombstone = parseRecordBody(transaction.oldestTombstoneBody(), retirementTombstoneSchema);
    if (tombstone === undefined) throw new HandoffRoutingStoreUnreadableError();
    rollUpTombstone(transaction, tombstone);
  }
}

function retireSelection(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  selection: RoutingSelectedEvent,
  cause: RetirementTombstone['retirementCause'],
  observedAt: string,
  terminalExisted: boolean,
  resolutionReason?: RetirementTombstone['resolutionReason'],
  eventId?: string,
): number {
  if (!terminalExisted) releaseClosingReserve(transaction, selection.invocationId);
  transaction.deleteInvocationRecords(selection.invocationId);
  const sequence = insertTombstone(
    transaction,
    ids,
    selection,
    cause,
    terminalExisted,
    observedAt,
    resolutionReason,
    eventId,
  );
  enforceTombstoneBounds(transaction);
  return sequence;
}

function retireOldestCompletedPairForCapacity(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  observedAt: string,
): boolean {
  const selection = parseRecordBody(transaction.oldestCompletedSelectionBody(), routingSelectedEventSchema);
  if (selection === undefined) return false;
  retireSelection(transaction, ids, selection, 'completed-pair-compaction', observedAt, true);
  return true;
}

function rollUpOldestTombstone(transaction: HandoffRoutingStatusTransaction): boolean {
  const tombstone = parseRecordBody(transaction.oldestTombstoneBody(), retirementTombstoneSchema);
  if (tombstone === undefined) return false;
  rollUpTombstone(transaction, tombstone);
  return true;
}

function reclaimBoundedHistoryForAdmission(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  observedAt: string,
): boolean {
  if (transaction.deleteOldestBoundedTerminal()) return true;
  if (retireOldestCompletedPairForCapacity(transaction, ids, observedAt)) return true;
  return rollUpOldestTombstone(transaction);
}

function makeClosingAdmissionRoom(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  observedAt: string,
  capacity: 'reserved' | 'unreserved',
): void {
  if (capacity === 'reserved') return;
  while (transaction.boundedTerminalCount() >= MAX_BOUNDED_TERMINAL_HISTORY) {
    transaction.deleteOldestBoundedTerminal();
  }
  while (!transaction.hasAdmissionCapacity(MAX_LEGAL_CLOSING_RECORD_BYTES)) {
    if (reclaimBoundedHistoryForAdmission(transaction, ids, observedAt)) continue;
    throw new CapacityExhaustedError();
  }
}

function makeSelectionAdmissionRoom(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  observedAt: string,
): void {
  while (transaction.unresolvedCount() >= MAX_UNRESOLVED_INVOCATIONS) {
    evictOldestOpening(transaction, ids, observedAt);
  }
  const selectionAndReserveBytes =
    MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['routing-selected'] + MAX_LEGAL_CLOSING_RECORD_BYTES;
  while (!transaction.hasAdmissionCapacity(selectionAndReserveBytes)) {
    if (reclaimBoundedHistoryForAdmission(transaction, ids, observedAt)) continue;
    if (transaction.unresolvedCount() > 0) {
      evictOldestOpening(transaction, ids, observedAt);
      continue;
    }
    throw new CapacityExhaustedError();
  }
}

function compactExpiredCompletedPairs(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  observedAt: string,
): void {
  const cutoff = new Date(Date.parse(observedAt) - HANDOFF_ROUTING_COMPLETED_RETENTION_MS).toISOString();
  const selectionBodies = transaction.completedSelectionBodiesForCompaction(
    MAX_COMPLETED_HANDOFF_ROUTING_PAIRS,
    cutoff,
  );
  for (const body of selectionBodies) {
    const selection = parseRecordBody(body, routingSelectedEventSchema);
    if (selection === undefined) throw new HandoffRoutingStoreUnreadableError();
    retireSelection(transaction, ids, selection, 'completed-pair-compaction', observedAt, true);
  }
}

function evictOldestOpening(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  observedAt: string,
): void {
  const selection = parseRecordBody(transaction.oldestOpeningBody(), routingSelectedEventSchema);
  if (selection === undefined) throw new RejectedTransitionError();
  retireSelection(transaction, ids, selection, 'selection-evicted-at-capacity', observedAt, false);
}

function applySelection(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  transition: z.infer<typeof routingSelectedTransitionSchema>,
): number {
  if (
    selectionForInvocation(transaction, transition.invocationId) !== undefined ||
    terminalForInvocation(transaction, transition.invocationId) !== undefined ||
    tombstoneForInvocation(transaction, transition.invocationId) !== undefined
  ) {
    throw new RejectedTransitionError();
  }
  makeSelectionAdmissionRoom(transaction, ids, transition.observedAt);
  return insertSelection(transaction, transition);
}

function applyTerminal(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  transition: z.infer<typeof terminalTransitionSchema>,
): number {
  if (terminalForInvocation(transaction, transition.invocationId) !== undefined) {
    throw new RejectedTransitionError();
  }
  if (transition.selection.kind === 'without-selection') {
    if (
      selectionForInvocation(transaction, transition.invocationId) !== undefined ||
      tombstoneForInvocation(transaction, transition.invocationId) !== undefined
    ) {
      throw new RejectedTransitionError();
    }
    makeClosingAdmissionRoom(transaction, ids, transition.observedAt, 'unreserved');
    return insertTerminal(transaction, transition, terminalGapDisposition(transition));
  }

  const selection = selectionForInvocation(transaction, transition.invocationId);
  if (selection !== undefined) {
    if (selection.sequence !== transition.selection.selectionSequence) throw new RejectedTransitionError();
    releaseClosingReserve(transaction, selection.invocationId);
    makeClosingAdmissionRoom(transaction, ids, transition.observedAt, 'reserved');
    return insertTerminal(transaction, transition, transition.disposition);
  }

  const tombstone = tombstoneForInvocation(transaction, transition.invocationId);
  if (tombstone === undefined || tombstone.selectionSequence !== transition.selection.selectionSequence) {
    makeClosingAdmissionRoom(transaction, ids, transition.observedAt, 'unreserved');
    return insertTerminal(transaction, transition, {
      kind: 'terminal-without-retained-selection',
      knowledge: 'identity-expired-or-selection-unavailable',
      terminal: transition.disposition,
    });
  }
  if (tombstone.retirementCause === 'completed-pair-compaction' || tombstone.terminalExisted) {
    throw new RejectedTransitionError();
  }
  transaction.deleteRecord(tombstone.sequence);
  makeClosingAdmissionRoom(transaction, ids, transition.observedAt, 'unreserved');
  if (tombstone.retirementCause === 'operator-resolved') {
    if (tombstone.resolutionReason === undefined) throw new HandoffRoutingStoreUnreadableError();
    return insertTerminal(transaction, transition, {
      kind: 'terminal-after-operator-resolution',
      resolutionReason: tombstone.resolutionReason,
      retiredSelection: {
        selectionSequence: tombstone.selectionSequence,
        selectedAt: tombstone.selectedAt,
        owner: tombstone.owner,
        selectedDisposition: tombstone.selectedDisposition,
      },
      terminal: transition.disposition,
    });
  }
  const replacement = retirementTombstoneSchema.parse({
    ...tombstone,
    sequence: transaction.nextRecordSequence(),
    eventId: transition.eventId,
    observedAt: transition.observedAt,
    terminalExisted: true,
  });
  const sequence = insertRecord(transaction, 'retirement', replacement);
  enforceTombstoneBounds(transaction);
  return sequence;
}

function applyResolution(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  transition: z.infer<typeof operatorResolvedTransitionSchema>,
): number {
  const selection = selectionForInvocation(transaction, transition.invocationId);
  if (selection === undefined || selection.sequence !== transition.selectionSequence) {
    throw new RejectedTransitionError();
  }
  if (terminalForInvocation(transaction, transition.invocationId) !== undefined) throw new RejectedTransitionError();
  releaseClosingReserve(transaction, selection.invocationId);
  transaction.deleteInvocationRecords(selection.invocationId);
  makeClosingAdmissionRoom(transaction, ids, transition.observedAt, 'reserved');
  const sequence = insertTombstone(
    transaction,
    ids,
    selection,
    'operator-resolved',
    false,
    transition.observedAt,
    transition.reason,
    transition.eventId,
  );
  enforceTombstoneBounds(transaction);
  return sequence;
}

function applyTransition(
  transaction: HandoffRoutingStatusTransaction,
  ids: Pick<IdPort, 'uuid'>,
  transition: HandoffRoutingTransition,
): number {
  if (transaction.eventExists(transition.eventId)) throw new RejectedTransitionError();
  switch (transition.kind) {
    case 'routing-selected':
      return applySelection(transaction, ids, transition);
    case 'execution-failed':
    case 'continuation-finalized':
      return applyTerminal(transaction, ids, transition);
    case 'operator-resolved':
      return applyResolution(transaction, ids, transition);
    default:
      return assertNever(transition);
  }
}

function transitionObservedAt(transitions: readonly HandoffRoutingTransition[]): string {
  return transitions.reduce(
    (latest, transition) => (Date.parse(transition.observedAt) > Date.parse(latest) ? transition.observedAt : latest),
    transitions[0].observedAt,
  );
}

function errorNumber(error: unknown, fallback: number): number {
  if (typeof error !== 'object' || error === null) return fallback;
  const candidate = 'errcode' in error ? error.errcode : 'errno' in error ? error.errno : fallback;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : fallback;
}

function classifyPublicationError(error: unknown, commitStarted: boolean): PublicationOutcome {
  if (error instanceof HandoffRoutingStoreInvalidRecordError) {
    return { kind: 'not-published', cause: 'invalid-record', validation: error.validation };
  }
  if (error instanceof RejectedTransitionError) {
    return { kind: 'not-published', cause: 'rejected-transition' };
  }
  const errcode =
    error instanceof UnsupportedGenerationError
      ? SQLITE_ERROR
      : error instanceof HandoffRoutingStoreUnreadableError
        ? error.errcode
        : errorNumber(error, SQLITE_ERROR);
  const primaryErrcode = errcode & 0xff;
  const cause =
    error instanceof UnsupportedGenerationError
      ? 'unsupported-generation'
      : error instanceof HandoffRoutingStoreUnreadableError ||
          primaryErrcode === SQLITE_NOTADB ||
          primaryErrcode === SQLITE_CORRUPT
        ? 'unreadable'
        : primaryErrcode === SQLITE_FULL
          ? 'capacity-exhausted'
          : primaryErrcode === SQLITE_BUSY
            ? 'contended'
            : 'io-failed';
  return commitStarted ? { kind: 'undeterminable', cause, errcode } : { kind: 'not-published', cause };
}

function handoffRoutingStatusStoreSchema(): HandoffRoutingStatusStoreSchema {
  return {
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    maximumBytes: MAX_HANDOFF_ROUTING_STATUS_BYTES,
    maximumIdentifierLength: MAX_IDENTIFIER_LENGTH,
    maximumObservedAtLength: MAX_OBSERVED_AT_LENGTH,
    maximumRoutingSelectedBytes: MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['routing-selected'],
    maximumExecutionFailedBytes: MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['execution-failed'],
    maximumContinuationFinalizedBytes: MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['continuation-finalized'],
    maximumRetirementTombstoneBytes: MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES,
    closingRecordBytes: MAX_LEGAL_CLOSING_RECORD_BYTES,
    validateRecordBody: validateStatusRecordBody,
  };
}

function publishOnce(
  runtime: Pick<HandoffRoutingPublicationPorts, 'storage' | 'ids'>,
  path: string,
  transitions: readonly HandoffRoutingTransition[],
): PublicationOutcome {
  const parsed = z.array(handoffRoutingTransitionSchema).min(1).safeParse(transitions);
  if (!parsed.success) return { kind: 'not-published', cause: 'rejected-transition' };

  const publication = publishHandoffRoutingStoreTransaction(
    runtime.storage,
    path,
    handoffRoutingStatusStoreSchema(),
    (transaction) => {
      const observedAt = transitionObservedAt(parsed.data);
      compactExpiredCompletedPairs(transaction, runtime.ids, observedAt);
      let publishedSequence = 0;
      for (const transition of parsed.data) {
        publishedSequence = applyTransition(transaction, runtime.ids, transition);
      }
      compactExpiredCompletedPairs(transaction, runtime.ids, observedAt);
      return publishedSequence;
    },
  );
  return publication.kind === 'committed'
    ? { kind: 'committed', sequence: publication.value }
    : classifyPublicationError(publication.error, publication.commitStarted);
}

export async function publishHandoffRoutingTransitions(
  runtime: HandoffRoutingPublicationPorts,
  path: string,
  transitions: readonly HandoffRoutingTransition[],
  signal?: AbortSignal,
): Promise<PublicationOutcome> {
  const clock = createMonotonicClock(Symbol('handoff-routing-status-publication-contention'), {
    readMilliseconds: () => runtime.time.monotonicNow(),
  });
  const deadline = clock.shiftMilliseconds(clock.now(), PUBLICATION_CONTENTION_TIMEOUT_MS);
  while (true) {
    const outcome = publishOnce(runtime, path, transitions);
    if (outcome.kind !== 'not-published' || outcome.cause !== 'contended') return outcome;
    if (signal?.aborted === true || clock.compare(clock.now(), deadline) >= 0) return outcome;
    try {
      await runtime.time.sleep(PUBLICATION_RETRY_DELAY_MS, signal === undefined ? undefined : { signal });
    } catch {
      return outcome;
    }
  }
}

export async function publishGenerationCoordinatedHandoffRoutingTransitions(
  runtime: Runtime,
  path: string,
  transitions: readonly HandoffRoutingTransition[],
  signal?: AbortSignal,
): Promise<PublicationOutcome> {
  let writer: GenerationWriterLease;
  try {
    const attempt = tryAcquireGenerationWriterLease(runtime, {
      kind: 'routing-status',
      name: 'handoff-routing-status',
    });
    if (attempt.kind === 'maintenance-active') {
      return { kind: 'not-published', cause: 'generation-maintenance' };
    }
    if (attempt.kind === 'contended') return { kind: 'not-published', cause: 'contended' };
    writer = attempt.lease;
  } catch {
    return { kind: 'not-published', cause: 'coordination-unavailable' };
  }
  try {
    try {
      writer.assertOwned();
    } catch {
      return { kind: 'not-published', cause: 'coordination-unavailable' };
    }
    return await publishHandoffRoutingTransitions(runtime, path, transitions, signal);
  } finally {
    writer.release();
  }
}

export type PersistedHandoffDisposition =
  | DurableHandoffRoutingBasis
  | SelectedHandoffDisposition
  | DirectTerminalDisposition
  | Extract<StoredTerminalDisposition, { kind: 'failed-without-selection' | 'finalized-without-selection' }>
  | Extract<
      StoredTerminalDisposition,
      { kind: 'terminal-without-retained-selection' | 'terminal-after-operator-resolution' }
    >
  | Readonly<{ kind: RetirementTombstone['retirementCause']; terminalExisted: boolean }>
  | RetirementHistoryTruncated;

const boundedWarningPolicy: Extract<RoutingStatusPolicy, { durability: 'lifecycle-journal' }> = Object.freeze({
  durability: 'lifecycle-journal',
  retention: 'bounded-history',
  severity: 'warning',
  exitContribution: 75,
});

type BoundedWarningDisposition = Extract<
  PersistedHandoffDisposition,
  {
    kind:
      | 'delegated-exit'
      | 'delegated-signal'
      | 'execution-failed'
      | 'failed-without-selection'
      | 'finalized-without-selection'
      | 'terminal-without-retained-selection'
      | 'terminal-after-operator-resolution';
  }
>;

type RetirementDisposition = Extract<PersistedHandoffDisposition, { terminalExisted: boolean }>;

const SELECTED_DISPOSITION_KINDS: Readonly<Record<SelectedHandoffDisposition['kind'], true>> = Object.freeze({
  'continue-current': true,
  'handoff-selected': true,
});

const BOUNDED_WARNING_DISPOSITION_KINDS: Readonly<Record<BoundedWarningDisposition['kind'], true>> = Object.freeze({
  'delegated-exit': true,
  'delegated-signal': true,
  'execution-failed': true,
  'failed-without-selection': true,
  'finalized-without-selection': true,
  'terminal-without-retained-selection': true,
  'terminal-after-operator-resolution': true,
});

function isRoutingBasisDisposition(
  disposition: PersistedHandoffDisposition,
): disposition is DurableHandoffRoutingBasis {
  return Object.hasOwn(HANDOFF_ROUTING_BASIS_POLICIES, disposition.kind);
}

function isSelectedDisposition(disposition: PersistedHandoffDisposition): disposition is SelectedHandoffDisposition {
  return Object.hasOwn(SELECTED_DISPOSITION_KINDS, disposition.kind);
}

function isBoundedWarningDisposition(
  disposition: PersistedHandoffDisposition,
): disposition is BoundedWarningDisposition {
  return Object.hasOwn(BOUNDED_WARNING_DISPOSITION_KINDS, disposition.kind);
}

function isRetirementDisposition(disposition: PersistedHandoffDisposition): disposition is RetirementDisposition {
  return 'terminalExisted' in disposition;
}

function selectedDispositionPolicy(disposition: SelectedHandoffDisposition): RoutingStatusPolicy {
  switch (disposition.kind) {
    case 'continue-current':
      return HANDOFF_ROUTING_BASIS_POLICIES[disposition.basis.kind];
    case 'handoff-selected':
      return {
        durability: 'lifecycle-journal',
        retention: 'until-terminal',
        severity: 'info',
        exitContribution: 0,
      };
    default:
      return assertNever(disposition);
  }
}

function retirementDispositionPolicy(disposition: RetirementDisposition): RoutingStatusPolicy {
  switch (disposition.kind) {
    case 'selection-evicted-at-capacity':
    case 'operator-resolved':
      return boundedWarningPolicy;
    case 'completed-pair-compaction':
      return {
        durability: 'lifecycle-journal',
        retention: 'bounded-history',
        severity: 'info',
        exitContribution: 0,
      };
    default:
      return assertNever(disposition.kind);
  }
}

export function persistedHandoffDispositionPolicy(disposition: PersistedHandoffDisposition): RoutingStatusPolicy {
  if (isRoutingBasisDisposition(disposition)) return HANDOFF_ROUTING_BASIS_POLICIES[disposition.kind];
  if (isSelectedDisposition(disposition)) return selectedDispositionPolicy(disposition);
  if (isRetirementDisposition(disposition)) return retirementDispositionPolicy(disposition);
  if (isBoundedWarningDisposition(disposition)) return boundedWarningPolicy;

  switch (disposition.kind) {
    case 'continued-current':
      return disposition.reason.kind === 'routing'
        ? HANDOFF_ROUTING_BASIS_POLICIES[disposition.reason.basis.kind]
        : boundedWarningPolicy;
    case 'delegated-success':
      return {
        durability: 'lifecycle-journal',
        retention: 'until-superseded',
        severity: 'info',
        exitContribution: 0,
      };
    case 'retirement-history-truncated':
      return {
        durability: 'lifecycle-journal',
        retention: 'bounded-history',
        severity: 'info',
        exitContribution: 0,
      };
    default:
      return assertNever(disposition);
  }
}

export type OwnerLiveness =
  | Readonly<{ kind: 'alive' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{
      kind: 'unobservable';
      cause: 'incarnation-unavailable' | 'probe-not-available' | 'probe-failed' | 'deadline-expired';
    }>;

export type HandoffRoutingInvocationStatus =
  | Readonly<{ kind: 'unresolved'; selection: RoutingSelectedEvent; ownerLiveness: OwnerLiveness }>
  | Readonly<{ kind: 'terminal'; selection: RoutingSelectedEvent | null; terminal: HandoffRoutingTerminalEvent }>
  | Readonly<{ kind: 'retired'; tombstone: RetirementTombstone }>;

export type HandoffRoutingStatusReadResult =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{
      kind: 'current';
      generation: typeof HANDOFF_ROUTING_STATUS_GENERATION;
      statuses: readonly HandoffRoutingInvocationStatus[];
      retirementHistoryTruncated: RetirementHistoryTruncated;
    }>
  | Readonly<{ kind: 'unreadable'; reason: 'invalid-json' | 'invalid-shape' | 'too-large' }>
  | Readonly<{ kind: 'unsupported-generation'; generation: number }>
  | Readonly<{ kind: 'undeterminable'; cause: 'io-failed'; errcode: number }>;

export type HandoffRoutingOwnerLivenessProbe = (owner: RecordedProcessIdentity) => OwnerLiveness;

export type HandoffRoutingResolveRequest = Readonly<{
  invocationId: string;
  forceUnobservable: boolean;
}>;

export type HandoffRoutingResolveResult =
  | Readonly<{
      kind: 'resolved';
      invocationId: string;
      reason: 'owner-absent' | 'operator-abandoned-unobservable';
      sequence: number;
    }>
  | Readonly<{ kind: 'stale'; invocationId: string }>
  | Readonly<{ kind: 'already-terminal'; invocationId: string }>
  | Readonly<{ kind: 'live-owner'; invocationId: string }>
  | Readonly<{
      kind: 'unauthorized-unobservable';
      invocationId: string;
      cause: Extract<OwnerLiveness, { kind: 'unobservable' }>['cause'];
    }>
  | Readonly<{
      kind: 'status-unavailable';
      status: Extract<
        HandoffRoutingStatusReadResult,
        { kind: 'unreadable' | 'unsupported-generation' | 'undeterminable' }
      >;
    }>
  | Readonly<{ kind: 'not-published'; outcome: Exclude<PublicationOutcome, { kind: 'committed' }> }>;

const statusReadRowSchema = z
  .object({
    sequence: positiveSequenceSchema,
    generation: sequenceSchema,
    event_id: z.string(),
    invocation_id: z.string(),
    observed_at: z.string(),
    record_kind: z.string(),
    event_kind: z.string(),
    selection_sequence: positiveSequenceSchema.nullable(),
    retirement_cause: z.string().nullable(),
    terminal_existed: z.number().int().nullable(),
    body_json: z.string(),
    encoded_bytes: sequenceSchema,
  })
  .strict()
  .readonly();

type StatusReadRow = z.infer<typeof statusReadRowSchema>;

const closingReserveReadRowSchema = z
  .object({
    invocation_id: z.string(),
    event_id: z.string(),
    observed_at: z.string(),
    allocation_bytes: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

type ClosingReserveReadRow = z.infer<typeof closingReserveReadRowSchema>;

type RetirementHistoryRow = Readonly<{
  generation: number;
  expired_identity_count: number;
  capacity_eviction_count: number;
  completed_pair_compaction_count: number;
  operator_resolved_count: number;
  min_selection_sequence: number | null;
  max_selection_sequence: number | null;
  earliest_selected_at: string | null;
  latest_selected_at: string | null;
}>;

type StatusSnapshot = Readonly<{
  kind: 'snapshot';
  rows: readonly unknown[];
  reserves: readonly unknown[];
  retirement: RetirementHistoryRow | undefined;
}>;

type StatusSnapshotReadResult =
  | StatusSnapshot
  | Extract<HandoffRoutingStatusReadResult, { kind: 'absent' }>
  | Extract<HandoffRoutingStatusReadResult, { kind: 'unreadable' | 'unsupported-generation' | 'undeterminable' }>;

type InvocationRecords = {
  selection?: RoutingSelectedEvent;
  terminal?: HandoffRoutingTerminalEvent;
  tombstone?: RetirementTombstone;
};

type UnreadableStatus = Extract<HandoffRoutingStatusReadResult, { kind: 'unreadable' }>;

type StatusProjection =
  | Readonly<{ kind: 'projected'; statuses: readonly HandoffRoutingInvocationStatus[] }>
  | UnreadableStatus;

type DecodedStatusRow = Readonly<{ kind: 'decoded'; record: StoredStatusRecord }> | UnreadableStatus;

type InvocationStatusProjection =
  | Readonly<{ kind: 'projected'; status: HandoffRoutingInvocationStatus }>
  | Readonly<{ kind: 'empty' }>
  | UnreadableStatus;

function statusRowByteLimit(recordKind: string): number | undefined {
  switch (recordKind) {
    case 'selection':
      return MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['routing-selected'];
    case 'terminal':
      return Math.max(
        MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['execution-failed'],
        MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['continuation-finalized'],
      );
    case 'retirement':
      return MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES;
    default:
      return undefined;
  }
}

function ownerLiveness(
  owner: RecordedProcessIdentity,
  probe: HandoffRoutingOwnerLivenessProbe | undefined,
): OwnerLiveness {
  if (probe === undefined) return { kind: 'unobservable', cause: 'probe-not-available' };
  try {
    return probe(owner);
  } catch {
    return { kind: 'unobservable', cause: 'probe-failed' };
  }
}

function decodeAndValidateStatusRow(rawRow: unknown): DecodedStatusRow {
  const parsedRow = statusReadRowSchema.safeParse(rawRow);
  if (!parsedRow.success) return { kind: 'unreadable', reason: 'invalid-shape' };
  const row: StatusReadRow = parsedRow.data;
  const byteLimit = statusRowByteLimit(row.record_kind);
  if (byteLimit === undefined) return { kind: 'unreadable', reason: 'invalid-shape' };
  const bodyBytes = Buffer.byteLength(row.body_json, 'utf8');
  if (bodyBytes > byteLimit) return { kind: 'unreadable', reason: 'too-large' };

  let body: unknown;
  try {
    body = JSON.parse(row.body_json);
  } catch {
    return { kind: 'unreadable', reason: 'invalid-json' };
  }

  const record = decodeStatusRecordBody(
    {
      generation: row.generation,
      sequence: row.sequence,
      eventId: row.event_id,
      invocationId: row.invocation_id,
      observedAt: row.observed_at,
      recordKind: row.record_kind,
      eventKind: row.event_kind,
      selectionSequence: row.selection_sequence,
      retirementCause: row.retirement_cause,
      terminalExisted: row.terminal_existed,
    },
    body,
  );
  if (row.encoded_bytes !== bodyBytes || record === null) {
    return { kind: 'unreadable', reason: 'invalid-shape' };
  }

  return { kind: 'decoded', record };
}

function admitStatusRecord(invocations: Map<string, InvocationRecords>, record: StoredStatusRecord): boolean {
  const invocation = invocations.get(record.invocationId) ?? {};
  if (record.phase === 'selection') {
    if (invocation.selection !== undefined) return false;
    invocation.selection = record;
  } else if (record.phase === 'terminal') {
    if (invocation.terminal !== undefined) return false;
    invocation.terminal = record;
  } else {
    if (invocation.tombstone !== undefined) return false;
    invocation.tombstone = record;
  }
  invocations.set(record.invocationId, invocation);
  return true;
}

function admitClosingReserve(rawReserve: unknown, closingReserves: Map<string, ClosingReserveReadRow>): boolean {
  const parsedReserve = closingReserveReadRowSchema.safeParse(rawReserve);
  if (!parsedReserve.success) return false;
  const reserve = parsedReserve.data;
  if (reserve.allocation_bytes !== MAX_LEGAL_CLOSING_RECORD_BYTES || closingReserves.has(reserve.invocation_id)) {
    return false;
  }
  closingReserves.set(reserve.invocation_id, reserve);
  return true;
}

function validateInvocationReserve(
  selection: RoutingSelectedEvent,
  closingReserves: Map<string, ClosingReserveReadRow>,
): boolean {
  const reserve = closingReserves.get(selection.invocationId);
  if (reserve === undefined || reserve.event_id !== selection.eventId || reserve.observed_at !== selection.observedAt) {
    return false;
  }
  closingReserves.delete(selection.invocationId);
  return true;
}

function projectInvocationStatus(
  invocation: InvocationRecords,
  closingReserves: Map<string, ClosingReserveReadRow>,
  probe: HandoffRoutingOwnerLivenessProbe | undefined,
): InvocationStatusProjection {
  if (invocation.tombstone !== undefined) {
    if (
      invocation.selection !== undefined ||
      invocation.terminal !== undefined ||
      closingReserves.has(invocation.tombstone.invocationId)
    ) {
      return { kind: 'unreadable', reason: 'invalid-shape' };
    }
    return { kind: 'projected', status: { kind: 'retired', tombstone: invocation.tombstone } };
  }
  if (invocation.terminal !== undefined) {
    if (closingReserves.has(invocation.terminal.invocationId)) {
      return { kind: 'unreadable', reason: 'invalid-shape' };
    }
    if (invocation.selection !== undefined) {
      if (
        invocation.terminal.selection.kind !== 'with-selection-sequence' ||
        invocation.terminal.selection.selectionSequence !== invocation.selection.sequence
      ) {
        return { kind: 'unreadable', reason: 'invalid-shape' };
      }
    } else if (
      invocation.terminal.selection.kind === 'with-selection-sequence' &&
      invocation.terminal.disposition.kind !== 'terminal-without-retained-selection' &&
      invocation.terminal.disposition.kind !== 'terminal-after-operator-resolution'
    ) {
      return { kind: 'unreadable', reason: 'invalid-shape' };
    }
    return {
      kind: 'projected',
      status: { kind: 'terminal', selection: invocation.selection ?? null, terminal: invocation.terminal },
    };
  }
  if (invocation.selection === undefined) return { kind: 'empty' };

  if (!validateInvocationReserve(invocation.selection, closingReserves)) {
    return { kind: 'unreadable', reason: 'invalid-shape' };
  }
  return {
    kind: 'projected',
    status: {
      kind: 'unresolved',
      selection: invocation.selection,
      ownerLiveness: ownerLiveness(invocation.selection.owner, probe),
    },
  };
}

function projectInvocationStatuses(
  rows: readonly unknown[],
  reserves: readonly unknown[],
  probe: HandoffRoutingOwnerLivenessProbe | undefined,
): StatusProjection {
  const invocations = new Map<string, InvocationRecords>();
  for (const rawRow of rows) {
    const decoded = decodeAndValidateStatusRow(rawRow);
    if (decoded.kind === 'unreadable') return decoded;
    if (!admitStatusRecord(invocations, decoded.record)) return { kind: 'unreadable', reason: 'invalid-shape' };
  }

  const closingReserves = new Map<string, ClosingReserveReadRow>();
  for (const rawReserve of reserves) {
    if (!admitClosingReserve(rawReserve, closingReserves)) {
      return { kind: 'unreadable', reason: 'invalid-shape' };
    }
  }

  const statuses: HandoffRoutingInvocationStatus[] = [];
  for (const invocation of invocations.values()) {
    const projected = projectInvocationStatus(invocation, closingReserves, probe);
    if (projected.kind === 'unreadable') return projected;
    if (projected.kind === 'projected') statuses.push(projected.status);
  }
  if (closingReserves.size !== 0) return { kind: 'unreadable', reason: 'invalid-shape' };
  return { kind: 'projected', statuses: Object.freeze(statuses) };
}

function classifyStatusSnapshotError(error: unknown): StatusSnapshotReadResult {
  const errcode = errorNumber(error, SQLITE_ERROR);
  const primaryErrcode = errcode & 0xff;
  if (primaryErrcode === SQLITE_ERROR || primaryErrcode === SQLITE_NOTADB || primaryErrcode === SQLITE_CORRUPT) {
    return { kind: 'unreadable', reason: 'invalid-shape' };
  }
  return { kind: 'undeterminable', cause: 'io-failed', errcode };
}

function readStatusSnapshot(storage: Runtime['storage'], path: string): StatusSnapshotReadResult {
  const result = readHandoffRoutingStoreSnapshot(storage, path, HANDOFF_ROUTING_STATUS_GENERATION);
  switch (result.kind) {
    case 'absent':
      return result;
    case 'unsupported-generation':
      return result;
    case 'snapshot':
      return result;
    case 'failed':
      return classifyStatusSnapshotError(result.error);
    default:
      return assertNever(result);
  }
}

export function readHandoffRoutingStatus(
  runtime: Pick<Runtime, 'storage'>,
  path: string,
  probe?: HandoffRoutingOwnerLivenessProbe,
): HandoffRoutingStatusReadResult {
  const snapshot = readStatusSnapshot(runtime.storage, path);
  if (snapshot.kind === 'absent') return snapshot;
  if (snapshot.kind !== 'snapshot') return snapshot;

  const retirementHistory = retirementHistoryTruncatedSchema.safeParse({
    kind: 'retirement-history-truncated',
    expiredIdentityCount: snapshot.retirement?.expired_identity_count,
    causes: {
      'selection-evicted-at-capacity': snapshot.retirement?.capacity_eviction_count,
      'completed-pair-compaction': snapshot.retirement?.completed_pair_compaction_count,
      'operator-resolved': snapshot.retirement?.operator_resolved_count,
    },
    minSelectionSequence: snapshot.retirement?.min_selection_sequence,
    maxSelectionSequence: snapshot.retirement?.max_selection_sequence,
    earliestSelectedAt: snapshot.retirement?.earliest_selected_at,
    latestSelectedAt: snapshot.retirement?.latest_selected_at,
  });
  if (snapshot.retirement?.generation !== HANDOFF_ROUTING_STATUS_GENERATION || !retirementHistory.success) {
    return { kind: 'unreadable', reason: 'invalid-shape' };
  }

  const projection = projectInvocationStatuses(snapshot.rows, snapshot.reserves, probe);
  if (projection.kind === 'unreadable') return projection;
  return {
    kind: 'current',
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    statuses: projection.statuses,
    retirementHistoryTruncated: retirementHistory.data,
  };
}

function observationProbe(
  observations: Awaited<ReturnType<Runtime['process']['observeProcessIdentities']>>,
): HandoffRoutingOwnerLivenessProbe {
  return (owner) => {
    const observation = observations.find(
      (candidate) => candidate.owner.pid === owner.pid && candidate.owner.incarnation === owner.incarnation,
    );
    if (observation === undefined) return { kind: 'unobservable', cause: 'probe-failed' };
    switch (observation.evidence.kind) {
      case 'pid-absent':
        return { kind: 'absent' };
      case 'incarnation':
        return observation.evidence.incarnation === owner.incarnation ? { kind: 'alive' } : { kind: 'absent' };
      case 'unobservable':
        return observation.evidence;
      default:
        return assertNever(observation.evidence);
    }
  };
}

export async function readHandoffRoutingStatusWithOwnerObservations(
  runtime: Pick<Runtime, 'storage' | 'process'>,
  path: string,
): Promise<HandoffRoutingStatusReadResult> {
  const initial = readHandoffRoutingStatus(runtime, path);
  if (initial.kind !== 'current') return initial;
  const owners = initial.statuses.flatMap((status) => (status.kind === 'unresolved' ? [status.selection.owner] : []));
  if (owners.length === 0) return initial;
  let observations: Awaited<ReturnType<Runtime['process']['observeProcessIdentities']>>;
  try {
    observations = await runtime.process.observeProcessIdentities(
      owners.slice(0, MAX_UNRESOLVED_INVOCATIONS),
      MAX_HANDOFF_ROUTING_OWNER_SWEEP_MS,
    );
  } catch {
    observations = owners.map((owner) => ({
      owner,
      evidence: { kind: 'unobservable', cause: 'probe-failed' },
    }));
  }
  return readHandoffRoutingStatus(runtime, path, observationProbe(observations));
}

function statusInvocationId(status: HandoffRoutingInvocationStatus): string {
  switch (status.kind) {
    case 'unresolved':
      return status.selection.invocationId;
    case 'terminal':
      return status.terminal.invocationId;
    case 'retired':
      return status.tombstone.invocationId;
    default:
      return assertNever(status);
  }
}

export async function resolveHandoffRoutingStatus(
  runtime: Runtime,
  path: string,
  request: HandoffRoutingResolveRequest,
  signal?: AbortSignal,
): Promise<HandoffRoutingResolveResult> {
  const statusRead = await readHandoffRoutingStatusWithOwnerObservations(runtime, path);
  if (statusRead.kind !== 'current') {
    return statusRead.kind === 'absent'
      ? { kind: 'stale', invocationId: request.invocationId }
      : { kind: 'status-unavailable', status: statusRead };
  }

  const status = statusRead.statuses.find((candidate) => statusInvocationId(candidate) === request.invocationId);
  if (status === undefined) return { kind: 'stale', invocationId: request.invocationId };
  if (status.kind === 'terminal') return { kind: 'already-terminal', invocationId: request.invocationId };
  if (status.kind === 'retired') {
    return status.tombstone.retirementCause === 'operator-resolved' || status.tombstone.terminalExisted
      ? { kind: 'already-terminal', invocationId: request.invocationId }
      : { kind: 'stale', invocationId: request.invocationId };
  }

  let reason: 'owner-absent' | 'operator-abandoned-unobservable';
  switch (status.ownerLiveness.kind) {
    case 'alive':
      return { kind: 'live-owner', invocationId: request.invocationId };
    case 'absent':
      reason = 'owner-absent';
      break;
    case 'unobservable':
      if (!request.forceUnobservable || status.ownerLiveness.cause === 'deadline-expired') {
        return {
          kind: 'unauthorized-unobservable',
          invocationId: request.invocationId,
          cause: status.ownerLiveness.cause,
        };
      }
      reason = 'operator-abandoned-unobservable';
      break;
    default:
      return assertNever(status.ownerLiveness);
  }

  const outcome = await publishGenerationCoordinatedHandoffRoutingTransitions(
    runtime,
    path,
    [
      {
        kind: 'operator-resolved',
        eventId: runtime.ids.uuid(),
        invocationId: request.invocationId,
        observedAt: new Date(runtime.time.now()).toISOString(),
        selectionSequence: status.selection.sequence,
        reason,
      },
    ],
    signal,
  );
  return outcome.kind === 'committed'
    ? { kind: 'resolved', invocationId: request.invocationId, reason, sequence: outcome.sequence }
    : { kind: 'not-published', outcome };
}

export function handoffRoutingStatusExitContribution(result: HandoffRoutingStatusReadResult): 0 | 75 {
  if (result.kind === 'absent') return 0;
  if (result.kind !== 'current') return 75;
  for (const status of result.statuses) {
    if (status.kind === 'unresolved') {
      if (status.ownerLiveness.kind === 'absent') return 75;
      if (status.ownerLiveness.kind === 'unobservable' && status.ownerLiveness.cause !== 'probe-not-available') {
        return 75;
      }
      continue;
    }
    if (status.kind === 'retired') {
      if (status.tombstone.retirementCause !== 'completed-pair-compaction') return 75;
      continue;
    }
    if (persistedHandoffDispositionPolicy(status.terminal.disposition).exitContribution === 75) return 75;
  }
  return 0;
}

const MAX_TEXT = '\u0800';
const MAX_VERSION_LENGTH = strictBundleManifestSchema.shape.version.maxLength;
if (MAX_VERSION_LENGTH === null) throw new Error('The bundle manifest version must remain bounded.');
const MAX_VERSION = `1.0.0-${'x'.repeat(MAX_VERSION_LENGTH - 6)}`;
const MAX_ID = MAX_TEXT.repeat(MAX_IDENTIFIER_LENGTH);
const MAX_INCARNATION = MAX_TEXT.repeat(256);
const MAX_OBSERVED_AT = '9999-12-31T23:59:59.999Z';
const MAX_BUILD: BuildSummary = {
  version: MAX_VERSION,
  buildSetId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
  bundleHash: 'f'.repeat(16),
  flavor: 'prod',
};
const MAX_BASIS: DurableHandoffRoutingBasis = {
  kind: 'invoking-build-not-older',
  comparison: 'newer-version',
  invoking: MAX_BUILD,
  incumbent: MAX_BUILD,
};
const MAX_SELECTION: RoutingSelectedEvent = routingSelectedEventSchema.parse({
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  sequence: Number.MAX_SAFE_INTEGER,
  eventId: MAX_ID,
  invocationId: MAX_ID,
  observedAt: MAX_OBSERVED_AT,
  eventKind: 'routing-selected',
  phase: 'selection',
  owner: { pid: Number.MAX_SAFE_INTEGER, incarnation: MAX_INCARNATION },
  disposition: { kind: 'continue-current', basis: MAX_BASIS },
});
const MAX_TOMBSTONE_FIXTURES = (
  ['selection-evicted-at-capacity', 'completed-pair-compaction', 'operator-resolved'] as const
).map((retirementCause) =>
  retirementTombstoneSchema.parse({
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequence: Number.MAX_SAFE_INTEGER,
    eventId: MAX_ID,
    invocationId: MAX_ID,
    observedAt: MAX_OBSERVED_AT,
    eventKind: 'retirement-tombstone',
    phase: 'retirement',
    selectionSequence: Number.MAX_SAFE_INTEGER,
    selectedAt: MAX_OBSERVED_AT,
    owner: MAX_SELECTION.owner,
    selectedDisposition: MAX_SELECTION.disposition,
    retirementCause,
    terminalExisted: retirementCause === 'completed-pair-compaction',
    ...(retirementCause === 'operator-resolved'
      ? { resolutionReason: 'operator-abandoned-unobservable' as const }
      : {}),
  }),
);

export const MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES = Math.max(...MAX_TOMBSTONE_FIXTURES.map(encodedBytes));

if (MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES > MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES) {
  throw new Error('The maximum legal retirement tombstone exceeds its encoded bound.');
}

const MAX_EXECUTION_TERMINAL = terminalEventSchema.parse({
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  sequence: Number.MAX_SAFE_INTEGER,
  eventId: MAX_ID,
  invocationId: MAX_ID,
  observedAt: MAX_OBSERVED_AT,
  eventKind: 'execution-failed',
  phase: 'terminal',
  selection: { kind: 'with-selection-sequence', selectionSequence: Number.MAX_SAFE_INTEGER },
  disposition: { kind: 'execution-failed', throwPhase: 'double-delegation-guard' },
});
const MAX_FINALIZED_TERMINAL = terminalEventSchema.parse({
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  sequence: Number.MAX_SAFE_INTEGER,
  eventId: MAX_ID,
  invocationId: MAX_ID,
  observedAt: MAX_OBSERVED_AT,
  eventKind: 'continuation-finalized',
  phase: 'terminal',
  selection: { kind: 'with-selection-sequence', selectionSequence: Number.MAX_SAFE_INTEGER },
  disposition: { kind: 'continued-current', reason: { kind: 'routing', basis: MAX_BASIS } },
});
const MAX_RESOLVED_EXECUTION_TERMINAL = terminalEventSchema.parse({
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  sequence: Number.MAX_SAFE_INTEGER,
  eventId: MAX_ID,
  invocationId: MAX_ID,
  observedAt: MAX_OBSERVED_AT,
  eventKind: 'execution-failed',
  phase: 'terminal',
  selection: { kind: 'with-selection-sequence', selectionSequence: Number.MAX_SAFE_INTEGER },
  disposition: {
    kind: 'terminal-after-operator-resolution',
    resolutionReason: 'operator-abandoned-unobservable',
    retiredSelection: {
      selectionSequence: Number.MAX_SAFE_INTEGER,
      selectedAt: MAX_OBSERVED_AT,
      owner: MAX_SELECTION.owner,
      selectedDisposition: MAX_SELECTION.disposition,
    },
    terminal: { kind: 'execution-failed', throwPhase: 'double-delegation-guard' },
  },
});
const MAX_RESOLVED_FINALIZED_TERMINAL = terminalEventSchema.parse({
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  sequence: Number.MAX_SAFE_INTEGER,
  eventId: MAX_ID,
  invocationId: MAX_ID,
  observedAt: MAX_OBSERVED_AT,
  eventKind: 'continuation-finalized',
  phase: 'terminal',
  selection: { kind: 'with-selection-sequence', selectionSequence: Number.MAX_SAFE_INTEGER },
  disposition: {
    kind: 'terminal-after-operator-resolution',
    resolutionReason: 'operator-abandoned-unobservable',
    retiredSelection: {
      selectionSequence: Number.MAX_SAFE_INTEGER,
      selectedAt: MAX_OBSERVED_AT,
      owner: MAX_SELECTION.owner,
      selectedDisposition: MAX_SELECTION.disposition,
    },
    terminal: { kind: 'continued-current', reason: { kind: 'routing', basis: MAX_BASIS } },
  },
});

const MAX_LEGAL_TERMINAL_BYTES = Math.max(
  encodedBytes(MAX_EXECUTION_TERMINAL),
  encodedBytes(MAX_FINALIZED_TERMINAL),
  encodedBytes(MAX_RESOLVED_EXECUTION_TERMINAL),
  encodedBytes(MAX_RESOLVED_FINALIZED_TERMINAL),
);

export const MAX_LEGAL_ROUTING_SELECTED_TRANSITION = routingSelectedTransitionSchema.parse({
  kind: 'routing-selected',
  eventId: MAX_SELECTION.eventId,
  invocationId: MAX_SELECTION.invocationId,
  observedAt: MAX_SELECTION.observedAt,
  owner: MAX_SELECTION.owner,
  disposition: MAX_SELECTION.disposition,
});

export const MAX_LEGAL_CONTINUATION_FINALIZED_TRANSITION = terminalTransitionSchema.parse({
  kind: 'continuation-finalized',
  eventId: MAX_FINALIZED_TERMINAL.eventId,
  invocationId: MAX_FINALIZED_TERMINAL.invocationId,
  observedAt: MAX_FINALIZED_TERMINAL.observedAt,
  selection: MAX_FINALIZED_TERMINAL.selection,
  disposition: MAX_FINALIZED_TERMINAL.disposition,
});

export const MAX_LEGAL_CLOSING_RECORD_BYTES = Math.max(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES, MAX_LEGAL_TERMINAL_BYTES);

export const MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES = Object.freeze({
  'routing-selected': encodedBytes(MAX_SELECTION),
  'execution-failed': Math.max(encodedBytes(MAX_EXECUTION_TERMINAL), encodedBytes(MAX_RESOLVED_EXECUTION_TERMINAL)),
  'continuation-finalized': Math.max(
    encodedBytes(MAX_FINALIZED_TERMINAL),
    encodedBytes(MAX_RESOLVED_FINALIZED_TERMINAL),
  ),
});
