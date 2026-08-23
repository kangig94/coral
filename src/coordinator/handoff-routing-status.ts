import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { strictBundleManifestSchema, type StrictBundleIdentityFailure } from '../infra/bundle-manifest.js';
import { assertNever } from '../infra/error-format.js';
import type { InvalidTargetFailure } from '../infra/handoff-target.js';
import { createMonotonicClock } from '../infra/monotonic-clock.js';
import { processIncarnationSchema } from '../infra/node-process.js';
import type { TimePort } from '../infra/port-types.js';
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
export const MAX_HANDOFF_ROUTING_STATUS_BYTES = 1_048_576;
export const MAX_RETIREMENT_TOMBSTONES = 128;
export const MAX_RETIREMENT_TOMBSTONE_BYTES = 262_144;
export const MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES = 2_048;
export const MAX_UNRESOLVED_INVOCATIONS = 64;
export const MAX_COMPLETED_HANDOFF_ROUTING_PAIRS = 256;
export const HANDOFF_ROUTING_COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const MAX_BOUNDED_TERMINAL_HISTORY = MAX_COMPLETED_HANDOFF_ROUTING_PAIRS;

const MAX_IDENTIFIER_LENGTH = 58;
const MAX_INSTANCE_ID_LENGTH = 64;
const MAX_VERSION_LENGTH = 64;
const MAX_OBSERVED_AT_LENGTH = 24;
const MAX_SIGNAL_LENGTH = 16;

const sequenceSchema = z.number().int().nonnegative().safe();
const positiveSequenceSchema = z.number().int().positive().safe();
const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
const observedAtSchema = z.string().datetime({ offset: false, precision: 3 }).length(MAX_OBSERVED_AT_LENGTH);
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

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
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
      cause: 'contended' | 'capacity-exhausted' | 'rejected-transition';
    }>
  | Readonly<{
      kind: 'undeterminable';
      cause: 'io-failed' | 'unreadable' | 'unsupported-generation';
      errcode: number;
    }>;

type StatusRow = Readonly<{
  body_json: string;
}>;

type TombstoneBoundsRow = Readonly<{
  count: number;
  bytes: number;
}>;

type GenerationRow = Readonly<{ user_version: number }>;

const SQLITE_BUSY = 5;
const SQLITE_CANTOPEN = 14;
const SQLITE_FULL = 13;
const SQLITE_NOTADB = 26;
const SQLITE_CORRUPT = 11;
const SQLITE_ERROR = 1;
const PUBLICATION_CONTENTION_TIMEOUT_MS = 1_000;
const PUBLICATION_RETRY_DELAY_MS = 10;

class RejectedTransitionError extends Error {}

class UnreadableStatusError extends Error {
  readonly errcode: number;

  constructor(errcode = SQLITE_CORRUPT) {
    super();
    this.errcode = errcode;
  }
}

class UnsupportedGenerationError extends Error {}

class CapacityExhaustedError extends Error {
  readonly errcode = SQLITE_FULL;
}

