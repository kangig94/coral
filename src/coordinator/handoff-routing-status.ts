import { z } from 'zod';

import { strictBundleManifestSchema, type StrictBundleIdentityFailure } from '../infra/bundle-manifest.js';
import { assertNever } from '../infra/error-format.js';
import type { InvalidTargetFailure } from '../infra/handoff-target.js';
import { processIncarnationSchema } from '../infra/node-process.js';
import type { RecordedProcessIdentity } from '../infra/process-containment.js';
import {
  HANDOFF_ROUTING_BASIS_OBLIGATIONS,
  type BuildSummary,
  type HandoffRoutingBasis,
  type IncumbentIdentitySummary,
  type RoutingBasisObligation,
} from './handoff-routing.js';
import {
  ABSENT_HANDOFF_RESULT_OBLIGATION,
  HANDOFF_CONTINUATION_REASON_OBLIGATIONS,
  type HandoffContinuationReason,
} from './handoff-runner.js';

export const HANDOFF_ROUTING_STATUS_GENERATION = 1;
export const MAX_HANDOFF_ROUTING_JOURNAL_BYTES = 1_048_576;
export const MAX_RETIREMENT_TOMBSTONES = 128;
export const MAX_RETIREMENT_TOMBSTONE_BYTES = 262_144;
export const MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES = 2_048;
export const MAX_UNRESOLVED_INVOCATIONS = 64;
export const MAX_COMPLETED_HANDOFF_ROUTING_PAIRS = 256;
export const HANDOFF_ROUTING_COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const MAX_IDENTIFIER_LENGTH = 58;
const MAX_INSTANCE_ID_LENGTH = 64;
const MAX_VERSION_LENGTH = 64;
const MAX_OBSERVED_AT_LENGTH = 40;
const MAX_SIGNAL_LENGTH = 16;

const sequenceSchema = z.number().int().nonnegative().safe();
const positiveSequenceSchema = z.number().int().positive().safe();
const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
const observedAtSchema = z.string().datetime({ offset: true }).max(MAX_OBSERVED_AT_LENGTH);
const boundedVersionSchema = strictBundleManifestSchema.shape.version.max(MAX_VERSION_LENGTH);

export const buildSummarySchema = z
  .object({
    version: boundedVersionSchema,
    buildSetId: strictBundleManifestSchema.shape.buildSetId,
    bundleHash: strictBundleManifestSchema.shape.bundleHash,
    flavor: strictBundleManifestSchema.shape.flavor,
  })
  .strict()
  .readonly();

export const incumbentIdentitySummarySchema = z
  .object({
    version: boundedVersionSchema,
    bundleHash: strictBundleManifestSchema.shape.bundleHash,
    flavor: strictBundleManifestSchema.shape.flavor,
    instanceId: z.string().min(1).max(MAX_INSTANCE_ID_LENGTH),
  })
  .strict()
  .readonly();

export type ValidatedTargetSummary = Readonly<{ build: BuildSummary }>;

export const validatedTargetSummarySchema: z.ZodType<ValidatedTargetSummary> = z
  .object({ build: buildSummarySchema })
  .strict()
  .readonly();

export type InvalidTargetSummary = Readonly<{
  failure: InvalidTargetFailure;
  expectedBuild?: BuildSummary;
}>;

const invalidTargetFailureSchema = z.enum([
  'bundle-dir-not-canonical',
  'bundle-dir-unavailable',
  'expected-manifest-invalid',
  'adjacent-manifest-unavailable',
  'adjacent-manifest-invalid',
  'adjacent-manifest-mismatch',
  'adjacent-bundle-mismatch',
]);

export const invalidTargetSummarySchema: z.ZodType<InvalidTargetSummary> = z
  .object({
    failure: invalidTargetFailureSchema,
    expectedBuild: buildSummarySchema.optional(),
  })
  .strict()
  .readonly();

const strictBundleIdentityFailureSchema: z.ZodType<StrictBundleIdentityFailure> = z.enum([
  'embedded_identity_unavailable',
  'adjacent_manifest_unavailable',
  'adjacent_manifest_invalid',
  'adjacent_manifest_mismatch',
]);

export type DurableHandoffRoutingBasis =
  | Readonly<{ kind: 'incumbent-absent' }>
  | Readonly<{
      kind: 'incumbent-unresolved';
      cause: 'unreadable-record' | 'health-request-failed' | 'health-shape-rejected';
    }>
  | Readonly<{ kind: 'incumbent-unusable'; cause: 'draining' | 'identity-mismatch' }>
  | Readonly<{ kind: 'invoking-identity-unavailable'; failure: StrictBundleIdentityFailure }>
  | Readonly<{ kind: 'incumbent-identity-unavailable'; incumbent: IncumbentIdentitySummary }>
  | Readonly<{ kind: 'same-build-set'; buildSetId: string }>
  | Readonly<{
      kind: 'invoking-build-not-older';
      comparison: 'same-version' | 'newer-version';
      invoking: BuildSummary;
      incumbent: BuildSummary;
    }>
  | Readonly<{ kind: 'invalid-incumbent-target'; evidence: InvalidTargetSummary }>;

export const durableHandoffRoutingBasisSchema: z.ZodType<DurableHandoffRoutingBasis> = z.union([
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

export const HANDOFF_CONTINUATION_REASON_POLICY_PROJECTIONS: Readonly<
  Record<Exclude<HandoffContinuationReason['kind'], 'routing'>, ObligationPolicyProjection>
> = Object.freeze({
  'handoff-not-applicable': projectRoutingObligationToPolicy(
    HANDOFF_CONTINUATION_REASON_OBLIGATIONS['handoff-not-applicable'],
  ),
  'handoff-abandoned': projectRoutingObligationToPolicy(HANDOFF_CONTINUATION_REASON_OBLIGATIONS['handoff-abandoned']),
});

export const ABSENT_HANDOFF_RESULT_POLICY_PROJECTION = projectRoutingObligationToPolicy(
  ABSENT_HANDOFF_RESULT_OBLIGATION,
);

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
    .object({ kind: z.literal('delegated-success'), version: boundedVersionSchema })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('delegated-exit'),
      version: boundedVersionSchema,
      exitCode: z.number().int().min(0).max(255),
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('delegated-signal'), version: boundedVersionSchema, signal: signalSchema })
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

const emptyRetirementHistory: RetirementHistoryTruncated = Object.freeze({
  kind: 'retirement-history-truncated',
  expiredIdentityCount: 0,
  causes: Object.freeze({
    'selection-evicted-at-capacity': 0,
    'completed-pair-compaction': 0,
    'operator-resolved': 0,
  }),
  minSelectionSequence: null,
  maxSelectionSequence: null,
  earliestSelectedAt: null,
  latestSelectedAt: null,
});

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function validateJournalRelationships(
  journal: {
    sequenceHighWater: number;
    events: readonly HandoffRoutingJournalEvent[];
    retirementTombstones: readonly RetirementTombstone[];
  },
  context: z.RefinementCtx,
): void {
  const envelopes = [...journal.events, ...journal.retirementTombstones];
  const sequences = new Set<number>();
  const eventIds = new Set<string>();
  for (const envelope of envelopes) {
    if (envelope.sequence > journal.sequenceHighWater) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'entry sequence exceeds journal high-water' });
    }
    if (sequences.has(envelope.sequence)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'entry sequences must be unique' });
    }
    if (eventIds.has(envelope.eventId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'event IDs must be unique' });
    }
    sequences.add(envelope.sequence);
    eventIds.add(envelope.eventId);
  }
  if (journal.events.some((event, index) => index > 0 && journal.events[index - 1].sequence >= event.sequence)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'journal events must be sequence ordered' });
  }
  if (journal.retirementTombstones.length > MAX_RETIREMENT_TOMBSTONES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'retirement tombstone count exceeds its bound' });
  }
  const tombstoneBytes = journal.retirementTombstones.reduce((sum, tombstone) => sum + encodedBytes(tombstone), 0);
  if (tombstoneBytes > MAX_RETIREMENT_TOMBSTONE_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'retirement tombstone bytes exceed their bound' });
  }
  if (
    journal.retirementTombstones.some((tombstone) => encodedBytes(tombstone) > MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'retirement tombstone exceeds its item bound' });
  }

  const selections = journal.events.filter(
    (event): event is RoutingSelectedEvent => event.eventKind === 'routing-selected',
  );
  const terminals = journal.events.filter((event): event is HandoffRoutingTerminalEvent => event.phase === 'terminal');
  const selectionInvocations = new Set<string>();
  const terminalInvocations = new Set<string>();
  const tombstoneInvocations = new Set<string>();
  for (const selection of selections) {
    if (selectionInvocations.has(selection.invocationId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'an invocation may retain only one selection' });
    }
    selectionInvocations.add(selection.invocationId);
  }
  for (const terminal of terminals) {
    if (terminalInvocations.has(terminal.invocationId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'an invocation may retain only one terminal' });
    }
    terminalInvocations.add(terminal.invocationId);
    const selection = selections.find((candidate) => candidate.invocationId === terminal.invocationId);
    if (
      selection !== undefined &&
      terminal.selection.kind === 'with-selection-sequence' &&
      terminal.selection.selectionSequence !== selection.sequence
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal references another selection sequence' });
    }
  }
  for (const tombstone of journal.retirementTombstones) {
    if (tombstoneInvocations.has(tombstone.invocationId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'an invocation may retain only one tombstone' });
    }
    if (selectionInvocations.has(tombstone.invocationId) || terminalInvocations.has(tombstone.invocationId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'retired identity cannot also remain active' });
    }
    tombstoneInvocations.add(tombstone.invocationId);
  }
  const unresolvedCount = selections.filter((selection) => !terminalInvocations.has(selection.invocationId)).length;
  if (unresolvedCount > MAX_UNRESOLVED_INVOCATIONS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'unresolved invocation window exceeds its bound' });
  }
}