function schemaSql(): string {
  return `
    CREATE TABLE handoff_routing_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL CHECK (generation = ${HANDOFF_ROUTING_STATUS_GENERATION}),
      expired_identity_count INTEGER NOT NULL CHECK (expired_identity_count >= 0),
      capacity_eviction_count INTEGER NOT NULL CHECK (capacity_eviction_count >= 0),
      completed_pair_compaction_count INTEGER NOT NULL CHECK (completed_pair_compaction_count >= 0),
      operator_resolved_count INTEGER NOT NULL CHECK (operator_resolved_count >= 0),
      min_selection_sequence INTEGER CHECK (min_selection_sequence > 0),
      max_selection_sequence INTEGER CHECK (max_selection_sequence > 0),
      earliest_selected_at TEXT,
      latest_selected_at TEXT,
      CHECK (
        capacity_eviction_count + completed_pair_compaction_count + operator_resolved_count =
          expired_identity_count
      ),
      CHECK (
        (expired_identity_count = 0 AND min_selection_sequence IS NULL AND max_selection_sequence IS NULL AND
          earliest_selected_at IS NULL AND latest_selected_at IS NULL) OR
        (expired_identity_count > 0 AND min_selection_sequence IS NOT NULL AND max_selection_sequence IS NOT NULL AND
          earliest_selected_at IS NOT NULL AND latest_selected_at IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE handoff_routing_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      generation INTEGER NOT NULL CHECK (generation = ${HANDOFF_ROUTING_STATUS_GENERATION}),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND ${MAX_IDENTIFIER_LENGTH}),
      invocation_id TEXT NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND ${MAX_IDENTIFIER_LENGTH}),
      observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 1 AND ${MAX_OBSERVED_AT_LENGTH}),
      record_kind TEXT NOT NULL CHECK (record_kind IN ('selection', 'terminal', 'retirement')),
      event_kind TEXT NOT NULL CHECK (
        event_kind IN ('routing-selected', 'execution-failed', 'continuation-finalized', 'retirement-tombstone')
      ),
      selection_sequence INTEGER CHECK (selection_sequence > 0),
      retirement_cause TEXT CHECK (
        retirement_cause IN ('selection-evicted-at-capacity', 'completed-pair-compaction', 'operator-resolved')
      ),
      terminal_existed INTEGER CHECK (terminal_existed IN (0, 1)),
      body_json TEXT NOT NULL CHECK (json_valid(body_json)),
      encoded_bytes INTEGER GENERATED ALWAYS AS (length(CAST(body_json AS BLOB))) STORED,
      completed_pair_stable INTEGER GENERATED ALWAYS AS (
        CASE
          WHEN record_kind = 'terminal' AND json_extract(body_json, '$.disposition.kind') = 'delegated-success'
            THEN 1
          WHEN record_kind = 'selection' AND
            json_extract(body_json, '$.disposition.kind') = 'continue-current' AND
            json_extract(body_json, '$.disposition.basis.kind') IN ('same-build-set', 'incumbent-absent')
            THEN 1
          ELSE 0
        END
      ) STORED,
      CHECK (
        (record_kind = 'selection' AND event_kind = 'routing-selected' AND selection_sequence IS NULL AND
          retirement_cause IS NULL AND terminal_existed IS NULL) OR
        (record_kind = 'terminal' AND event_kind IN ('execution-failed', 'continuation-finalized') AND
          retirement_cause IS NULL AND terminal_existed IS NULL) OR
        (record_kind = 'retirement' AND event_kind = 'retirement-tombstone' AND selection_sequence IS NOT NULL AND
          retirement_cause IS NOT NULL AND terminal_existed IS NOT NULL)
      ),
      CHECK (json_extract(body_json, '$.generation') = generation),
      CHECK (json_extract(body_json, '$.sequence') = sequence),
      CHECK (json_extract(body_json, '$.eventId') = event_id),
      CHECK (json_extract(body_json, '$.invocationId') = invocation_id),
      CHECK (json_extract(body_json, '$.observedAt') = observed_at),
      CHECK (json_extract(body_json, '$.eventKind') = event_kind),
      CHECK (
        (record_kind = 'selection' AND json_extract(body_json, '$.phase') = 'selection' AND
          encoded_bytes <= ${MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['routing-selected']}) OR
        (record_kind = 'terminal' AND json_extract(body_json, '$.phase') = 'terminal' AND
          ((event_kind = 'execution-failed' AND
            encoded_bytes <= ${MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['execution-failed']}) OR
           (event_kind = 'continuation-finalized' AND
            encoded_bytes <= ${MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['continuation-finalized']}))) OR
        (record_kind = 'retirement' AND json_extract(body_json, '$.phase') = 'retirement' AND
          json_extract(body_json, '$.selectionSequence') = selection_sequence AND
          json_extract(body_json, '$.retirementCause') = retirement_cause AND
          json_extract(body_json, '$.terminalExisted') = terminal_existed AND
          encoded_bytes <= ${MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES})
      )
    ) STRICT;

    CREATE TABLE handoff_routing_closing_reserve (
      invocation_id TEXT PRIMARY KEY CHECK (length(invocation_id) BETWEEN 1 AND ${MAX_IDENTIFIER_LENGTH}),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND ${MAX_IDENTIFIER_LENGTH}),
      observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 1 AND ${MAX_OBSERVED_AT_LENGTH}),
      allocation BLOB NOT NULL CHECK (length(allocation) = ${MAX_LEGAL_CLOSING_RECORD_BYTES})
    ) STRICT;

    CREATE UNIQUE INDEX handoff_routing_selection_or_retirement_per_invocation
      ON handoff_routing_records(invocation_id)
      WHERE record_kind IN ('selection', 'retirement');

    CREATE UNIQUE INDEX handoff_routing_terminal_or_retirement_per_invocation
      ON handoff_routing_records(invocation_id)
      WHERE record_kind IN ('terminal', 'retirement');

    CREATE UNIQUE INDEX handoff_routing_selection_or_unretained_terminal_per_invocation
      ON handoff_routing_records(invocation_id)
      WHERE record_kind = 'selection' OR (
        record_kind = 'terminal' AND (
          json_extract(body_json, '$.selection.kind') = 'without-selection' OR
          json_extract(body_json, '$.disposition.kind') IN (
            'terminal-without-retained-selection',
            'terminal-after-operator-resolution'
          )
        )
      );
  `;
}

function configureDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout=0');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=FULL');
  db.exec('PRAGMA foreign_keys=ON');
  const pageSize = Number((db.prepare('PRAGMA page_size').get() as Readonly<{ page_size: number }>).page_size);
  const maxPageCount = Math.floor(MAX_HANDOFF_ROUTING_STATUS_BYTES / pageSize);
  db.exec(`PRAGMA max_page_count=${maxPageCount}`);
}

function initializeOrValidateDatabase(db: DatabaseSync): void {
  const generation = db.prepare('PRAGMA user_version').get() as GenerationRow;
  if (generation.user_version === 0) {
    const existing = db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .get() as Readonly<{ count: number }>;
    if (existing.count !== 0) throw new UnsupportedGenerationError();
    db.exec(schemaSql());
    db.prepare(
      `INSERT INTO handoff_routing_metadata (
        singleton,
        generation,
        expired_identity_count,
        capacity_eviction_count,
        completed_pair_compaction_count,
        operator_resolved_count
      ) VALUES (1, ?, 0, 0, 0, 0)`,
    ).run(HANDOFF_ROUTING_STATUS_GENERATION);
    db.exec(`PRAGMA user_version=${HANDOFF_ROUTING_STATUS_GENERATION}`);
    return;
  }
  if (generation.user_version !== HANDOFF_ROUTING_STATUS_GENERATION) {
    throw new UnsupportedGenerationError();
  }
  try {
    const metadata = db.prepare('SELECT generation FROM handoff_routing_metadata WHERE singleton = 1').get() as
      | Readonly<{ generation: number }>
      | undefined;
    if (metadata?.generation !== HANDOFF_ROUTING_STATUS_GENERATION) throw new UnreadableStatusError();
  } catch (error) {
    if (error instanceof UnreadableStatusError) throw error;
    throw new UnreadableStatusError(errorNumber(error, SQLITE_CORRUPT));
  }
}

function nextRecordSequence(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'handoff_routing_records'), 0) + 1 AS next")
    .get() as Readonly<{ next: number }>;
  return row.next;
}

function insertRecord(
  db: DatabaseSync,
  recordKind: 'selection' | 'terminal' | 'retirement',
  event: HandoffRoutingJournalEvent | RetirementTombstone,
): number {
  const retirement = event.eventKind === 'retirement-tombstone' ? event : null;
  const selectionSequence =
    retirement?.selectionSequence ??
    (event.phase === 'terminal' && event.selection.kind === 'with-selection-sequence'
      ? event.selection.selectionSequence
      : null);
  const inserted = db
    .prepare(
      `INSERT INTO handoff_routing_records (
        generation,
        event_id,
        invocation_id,
        observed_at,
        record_kind,
        event_kind,
        selection_sequence,
        retirement_cause,
        terminal_existed,
        body_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING sequence`,
    )
    .get(
      event.generation,
      event.eventId,
      event.invocationId,
      event.observedAt,
      recordKind,
      event.eventKind,
      selectionSequence,
      retirement?.retirementCause ?? null,
      retirement === null ? null : Number(retirement.terminalExisted),
      JSON.stringify(event),
    ) as Readonly<{ sequence: number }> | undefined;
  if (inserted?.sequence !== event.sequence) throw new UnreadableStatusError();
  return inserted.sequence;
}

function parseRow<T>(row: StatusRow | undefined, schema: z.ZodType<T>): T | undefined {
  if (row === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(row.body_json));
  } catch {
    throw new UnreadableStatusError();
  }
}

function selectionForInvocation(db: DatabaseSync, invocationId: string): RoutingSelectedEvent | undefined {
  const row = db
    .prepare("SELECT body_json FROM handoff_routing_records WHERE invocation_id = ? AND record_kind = 'selection'")
    .get(invocationId) as StatusRow | undefined;
  return parseRow(row, routingSelectedEventSchema);
}

function terminalForInvocation(db: DatabaseSync, invocationId: string): HandoffRoutingTerminalEvent | undefined {
  const row = db
    .prepare("SELECT body_json FROM handoff_routing_records WHERE invocation_id = ? AND record_kind = 'terminal'")
    .get(invocationId) as StatusRow | undefined;
  return parseRow(row, terminalEventSchema);
}

function tombstoneForInvocation(db: DatabaseSync, invocationId: string): RetirementTombstone | undefined {
  const row = db
    .prepare("SELECT body_json FROM handoff_routing_records WHERE invocation_id = ? AND record_kind = 'retirement'")
    .get(invocationId) as StatusRow | undefined;
  return parseRow(row, retirementTombstoneSchema);
}

function insertSelection(db: DatabaseSync, transition: z.infer<typeof routingSelectedTransitionSchema>): number {
  const sequence = nextRecordSequence(db);
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
  const inserted = insertRecord(db, 'selection', event);
  db.prepare(
    `INSERT INTO handoff_routing_closing_reserve (invocation_id, event_id, observed_at, allocation)
    VALUES (?, ?, ?, zeroblob(?))`,
  ).run(event.invocationId, event.eventId, event.observedAt, MAX_LEGAL_CLOSING_RECORD_BYTES);
  return inserted;
}

function releaseClosingReserve(db: DatabaseSync, invocationId: string): void {
  const released = db.prepare('DELETE FROM handoff_routing_closing_reserve WHERE invocation_id = ?').run(invocationId);
  if (released.changes !== 1) throw new UnreadableStatusError();
}

function terminalGapDisposition(
  transition: z.infer<typeof terminalTransitionSchema>,
): Extract<StoredTerminalDisposition, { kind: 'failed-without-selection' | 'finalized-without-selection' }> {
  return transition.disposition.kind === 'execution-failed'
    ? { kind: 'failed-without-selection', throwPhase: transition.disposition.throwPhase }
    : { kind: 'finalized-without-selection', terminal: transition.disposition };
}