export const handoffRoutingJournalSchema = z
  .object({
    generation: z.literal(HANDOFF_ROUTING_STATUS_GENERATION),
    sequenceHighWater: sequenceSchema,
    events: z.array(z.union([routingSelectedEventSchema, terminalEventSchema])).readonly(),
    retirementTombstones: z.array(retirementTombstoneSchema).readonly(),
    retirementHistoryTruncated: retirementHistoryTruncatedSchema,
  })
  .strict()
  .superRefine(validateJournalRelationships)
  .readonly();

export type HandoffRoutingJournal = z.infer<typeof handoffRoutingJournalSchema>;

export function emptyHandoffRoutingJournal(): HandoffRoutingJournal {
  return handoffRoutingJournalSchema.parse({
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequenceHighWater: 0,
    events: [],
    retirementTombstones: [],
    retirementHistoryTruncated: emptyRetirementHistory,
  });
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

type MutableJournal = {
  generation: typeof HANDOFF_ROUTING_STATUS_GENERATION;
  sequenceHighWater: number;
  events: HandoffRoutingJournalEvent[];
  retirementTombstones: RetirementTombstone[];
  retirementHistoryTruncated: RetirementHistoryTruncated;
};

export type HandoffRoutingReductionRejection =
  | 'empty-transaction'
  | 'invalid-journal'
  | 'invalid-transition'
  | 'duplicate-event-id'
  | 'duplicate-selection'
  | 'selection-sequence-mismatch'
  | 'duplicate-terminal'
  | 'resolution-without-opening'
  | 'resolution-after-terminal'
  | 'journal-capacity-exceeded';

export type HandoffRoutingReductionResult =
  | Readonly<{
      kind: 'accepted';
      journal: HandoffRoutingJournal;
      committedSequences: readonly number[];
    }>
  | Readonly<{
      kind: 'rejected';
      reason: HandoffRoutingReductionRejection;
      journal: HandoffRoutingJournal;
    }>;

function mutableJournal(journal: HandoffRoutingJournal): MutableJournal {
  return {
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequenceHighWater: journal.sequenceHighWater,
    events: [...journal.events],
    retirementTombstones: [...journal.retirementTombstones],
    retirementHistoryTruncated: journal.retirementHistoryTruncated,
  };
}

function nextSequence(journal: MutableJournal, committedSequences: number[]): number {
  journal.sequenceHighWater += 1;
  committedSequences.push(journal.sequenceHighWater);
  return journal.sequenceHighWater;
}

function selectionForInvocation(journal: MutableJournal, invocationId: string): RoutingSelectedEvent | undefined {
  return journal.events.find(
    (event): event is RoutingSelectedEvent =>
      event.eventKind === 'routing-selected' && event.invocationId === invocationId,
  );
}

function terminalForInvocation(journal: MutableJournal, invocationId: string): HandoffRoutingTerminalEvent | undefined {
  return journal.events.find(
    (event): event is HandoffRoutingTerminalEvent => event.phase === 'terminal' && event.invocationId === invocationId,
  );
}

function tombstoneForInvocation(journal: MutableJournal, invocationId: string): RetirementTombstone | undefined {
  return journal.retirementTombstones.find((tombstone) => tombstone.invocationId === invocationId);
}

function unresolvedSelections(journal: MutableJournal): RoutingSelectedEvent[] {
  return journal.events
    .filter(
      (event): event is RoutingSelectedEvent =>
        event.eventKind === 'routing-selected' && terminalForInvocation(journal, event.invocationId) === undefined,
    )
    .sort((left, right) => left.sequence - right.sequence);
}

function completedPairs(
  journal: MutableJournal,
): Array<Readonly<{ selection: RoutingSelectedEvent; terminal: HandoffRoutingTerminalEvent }>> {
  return journal.events
    .filter((event): event is RoutingSelectedEvent => event.eventKind === 'routing-selected')
    .map((selection) => ({ selection, terminal: terminalForInvocation(journal, selection.invocationId) }))
    .filter(
      (pair): pair is Readonly<{ selection: RoutingSelectedEvent; terminal: HandoffRoutingTerminalEvent }> =>
        pair.terminal !== undefined,
    )
    .sort((left, right) => left.selection.sequence - right.selection.sequence);
}

function createTombstone(
  journal: MutableJournal,
  committedSequences: number[],
  selection: RoutingSelectedEvent,
  retirementCause: RetirementTombstone['retirementCause'],
  terminalExisted: boolean,
  observedAt: string,
  resolutionReason?: RetirementTombstone['resolutionReason'],
  eventId?: string,
): RetirementTombstone {
  const sequence = nextSequence(journal, committedSequences);
  return retirementTombstoneSchema.parse({
    generation: HANDOFF_ROUTING_STATUS_GENERATION,
    sequence,
    eventId: eventId ?? `retirement-${sequence}`,
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
}

function removePair(journal: MutableJournal, invocationId: string): void {
  journal.events = journal.events.filter((event) => event.invocationId !== invocationId);
}

function retireSelection(
  journal: MutableJournal,
  committedSequences: number[],
  selection: RoutingSelectedEvent,
  cause: RetirementTombstone['retirementCause'],
  observedAt: string,
  resolutionReason?: RetirementTombstone['resolutionReason'],
): void {
  const terminalExisted = terminalForInvocation(journal, selection.invocationId) !== undefined;
  const tombstone = createTombstone(
    journal,
    committedSequences,
    selection,
    cause,
    terminalExisted,
    observedAt,
    resolutionReason,
  );
  removePair(journal, selection.invocationId);
  journal.retirementTombstones.push(tombstone);
}

function rollUpTombstone(journal: MutableJournal, tombstone: RetirementTombstone): void {
  const aggregate = journal.retirementHistoryTruncated;
  const count = aggregate.expiredIdentityCount + 1;
  journal.retirementHistoryTruncated = retirementHistoryTruncatedSchema.parse({
    kind: 'retirement-history-truncated',
    expiredIdentityCount: count,
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
}

function tombstoneBytes(journal: MutableJournal): number {
  return journal.retirementTombstones.reduce((sum, tombstone) => sum + encodedBytes(tombstone), 0);
}

function expireOldestTombstone(journal: MutableJournal): boolean {
  if (journal.retirementTombstones.length === 0) return false;
  journal.retirementTombstones.sort(
    (left, right) =>
      left.selectionSequence - right.selectionSequence || left.invocationId.localeCompare(right.invocationId),
  );
  const expired = journal.retirementTombstones.shift();
  if (expired === undefined) return false;
  rollUpTombstone(journal, expired);
  return true;
}

function enforceTombstoneBounds(journal: MutableJournal): void {
  while (
    journal.retirementTombstones.length > MAX_RETIREMENT_TOMBSTONES ||
    tombstoneBytes(journal) > MAX_RETIREMENT_TOMBSTONE_BYTES ||
    journal.retirementTombstones.some((tombstone) => encodedBytes(tombstone) > MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES)
  ) {
    if (!expireOldestTombstone(journal)) return;
  }
}

function isStableCompletedPair(pair: {
  selection: RoutingSelectedEvent;
  terminal: HandoffRoutingTerminalEvent;
}): boolean {
  if (pair.terminal.disposition.kind === 'delegated-success') return true;
  return (
    pair.selection.disposition.kind === 'continue-current' &&
    (pair.selection.disposition.basis.kind === 'same-build-set' ||
      pair.selection.disposition.basis.kind === 'incumbent-absent')
  );
}

function compactExpiredCompletedPairs(
  journal: MutableJournal,
  committedSequences: number[],
  nowMs: number,
  observedAt: string,
): void {
  const pairs = completedPairs(journal);
  const latestStable = [...pairs].reverse().find(isStableCompletedPair);
  const newestSequences = new Set(
    pairs.slice(-MAX_COMPLETED_HANDOFF_ROUTING_PAIRS).map((pair) => pair.selection.sequence),
  );
  const cutoff = nowMs - HANDOFF_ROUTING_COMPLETED_RETENTION_MS;
  for (const pair of pairs) {
    if (pair === latestStable) continue;
    const selectedAtMs = Date.parse(pair.selection.observedAt);
    if (selectedAtMs >= cutoff && newestSequences.has(pair.selection.sequence)) continue;
    retireSelection(journal, committedSequences, pair.selection, 'completed-pair-compaction', observedAt);
    enforceTombstoneBounds(journal);
  }
}

function journalWithoutByteRefinement(journal: MutableJournal): HandoffRoutingJournal | null {
  const parsed = handoffRoutingJournalSchema.safeParse(journal);
  return parsed.success ? parsed.data : null;
}

export type HandoffRoutingSerializationResult =
  | Readonly<{ kind: 'serialized'; serialized: string; bytes: number }>
  | Readonly<{ kind: 'rejected'; reason: 'invalid-journal' | 'journal-too-large' }>;

export function serializeHandoffRoutingJournal(journal: HandoffRoutingJournal): HandoffRoutingSerializationResult {
  const parsed = handoffRoutingJournalSchema.safeParse(journal);
  if (!parsed.success) return { kind: 'rejected', reason: 'invalid-journal' };
  const serialized = JSON.stringify(parsed.data);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  return bytes <= MAX_HANDOFF_ROUTING_JOURNAL_BYTES
    ? { kind: 'serialized', serialized, bytes }
    : { kind: 'rejected', reason: 'journal-too-large' };
}

function journalFitsWithClosingReserve(journal: MutableJournal): boolean {
  const parsed = journalWithoutByteRefinement(journal);
  if (parsed === null) return false;
  const serialized = serializeHandoffRoutingJournal(parsed);
  if (serialized.kind === 'rejected') return false;
  return (
    serialized.bytes + unresolvedSelections(journal).length * MAX_LEGAL_CLOSING_REPLACEMENT_BYTES <=
    MAX_HANDOFF_ROUTING_JOURNAL_BYTES
  );
}

function compactOldestCompletedPair(
  journal: MutableJournal,
  committedSequences: number[],
  observedAt: string,
): boolean {
  const pairs = completedPairs(journal);
  const latestStable = [...pairs].reverse().find(isStableCompletedPair);
  const pair = pairs.find((candidate) => candidate !== latestStable);
  if (pair === undefined) return false;
  retireSelection(journal, committedSequences, pair.selection, 'completed-pair-compaction', observedAt);
  enforceTombstoneBounds(journal);
  return true;
}

function evictOldestOpening(journal: MutableJournal, committedSequences: number[], observedAt: string): boolean {
  const opening = unresolvedSelections(journal)[0];
  if (opening === undefined) return false;
  retireSelection(journal, committedSequences, opening, 'selection-evicted-at-capacity', observedAt);
  enforceTombstoneBounds(journal);
  return true;
}

function admitWithinBounds(journal: MutableJournal, committedSequences: number[], observedAt: string): boolean {
  while (unresolvedSelections(journal).length > MAX_UNRESOLVED_INVOCATIONS) {
    if (!evictOldestOpening(journal, committedSequences, observedAt)) return false;
  }
  enforceTombstoneBounds(journal);
  while (!journalFitsWithClosingReserve(journal)) {
    if (compactOldestCompletedPair(journal, committedSequences, observedAt)) continue;
    if (expireOldestTombstone(journal)) continue;
    if (evictOldestOpening(journal, committedSequences, observedAt)) continue;
    return false;
  }
  return true;
}

function createRoutingSelectedEvent(
  transition: z.infer<typeof routingSelectedTransitionSchema>,
  sequence: number,
): RoutingSelectedEvent {
  return routingSelectedEventSchema.parse({
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
}

function selectionFitsWithClosingReserve(
  journal: MutableJournal,
  transition: z.infer<typeof routingSelectedTransitionSchema>,
): boolean {
  const sequence = journal.sequenceHighWater + 1;
  return journalFitsWithClosingReserve({
    ...journal,
    sequenceHighWater: sequence,
    events: [...journal.events, createRoutingSelectedEvent(transition, sequence)],
  });
}

function appendSelection(
  journal: MutableJournal,
  transition: z.infer<typeof routingSelectedTransitionSchema>,
  committedSequences: number[],
): HandoffRoutingReductionRejection | null {
  if (
    selectionForInvocation(journal, transition.invocationId) !== undefined ||
    tombstoneForInvocation(journal, transition.invocationId) !== undefined
  ) {
    return 'duplicate-selection';
  }
  if (unresolvedSelections(journal).length >= MAX_UNRESOLVED_INVOCATIONS) {
    if (!evictOldestOpening(journal, committedSequences, transition.observedAt)) {
      return 'journal-capacity-exceeded';
    }
  }
  while (!selectionFitsWithClosingReserve(journal, transition)) {
    if (compactOldestCompletedPair(journal, committedSequences, transition.observedAt)) continue;
    if (expireOldestTombstone(journal)) continue;
    if (evictOldestOpening(journal, committedSequences, transition.observedAt)) continue;
    return 'journal-capacity-exceeded';
  }
  const sequence = nextSequence(journal, committedSequences);
  journal.events.push(createRoutingSelectedEvent(transition, sequence));
  return null;
}

function terminalGapDisposition(
  transition: z.infer<typeof terminalTransitionSchema>,
): Extract<StoredTerminalDisposition, { kind: 'failed-without-selection' | 'finalized-without-selection' }> {
  if (transition.disposition.kind === 'execution-failed') {
    return { kind: 'failed-without-selection', throwPhase: transition.disposition.throwPhase };
  }
  return { kind: 'finalized-without-selection', terminal: transition.disposition };
}

function appendTerminalEvent(
  journal: MutableJournal,
  transition: z.infer<typeof terminalTransitionSchema>,
  disposition: StoredTerminalDisposition,
  committedSequences: number[],
): void {
  const sequence = nextSequence(journal, committedSequences);
  journal.events.push(
    terminalEventSchema.parse({
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      sequence,
      eventId: transition.eventId,
      invocationId: transition.invocationId,
      observedAt: transition.observedAt,
      eventKind: transition.kind,
      phase: 'terminal',
      selection: transition.selection,
      disposition,
    }),
  );
}

function appendTerminal(
  journal: MutableJournal,
  transition: z.infer<typeof terminalTransitionSchema>,
  committedSequences: number[],
): HandoffRoutingReductionRejection | null {
  if (terminalForInvocation(journal, transition.invocationId) !== undefined) return 'duplicate-terminal';
  if (transition.selection.kind === 'without-selection') {
    appendTerminalEvent(journal, transition, terminalGapDisposition(transition), committedSequences);
    return null;
  }

  const selection = selectionForInvocation(journal, transition.invocationId);
  if (selection !== undefined) {
    if (selection.sequence !== transition.selection.selectionSequence) return 'selection-sequence-mismatch';
    appendTerminalEvent(journal, transition, transition.disposition, committedSequences);
    return null;
  }

  const tombstone = tombstoneForInvocation(journal, transition.invocationId);
  if (tombstone === undefined || tombstone.selectionSequence !== transition.selection.selectionSequence) {
    appendTerminalEvent(
      journal,
      transition,
      {
        kind: 'terminal-without-retained-selection',
        knowledge: 'identity-expired-or-selection-unavailable',
        terminal: transition.disposition,
      },
      committedSequences,
    );
    return null;
  }
  if (tombstone.retirementCause === 'completed-pair-compaction' || tombstone.terminalExisted) {
    return 'duplicate-terminal';
  }
  if (tombstone.retirementCause === 'operator-resolved') {
    if (tombstone.resolutionReason === undefined) {
      throw new Error('An operator-resolution tombstone must carry its resolution reason.');
    }
    journal.retirementTombstones = journal.retirementTombstones.filter((candidate) => candidate !== tombstone);
    appendTerminalEvent(
      journal,
      transition,
      {
        kind: 'terminal-after-operator-resolution',
        resolutionReason: tombstone.resolutionReason,
        retiredSelection: {
          selectionSequence: tombstone.selectionSequence,
          selectedAt: tombstone.selectedAt,
          owner: tombstone.owner,
          selectedDisposition: tombstone.selectedDisposition,
        },
        terminal: transition.disposition,
      },
      committedSequences,
    );
    return null;
  }
  const replacementSequence = nextSequence(journal, committedSequences);
  journal.retirementTombstones = journal.retirementTombstones.map((candidate) =>
    candidate === tombstone
      ? retirementTombstoneSchema.parse({
          ...candidate,
          sequence: replacementSequence,
          eventId: transition.eventId,
          observedAt: transition.observedAt,
          terminalExisted: true,
        })
      : candidate,
  );
  return null;
}

function resolveOpening(
  journal: MutableJournal,
  transition: z.infer<typeof operatorResolvedTransitionSchema>,
  committedSequences: number[],
): HandoffRoutingReductionRejection | null {
  const selection = selectionForInvocation(journal, transition.invocationId);
  if (selection === undefined) return 'resolution-without-opening';
  if (selection.sequence !== transition.selectionSequence) return 'selection-sequence-mismatch';
  if (terminalForInvocation(journal, transition.invocationId) !== undefined) return 'resolution-after-terminal';
  const tombstone = createTombstone(
    journal,
    committedSequences,
    selection,
    'operator-resolved',
    false,
    transition.observedAt,
    transition.reason,
    transition.eventId,
  );
  removePair(journal, selection.invocationId);
  journal.retirementTombstones.push(tombstone);
  return null;
}

function transitionObservedAt(transitions: readonly HandoffRoutingTransition[]): string {
  return transitions.reduce(
    (latest, transition) => (transition.observedAt > latest ? transition.observedAt : latest),
    transitions[0].observedAt,
  );
}

export function reduceHandoffRoutingJournal(
  current: HandoffRoutingJournal,
  transitions: readonly HandoffRoutingTransition[],
): HandoffRoutingReductionResult {
  const parsedJournal = handoffRoutingJournalSchema.safeParse(current);
  if (!parsedJournal.success) return { kind: 'rejected', reason: 'invalid-journal', journal: current };
  if (transitions.length === 0) return { kind: 'rejected', reason: 'empty-transaction', journal: parsedJournal.data };
  const parsedTransitions = z.array(handoffRoutingTransitionSchema).safeParse(transitions);
  if (!parsedTransitions.success) {
    return { kind: 'rejected', reason: 'invalid-transition', journal: parsedJournal.data };
  }

  const journal = mutableJournal(parsedJournal.data);
  const committedSequences: number[] = [];
  const observedAt = transitionObservedAt(parsedTransitions.data);
  const nowMs = Date.parse(observedAt);
  compactExpiredCompletedPairs(journal, committedSequences, nowMs, observedAt);

  const existingEventIds = new Set([...journal.events, ...journal.retirementTombstones].map((event) => event.eventId));
  for (const transition of parsedTransitions.data) {
    if (existingEventIds.has(transition.eventId)) {
      return { kind: 'rejected', reason: 'duplicate-event-id', journal: parsedJournal.data };
    }
    existingEventIds.add(transition.eventId);
    let rejection: HandoffRoutingReductionRejection | null;
    switch (transition.kind) {
      case 'routing-selected':
        rejection = appendSelection(journal, transition, committedSequences);
        break;
      case 'execution-failed':
      case 'continuation-finalized':
        rejection = appendTerminal(journal, transition, committedSequences);
        break;
      case 'operator-resolved':
        rejection = resolveOpening(journal, transition, committedSequences);
        break;
      default:
        return assertNever(transition);
    }
    if (rejection !== null) return { kind: 'rejected', reason: rejection, journal: parsedJournal.data };
  }

  compactExpiredCompletedPairs(journal, committedSequences, nowMs, observedAt);
  if (!admitWithinBounds(journal, committedSequences, observedAt)) {
    return { kind: 'rejected', reason: 'journal-capacity-exceeded', journal: parsedJournal.data };
  }
  journal.events.sort((left, right) => left.sequence - right.sequence);
  journal.retirementTombstones.sort(
    (left, right) =>
      left.selectionSequence - right.selectionSequence || left.invocationId.localeCompare(right.invocationId),
  );
  const accepted = handoffRoutingJournalSchema.safeParse(journal);
  if (!accepted.success) return { kind: 'rejected', reason: 'journal-capacity-exceeded', journal: parsedJournal.data };
  const serialized = serializeHandoffRoutingJournal(accepted.data);
  if (serialized.kind === 'rejected') {
    return { kind: 'rejected', reason: 'journal-capacity-exceeded', journal: parsedJournal.data };
  }
  return { kind: 'accepted', journal: accepted.data, committedSequences: Object.freeze(committedSequences) };
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

export function persistedHandoffDispositionPolicy(disposition: PersistedHandoffDisposition): RoutingStatusPolicy {
  switch (disposition.kind) {
    case 'incumbent-absent':
    case 'incumbent-unresolved':
    case 'incumbent-unusable':
    case 'invoking-identity-unavailable':
    case 'incumbent-identity-unavailable':
    case 'same-build-set':
    case 'invoking-build-not-older':
    case 'invalid-incumbent-target':
      return HANDOFF_ROUTING_BASIS_POLICIES[disposition.kind];
    case 'continue-current':
      return HANDOFF_ROUTING_BASIS_POLICIES[disposition.basis.kind];
    case 'handoff-selected':
      return {
        durability: 'lifecycle-journal',
        retention: 'until-terminal',
        severity: 'info',
        exitContribution: 0,
      };
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
    case 'delegated-exit':
    case 'delegated-signal':
    case 'execution-failed':
    case 'failed-without-selection':
    case 'finalized-without-selection':
    case 'terminal-without-retained-selection':
    case 'terminal-after-operator-resolution':
      return boundedWarningPolicy;
    case 'selection-evicted-at-capacity':
      return boundedWarningPolicy;
    case 'completed-pair-compaction':
      return {
        durability: 'lifecycle-journal',
        retention: 'bounded-history',
        severity: 'info',
        exitContribution: 0,
      };
    case 'operator-resolved':
      return boundedWarningPolicy;
    case 'retirement-history-truncated':
      return {
        durability: 'lifecycle-journal',
        retention: 'bounded-history',
        severity: 'warning',
        exitContribution: disposition.causes['selection-evicted-at-capacity'] > 0 ? 75 : 0,
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
      sequenceHighWater: number;
      statuses: readonly HandoffRoutingInvocationStatus[];
      retirementHistoryTruncated: RetirementHistoryTruncated;
    }>
  | Readonly<{ kind: 'unreadable'; reason: 'invalid-json' | 'invalid-shape' | 'too-large' | 'recovery-conflict' }>
  | Readonly<{ kind: 'unsupported-generation'; generation: number }>;

const MAX_TEXT = '\u0800';
const MAX_VERSION = `1.0.0-${'x'.repeat(MAX_VERSION_LENGTH - 6)}`;
const MAX_ID = MAX_TEXT.repeat(MAX_IDENTIFIER_LENGTH);
const MAX_INCARNATION = MAX_TEXT.repeat(256);
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
  observedAt: '9999-12-31T23:59:59.999+23:59',
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
    observedAt: '9999-12-31T23:59:59.999+23:59',
    eventKind: 'retirement-tombstone',
    phase: 'retirement',
    selectionSequence: Number.MAX_SAFE_INTEGER,
    selectedAt: '9999-12-31T23:59:59.999+23:59',
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
  observedAt: '9999-12-31T23:59:59.999+23:59',
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
  observedAt: '9999-12-31T23:59:59.999+23:59',
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
  observedAt: '9999-12-31T23:59:59.999+23:59',
  eventKind: 'execution-failed',
  phase: 'terminal',
  selection: { kind: 'with-selection-sequence', selectionSequence: Number.MAX_SAFE_INTEGER },
  disposition: {
    kind: 'terminal-after-operator-resolution',
    resolutionReason: 'operator-abandoned-unobservable',
    retiredSelection: {
      selectionSequence: Number.MAX_SAFE_INTEGER,
      selectedAt: '9999-12-31T23:59:59.999+23:59',
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
  observedAt: '9999-12-31T23:59:59.999+23:59',
  eventKind: 'continuation-finalized',
  phase: 'terminal',
  selection: { kind: 'with-selection-sequence', selectionSequence: Number.MAX_SAFE_INTEGER },
  disposition: {
    kind: 'terminal-after-operator-resolution',
    resolutionReason: 'operator-abandoned-unobservable',
    retiredSelection: {
      selectionSequence: Number.MAX_SAFE_INTEGER,
      selectedAt: '9999-12-31T23:59:59.999+23:59',
      owner: MAX_SELECTION.owner,
      selectedDisposition: MAX_SELECTION.disposition,
    },
    terminal: { kind: 'continued-current', reason: { kind: 'routing', basis: MAX_BASIS } },
  },
});

export const MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES = Object.freeze({
  'routing-selected': encodedBytes(MAX_SELECTION),
  'execution-failed': Math.max(encodedBytes(MAX_EXECUTION_TERMINAL), encodedBytes(MAX_RESOLVED_EXECUTION_TERMINAL)),
  'continuation-finalized': Math.max(
    encodedBytes(MAX_FINALIZED_TERMINAL),
    encodedBytes(MAX_RESOLVED_FINALIZED_TERMINAL),
  ),
});

export const MAX_LEGAL_CLOSING_REPLACEMENT_BYTES = Math.max(
  MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['execution-failed'],
  MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['continuation-finalized'],
  MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
);