function insertTerminal(
  db: DatabaseSync,
  transition: z.infer<typeof terminalTransitionSchema>,
  disposition: StoredTerminalDisposition,
): number {
  const sequence = nextRecordSequence(db);
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
  return insertRecord(db, 'terminal', event);
}

function insertTombstone(
  db: DatabaseSync,
  selection: RoutingSelectedEvent,
  retirementCause: RetirementTombstone['retirementCause'],
  terminalExisted: boolean,
  observedAt: string,
  resolutionReason?: RetirementTombstone['resolutionReason'],
  eventId = `retirement-${randomUUID()}`,
): number {
  const sequence = nextRecordSequence(db);
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
  return insertRecord(db, 'retirement', tombstone);
}

function readRetirementHistory(db: DatabaseSync): RetirementHistoryTruncated {
  const row = db
    .prepare(
      `SELECT
        expired_identity_count,
        capacity_eviction_count,
        completed_pair_compaction_count,
        operator_resolved_count,
        min_selection_sequence,
        max_selection_sequence,
        earliest_selected_at,
        latest_selected_at
      FROM handoff_routing_metadata WHERE singleton = 1`,
    )
    .get() as
    | Readonly<{
        expired_identity_count: number;
        capacity_eviction_count: number;
        completed_pair_compaction_count: number;
        operator_resolved_count: number;
        min_selection_sequence: number | null;
        max_selection_sequence: number | null;
        earliest_selected_at: string | null;
        latest_selected_at: string | null;
      }>
    | undefined;
  if (row === undefined) throw new UnreadableStatusError();
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

function rollUpTombstone(db: DatabaseSync, tombstone: RetirementTombstone): void {
  const aggregate = readRetirementHistory(db);
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
  db.prepare(
    `UPDATE handoff_routing_metadata SET
      expired_identity_count = ?,
      capacity_eviction_count = ?,
      completed_pair_compaction_count = ?,
      operator_resolved_count = ?,
      min_selection_sequence = ?,
      max_selection_sequence = ?,
      earliest_selected_at = ?,
      latest_selected_at = ?
    WHERE singleton = 1`,
  ).run(
    next.expiredIdentityCount,
    next.causes['selection-evicted-at-capacity'],
    next.causes['completed-pair-compaction'],
    next.causes['operator-resolved'],
    next.minSelectionSequence,
    next.maxSelectionSequence,
    next.earliestSelectedAt,
    next.latestSelectedAt,
  );
  db.prepare('DELETE FROM handoff_routing_records WHERE sequence = ?').run(tombstone.sequence);
}

function enforceTombstoneBounds(db: DatabaseSync): void {
  while (true) {
    const bounds = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(encoded_bytes), 0) AS bytes
        FROM handoff_routing_records WHERE record_kind = 'retirement'`,
      )
      .get() as TombstoneBoundsRow;
    if (bounds.count <= MAX_RETIREMENT_TOMBSTONES && bounds.bytes <= MAX_RETIREMENT_TOMBSTONE_BYTES) return;
    const oldest = db
      .prepare(
        `SELECT body_json FROM handoff_routing_records
        WHERE record_kind = 'retirement'
        ORDER BY selection_sequence, invocation_id
        LIMIT 1`,
      )
      .get() as StatusRow | undefined;
    const tombstone = parseRow(oldest, retirementTombstoneSchema);
    if (tombstone === undefined) throw new UnreadableStatusError();
    rollUpTombstone(db, tombstone);
  }
}

function retireSelection(
  db: DatabaseSync,
  selection: RoutingSelectedEvent,
  cause: RetirementTombstone['retirementCause'],
  observedAt: string,
  terminalExisted: boolean,
  resolutionReason?: RetirementTombstone['resolutionReason'],
  eventId?: string,
): number {
  if (!terminalExisted) releaseClosingReserve(db, selection.invocationId);
  db.prepare('DELETE FROM handoff_routing_records WHERE invocation_id = ?').run(selection.invocationId);
  const sequence = insertTombstone(db, selection, cause, terminalExisted, observedAt, resolutionReason, eventId);
  enforceTombstoneBounds(db);
  return sequence;
}

function retireOldestCompletedPairForCapacity(db: DatabaseSync, observedAt: string): boolean {
  const row = db
    .prepare(
      `WITH latest_stable_pair AS (
        SELECT selection.sequence
        FROM handoff_routing_records AS selection
        JOIN handoff_routing_records AS terminal ON terminal.invocation_id = selection.invocation_id
        WHERE selection.record_kind = 'selection'
          AND terminal.record_kind = 'terminal'
          AND (selection.completed_pair_stable OR terminal.completed_pair_stable)
        ORDER BY selection.sequence DESC
        LIMIT 1
      )
      SELECT selection.body_json
      FROM handoff_routing_records AS selection
      JOIN handoff_routing_records AS terminal ON terminal.invocation_id = selection.invocation_id
      WHERE selection.record_kind = 'selection'
        AND terminal.record_kind = 'terminal'
        AND selection.sequence != COALESCE((SELECT sequence FROM latest_stable_pair), 0)
      ORDER BY selection.sequence
      LIMIT 1`,
    )
    .get() as StatusRow | undefined;
  const selection = parseRow(row, routingSelectedEventSchema);
  if (selection === undefined) return false;
  retireSelection(db, selection, 'completed-pair-compaction', observedAt, true);
  return true;
}

function rollUpOldestTombstone(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT body_json FROM handoff_routing_records
      WHERE record_kind = 'retirement'
      ORDER BY selection_sequence, invocation_id
      LIMIT 1`,
    )
    .get() as StatusRow | undefined;
  const tombstone = parseRow(row, retirementTombstoneSchema);
  if (tombstone === undefined) return false;
  rollUpTombstone(db, tombstone);
  return true;
}

function pragmaNumber(db: DatabaseSync, name: 'page_size' | 'page_count' | 'max_page_count'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
  const value = row[name];
  if (!Number.isSafeInteger(value) || value <= 0) throw new UnreadableStatusError();
  return value;
}

function hasAdmissionCapacity(db: DatabaseSync, recordBytes: number): boolean {
  const pageSize = pragmaNumber(db, 'page_size');
  const pageCount = pragmaNumber(db, 'page_count');
  const freeListCount = db.prepare('PRAGMA freelist_count').get() as Readonly<{ freelist_count: number }>;
  const maxPageCount = pragmaNumber(db, 'max_page_count');
  const availableBytes = (maxPageCount - pageCount + freeListCount.freelist_count) * pageSize;
  const maximumIdentifierBytes = Buffer.byteLength('\u0800'.repeat(MAX_IDENTIFIER_LENGTH), 'utf8');
  const indexedEnvelopeBytes = maximumIdentifierBytes * 4 + MAX_OBSERVED_AT_LENGTH * 2;
  const btreeAllocationMarginBytes = pageSize * 8;
  const requiredBytes = recordBytes + indexedEnvelopeBytes + btreeAllocationMarginBytes;
  return availableBytes >= requiredBytes;
}

function deleteOldestBoundedTerminal(db: DatabaseSync): boolean {
  const deleted = db
    .prepare(
      `DELETE FROM handoff_routing_records
      WHERE sequence = (
        SELECT terminal.sequence
        FROM handoff_routing_records AS terminal
        WHERE terminal.record_kind = 'terminal'
          AND NOT EXISTS (
            SELECT 1 FROM handoff_routing_records AS selection
            WHERE selection.invocation_id = terminal.invocation_id AND selection.record_kind = 'selection'
          )
        ORDER BY terminal.sequence
        LIMIT 1
      )`,
    )
    .run();
  return deleted.changes === 1;
}

function boundedTerminalCount(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
      FROM handoff_routing_records AS terminal
      WHERE terminal.record_kind = 'terminal'
        AND NOT EXISTS (
          SELECT 1 FROM handoff_routing_records AS selection
          WHERE selection.invocation_id = terminal.invocation_id AND selection.record_kind = 'selection'
        )`,
    )
    .get() as Readonly<{ count: number }>;
  return row.count;
}

function reclaimBoundedHistoryForAdmission(db: DatabaseSync, observedAt: string): boolean {
  if (deleteOldestBoundedTerminal(db)) return true;
  if (retireOldestCompletedPairForCapacity(db, observedAt)) return true;
  return rollUpOldestTombstone(db);
}

function makeClosingAdmissionRoom(db: DatabaseSync, observedAt: string, capacity: 'reserved' | 'unreserved'): void {
  if (capacity === 'reserved') return;
  while (boundedTerminalCount(db) >= MAX_BOUNDED_TERMINAL_HISTORY) deleteOldestBoundedTerminal(db);
  while (!hasAdmissionCapacity(db, MAX_LEGAL_CLOSING_RECORD_BYTES)) {
    if (reclaimBoundedHistoryForAdmission(db, observedAt)) continue;
    throw new CapacityExhaustedError();
  }
}

function makeSelectionAdmissionRoom(db: DatabaseSync, observedAt: string): void {
  while (unresolvedCount(db) >= MAX_UNRESOLVED_INVOCATIONS) evictOldestOpening(db, observedAt);
  const selectionAndReserveBytes =
    MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['routing-selected'] + MAX_LEGAL_CLOSING_RECORD_BYTES;
  while (!hasAdmissionCapacity(db, selectionAndReserveBytes)) {
    if (reclaimBoundedHistoryForAdmission(db, observedAt)) continue;
    if (unresolvedCount(db) > 0) {
      evictOldestOpening(db, observedAt);
      continue;
    }
    throw new CapacityExhaustedError();
  }
}

function compactExpiredCompletedPairs(db: DatabaseSync, observedAt: string): void {
  const cutoff = new Date(Date.parse(observedAt) - HANDOFF_ROUTING_COMPLETED_RETENTION_MS).toISOString();
  const selections = db
    .prepare(
      `WITH completed_pairs AS MATERIALIZED (
        SELECT
          selection.sequence,
          selection.observed_at,
          selection.body_json,
          selection.completed_pair_stable OR terminal.completed_pair_stable AS stable
        FROM handoff_routing_records AS selection
        JOIN handoff_routing_records AS terminal ON terminal.invocation_id = selection.invocation_id
        WHERE selection.record_kind = 'selection' AND terminal.record_kind = 'terminal'
      ),
      newest_pairs AS (
        SELECT sequence FROM completed_pairs
        ORDER BY sequence DESC
        LIMIT ?
      ),
      latest_stable_pair AS (
        SELECT sequence FROM completed_pairs
        WHERE stable
        ORDER BY sequence DESC
        LIMIT 1
      )
      SELECT body_json
      FROM completed_pairs
      WHERE sequence != COALESCE((SELECT sequence FROM latest_stable_pair), 0)
        AND (
          julianday(observed_at) < julianday(?) OR
          sequence NOT IN (SELECT sequence FROM newest_pairs)
        )
      ORDER BY sequence`,
    )
    .all(MAX_COMPLETED_HANDOFF_ROUTING_PAIRS, cutoff) as StatusRow[];
  for (const row of selections) {
    const selection = parseRow(row, routingSelectedEventSchema);
    if (selection === undefined) throw new UnreadableStatusError();
    retireSelection(db, selection, 'completed-pair-compaction', observedAt, true);
  }
}

function unresolvedCount(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
      FROM handoff_routing_records AS selection
      WHERE selection.record_kind = 'selection'
        AND NOT EXISTS (
          SELECT 1 FROM handoff_routing_records AS terminal
          WHERE terminal.invocation_id = selection.invocation_id AND terminal.record_kind = 'terminal'
        )`,
    )
    .get() as Readonly<{ count: number }>;
  return row.count;
}

function evictOldestOpening(db: DatabaseSync, observedAt: string): void {
  const row = db
    .prepare(
      `SELECT selection.body_json
      FROM handoff_routing_records AS selection
      WHERE selection.record_kind = 'selection'
        AND NOT EXISTS (
          SELECT 1 FROM handoff_routing_records AS terminal
          WHERE terminal.invocation_id = selection.invocation_id AND terminal.record_kind = 'terminal'
        )
      ORDER BY selection.sequence
      LIMIT 1`,
    )
    .get() as StatusRow | undefined;
  const selection = parseRow(row, routingSelectedEventSchema);
  if (selection === undefined) throw new RejectedTransitionError();
  retireSelection(db, selection, 'selection-evicted-at-capacity', observedAt, false);
}

function applySelection(db: DatabaseSync, transition: z.infer<typeof routingSelectedTransitionSchema>): number {
  if (
    selectionForInvocation(db, transition.invocationId) !== undefined ||
    terminalForInvocation(db, transition.invocationId) !== undefined ||
    tombstoneForInvocation(db, transition.invocationId) !== undefined
  ) {
    throw new RejectedTransitionError();
  }
  makeSelectionAdmissionRoom(db, transition.observedAt);
  return insertSelection(db, transition);
}

function applyTerminal(db: DatabaseSync, transition: z.infer<typeof terminalTransitionSchema>): number {
  if (terminalForInvocation(db, transition.invocationId) !== undefined) throw new RejectedTransitionError();
  if (transition.selection.kind === 'without-selection') {
    if (
      selectionForInvocation(db, transition.invocationId) !== undefined ||
      tombstoneForInvocation(db, transition.invocationId) !== undefined
    ) {
      throw new RejectedTransitionError();
    }
    makeClosingAdmissionRoom(db, transition.observedAt, 'unreserved');
    return insertTerminal(db, transition, terminalGapDisposition(transition));
  }

  const selection = selectionForInvocation(db, transition.invocationId);
  if (selection !== undefined) {
    if (selection.sequence !== transition.selection.selectionSequence) throw new RejectedTransitionError();
    releaseClosingReserve(db, selection.invocationId);
    makeClosingAdmissionRoom(db, transition.observedAt, 'reserved');
    return insertTerminal(db, transition, transition.disposition);
  }

  const tombstone = tombstoneForInvocation(db, transition.invocationId);
  if (tombstone === undefined || tombstone.selectionSequence !== transition.selection.selectionSequence) {
    makeClosingAdmissionRoom(db, transition.observedAt, 'unreserved');
    return insertTerminal(db, transition, {
      kind: 'terminal-without-retained-selection',
      knowledge: 'identity-expired-or-selection-unavailable',
      terminal: transition.disposition,
    });
  }
  if (tombstone.retirementCause === 'completed-pair-compaction' || tombstone.terminalExisted) {
    throw new RejectedTransitionError();
  }
  db.prepare('DELETE FROM handoff_routing_records WHERE sequence = ?').run(tombstone.sequence);
  makeClosingAdmissionRoom(db, transition.observedAt, 'unreserved');
  if (tombstone.retirementCause === 'operator-resolved') {
    if (tombstone.resolutionReason === undefined) throw new UnreadableStatusError();
    return insertTerminal(db, transition, {
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
    sequence: nextRecordSequence(db),
    eventId: transition.eventId,
    observedAt: transition.observedAt,
    terminalExisted: true,
  });
  const sequence = insertRecord(db, 'retirement', replacement);
  enforceTombstoneBounds(db);
  return sequence;
}

function applyResolution(db: DatabaseSync, transition: z.infer<typeof operatorResolvedTransitionSchema>): number {
  const selection = selectionForInvocation(db, transition.invocationId);
  if (selection === undefined || selection.sequence !== transition.selectionSequence) {
    throw new RejectedTransitionError();
  }
  if (terminalForInvocation(db, transition.invocationId) !== undefined) throw new RejectedTransitionError();
  releaseClosingReserve(db, selection.invocationId);
  db.prepare('DELETE FROM handoff_routing_records WHERE invocation_id = ?').run(selection.invocationId);
  makeClosingAdmissionRoom(db, transition.observedAt, 'reserved');
  const sequence = insertTombstone(
    db,
    selection,
    'operator-resolved',
    false,
    transition.observedAt,
    transition.reason,
    transition.eventId,
  );
  enforceTombstoneBounds(db);
  return sequence;
}

function applyTransition(db: DatabaseSync, transition: HandoffRoutingTransition): number {
  const duplicate = db.prepare('SELECT 1 FROM handoff_routing_records WHERE event_id = ?').get(transition.eventId);
  if (duplicate !== undefined) throw new RejectedTransitionError();
  switch (transition.kind) {
    case 'routing-selected':
      return applySelection(db, transition);
    case 'execution-failed':
    case 'continuation-finalized':
      return applyTerminal(db, transition);
    case 'operator-resolved':
      return applyResolution(db, transition);
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

function rollbackUncommittedPublication(
  db: DatabaseSync | undefined,
  transactionOpen: boolean,
  commitStarted: boolean,
): void {
  if (db === undefined || !transactionOpen || commitStarted) return;
  try {
    db.exec('ROLLBACK');
  } catch (rollbackError) {
    void rollbackError;
  }
}

function classifyPublicationError(error: unknown, commitStarted: boolean): PublicationOutcome {
  if (error instanceof RejectedTransitionError) {
    return { kind: 'not-published', cause: 'rejected-transition' };
  }
  if (error instanceof UnsupportedGenerationError) {
    return { kind: 'undeterminable', cause: 'unsupported-generation', errcode: SQLITE_ERROR };
  }
  if (error instanceof UnreadableStatusError) {
    return { kind: 'undeterminable', cause: 'unreadable', errcode: error.errcode };
  }
  const errcode = errorNumber(error, SQLITE_ERROR);
  const primaryErrcode = errcode & 0xff;
  if (primaryErrcode === SQLITE_FULL) return { kind: 'not-published', cause: 'capacity-exhausted' };
  if (primaryErrcode === SQLITE_BUSY && !commitStarted) return { kind: 'not-published', cause: 'contended' };
  if (primaryErrcode === SQLITE_NOTADB || primaryErrcode === SQLITE_CORRUPT) {
    return { kind: 'undeterminable', cause: 'unreadable', errcode };
  }
  return { kind: 'undeterminable', cause: 'io-failed', errcode };
}

function publishOnce(path: string, transitions: readonly HandoffRoutingTransition[]): PublicationOutcome {
  const parsed = z.array(handoffRoutingTransitionSchema).min(1).safeParse(transitions);
  if (!parsed.success) return { kind: 'not-published', cause: 'rejected-transition' };

  let db: DatabaseSync | undefined;
  let transactionOpen = false;
  let commitStarted = false;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    configureDatabase(db);
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    initializeOrValidateDatabase(db);

    const observedAt = transitionObservedAt(parsed.data);
    compactExpiredCompletedPairs(db, observedAt);
    let publishedSequence = 0;
    for (const transition of parsed.data) publishedSequence = applyTransition(db, transition);
    compactExpiredCompletedPairs(db, observedAt);
    commitStarted = true;
    db.exec('COMMIT');
    transactionOpen = false;
    return { kind: 'committed', sequence: publishedSequence };
  } catch (error) {
    rollbackUncommittedPublication(db, transactionOpen, commitStarted);
    return classifyPublicationError(error, commitStarted);
  } finally {
    if (db !== undefined) {
      try {
        db.close();
      } catch (closeError) {
        void closeError;
      }
    }
  }
}

export async function publishHandoffRoutingTransitions(
  time: Pick<TimePort, 'monotonicNow' | 'sleep'>,
  path: string,
  transitions: readonly HandoffRoutingTransition[],
  signal?: AbortSignal,
): Promise<PublicationOutcome> {
  const clock = createMonotonicClock(Symbol('handoff-routing-status-publication-contention'), {
    readMilliseconds: time.monotonicNow,
  });
  const deadline = clock.shiftMilliseconds(clock.now(), PUBLICATION_CONTENTION_TIMEOUT_MS);
  while (true) {
    const outcome = publishOnce(path, transitions);
    if (outcome.kind !== 'not-published' || outcome.cause !== 'contended') return outcome;
    if (signal?.aborted === true || clock.compare(clock.now(), deadline) >= 0) return outcome;
    try {
      await time.sleep(PUBLICATION_RETRY_DELAY_MS, signal === undefined ? undefined : { signal });
    } catch {
      return outcome;
    }
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
      statuses: readonly HandoffRoutingInvocationStatus[];
      retirementHistoryTruncated: RetirementHistoryTruncated;
    }>
  | Readonly<{ kind: 'unreadable'; reason: 'invalid-json' | 'invalid-shape' | 'too-large' }>
  | Readonly<{ kind: 'unsupported-generation'; generation: number }>
  | Readonly<{ kind: 'undeterminable'; cause: 'io-failed'; errcode: number }>;

export type HandoffRoutingOwnerLivenessProbe = (owner: RecordedProcessIdentity) => OwnerLiveness;

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
  | Extract<HandoffRoutingStatusReadResult, { kind: 'unreadable' | 'unsupported-generation' | 'undeterminable' }>;

type InvocationRecords = {
  selection?: RoutingSelectedEvent;
  terminal?: HandoffRoutingTerminalEvent;
  tombstone?: RetirementTombstone;
};

type StoredStatusRecord = RoutingSelectedEvent | HandoffRoutingTerminalEvent | RetirementTombstone;

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

  const parsed =
    row.record_kind === 'selection'
      ? routingSelectedEventSchema.safeParse(body)
      : row.record_kind === 'terminal'
        ? terminalEventSchema.safeParse(body)
        : retirementTombstoneSchema.safeParse(body);
  if (!parsed.success) return { kind: 'unreadable', reason: 'invalid-shape' };

  const record = parsed.data;
  if (
    row.encoded_bytes !== bodyBytes ||
    row.sequence !== record.sequence ||
    row.generation !== record.generation ||
    row.event_id !== record.eventId ||
    row.invocation_id !== record.invocationId ||
    row.observed_at !== record.observedAt ||
    row.event_kind !== record.eventKind
  ) {
    return { kind: 'unreadable', reason: 'invalid-shape' };
  }
  if (record.phase === 'selection') {
    if (row.selection_sequence !== null || row.retirement_cause !== null || row.terminal_existed !== null) {
      return { kind: 'unreadable', reason: 'invalid-shape' };
    }
  } else if (record.phase === 'terminal') {
    const selectionSequence =
      record.selection.kind === 'with-selection-sequence' ? record.selection.selectionSequence : null;
    if (
      row.selection_sequence !== selectionSequence ||
      row.retirement_cause !== null ||
      row.terminal_existed !== null
    ) {
      return { kind: 'unreadable', reason: 'invalid-shape' };
    }
  } else if (
    row.selection_sequence !== record.selectionSequence ||
    row.retirement_cause !== record.retirementCause ||
    row.terminal_existed !== Number(record.terminalExisted)
  ) {
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

function readStatusSnapshot(path: string): StatusSnapshotReadResult {
  let db: DatabaseSync | undefined;
  let transactionOpen = false;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=0');
    db.exec('BEGIN');
    transactionOpen = true;
    const generation = (db.prepare('PRAGMA user_version').get() as GenerationRow).user_version;
    if (generation !== HANDOFF_ROUTING_STATUS_GENERATION) {
      db.exec('COMMIT');
      transactionOpen = false;
      return { kind: 'unsupported-generation', generation };
    }
    const retirement = db
      .prepare(
        `SELECT
          generation,
          expired_identity_count,
          capacity_eviction_count,
          completed_pair_compaction_count,
          operator_resolved_count,
          min_selection_sequence,
          max_selection_sequence,
          earliest_selected_at,
          latest_selected_at
        FROM handoff_routing_metadata WHERE singleton = 1`,
      )
      .get() as RetirementHistoryRow | undefined;
    const rows = db
      .prepare(
        `SELECT
          sequence,
          generation,
          event_id,
          invocation_id,
          observed_at,
          record_kind,
          event_kind,
          selection_sequence,
          retirement_cause,
          terminal_existed,
          body_json,
          encoded_bytes
        FROM handoff_routing_records ORDER BY sequence`,
      )
      .all();
    const reserves = db
      .prepare(
        `SELECT
          invocation_id,
          event_id,
          observed_at,
          length(allocation) AS allocation_bytes
        FROM handoff_routing_closing_reserve ORDER BY invocation_id`,
      )
      .all();
    db.exec('COMMIT');
    transactionOpen = false;
    return { kind: 'snapshot', rows, reserves, retirement };
  } catch (error) {
    if (transactionOpen && db !== undefined) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        void rollbackError;
      }
    }
    return classifyStatusSnapshotError(error);
  } finally {
    if (db !== undefined) {
      try {
        db.close();
      } catch (closeError) {
        void closeError;
      }
    }
  }
}

export function readHandoffRoutingStatus(
  path: string,
  probe?: HandoffRoutingOwnerLivenessProbe,
): HandoffRoutingStatusReadResult {
  try {
    accessSync(path, fsConstants.R_OK);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'undeterminable', cause: 'io-failed', errcode: errorNumber(error, SQLITE_CANTOPEN) };
  }

  const snapshot = readStatusSnapshot(path);
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

const MAX_TEXT = '\u0800';
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
