import { describe, expect, it } from 'vitest';

import { formatHandoffRoutingStatus } from '#src/cli/format/backend.js';
import { formatHandoffPublicationFailureSuccessor } from '#src/cli/format/handoff-publication.js';
import {
  HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY,
  MAX_LEGAL_COMPACTABLE_CONTINUATION_FINALIZED_TRANSITION,
  handoffRoutingStatusExitContribution,
  handoffRoutingStatusStoreSchema,
  persistedHandoffDispositionPolicy,
  type HandoffRoutingStatusClassification,
  type HandoffRoutingStatusClassificationPolicy,
  type OwnerLiveness,
} from '#src/coordinator/handoff-routing/status.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const generation = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());
const emptyRetirementHistory = {
  kind: 'retirement-history-truncated',
  expiredIdentityCount: 0,
  causes: {
    'selection-evicted-at-capacity': 0,
    'completed-pair-compaction': 0,
    'operator-resolved': 0,
  },
  minSelectionSequence: null,
  maxSelectionSequence: null,
  earliestSelectedAt: null,
  latestSelectedAt: null,
} as const;

type PolicyFixture = Readonly<{
  classification: HandoffRoutingStatusClassification;
  expectedPolicy: HandoffRoutingStatusClassificationPolicy;
  rendered: string | null;
  publicationSuccessor: 'routing-status discard' | 'retry' | null;
}>;

const policyFixtures = [
  {
    classification: { kind: 'absent' },
    expectedPolicy: {
      statusExit: 0,
      publication: 'initialize',
      discard: 'refuse',
      resolve: 'stale',
      renderKey: 'no-journal',
      successorAction: 'none',
    },
    rendered: null,
    publicationSuccessor: null,
  },
  {
    classification: { kind: 'vacant' },
    expectedPolicy: {
      statusExit: 0,
      publication: 'initialize',
      discard: 'refuse',
      resolve: 'stale',
      renderKey: 'empty-file',
      successorAction: 'none',
    },
    rendered: 'Routing status journal is empty; this is consistent with interrupted creation or truncation.',
    publicationSuccessor: null,
  },
  {
    classification: { kind: 'uninitialized' },
    expectedPolicy: {
      statusExit: 0,
      publication: 'initialize',
      discard: 'refuse',
      resolve: 'stale',
      renderKey: 'initialization-incomplete',
      successorAction: 'none',
    },
    rendered: 'Routing status initialization is incomplete; the journal contains no application objects.',
    publicationSuccessor: null,
  },
  {
    classification: { kind: 'detached-wal' },
    expectedPolicy: {
      statusExit: 75,
      publication: 'refuse',
      discard: 'allow',
      resolve: 'status-unavailable',
      renderKey: 'detached-wal',
      successorAction: 'routing-status-discard',
    },
    rendered:
      'Routing status has a detached non-empty WAL beside an absent or empty main database.\nNext step: run coral-cli backend routing-status discard.',
    publicationSuccessor: 'routing-status discard',
  },
  {
    classification: { kind: 'generation-missing' },
    expectedPolicy: {
      statusExit: 75,
      publication: 'refuse',
      discard: 'allow',
      resolve: 'status-unavailable',
      renderKey: 'no-generation',
      successorAction: 'routing-status-discard',
    },
    rendered:
      'Routing status contains application objects but no generation address.\nNext step: run coral-cli backend routing-status discard.',
    publicationSuccessor: 'routing-status discard',
  },
  {
    classification: { kind: 'foreign-generation', generation: generation + 1 },
    expectedPolicy: {
      statusExit: 75,
      publication: 'refuse',
      discard: 'allow',
      resolve: 'status-unavailable',
      renderKey: 'other-generation',
      successorAction: 'routing-status-discard',
    },
    rendered: `Routing status generation ${generation + 1} belongs to another address.\nNext step: run coral-cli backend routing-status discard.`,
    publicationSuccessor: 'routing-status discard',
  },
  {
    classification: { kind: 'format-mismatch' },
    expectedPolicy: {
      statusExit: 75,
      publication: 'refuse',
      discard: 'allow',
      resolve: 'status-unavailable',
      renderKey: 'other-format',
      successorAction: 'routing-status-discard',
    },
    rendered:
      'Routing status has this generation address but a different durable format fingerprint.\nNext step: run coral-cli backend routing-status discard.',
    publicationSuccessor: 'routing-status discard',
  },
  {
    classification: { kind: 'schema-divergent' },
    expectedPolicy: {
      statusExit: 75,
      publication: 'refuse',
      discard: 'allow',
      resolve: 'status-unavailable',
      renderKey: 'divergent-schema',
      successorAction: 'routing-status-discard',
    },
    rendered:
      'Routing status has this generation address but a divergent schema.\nNext step: run coral-cli backend routing-status discard.',
    publicationSuccessor: 'routing-status discard',
  },
  {
    classification: {
      kind: 'current',
      generation,
      statuses: [],
      retirementHistoryTruncated: emptyRetirementHistory,
    },
    expectedPolicy: {
      statusExit: 'content-dependent',
      publication: 'mutate',
      discard: 'refuse',
      resolve: 'existing-domain-resolution',
      renderKey: 'content-dependent',
      successorAction: 'content-dependent',
    },
    rendered: null,
    publicationSuccessor: null,
  },
  {
    classification: { kind: 'unreadable', reason: 'invalid-shape' },
    expectedPolicy: {
      statusExit: 75,
      publication: 'refuse',
      discard: 'allow',
      resolve: 'status-unavailable',
      renderKey: 'damaged',
      successorAction: 'routing-status-discard',
    },
    rendered: 'Routing status is unreadable (invalid-shape).\nNext step: run coral-cli backend routing-status discard.',
    publicationSuccessor: 'routing-status discard',
  },
  {
    classification: { kind: 'undeterminable', cause: 'io-failed', errcode: 5 },
    expectedPolicy: {
      statusExit: 75,
      publication: 'refuse',
      discard: 'refuse',
      resolve: 'status-unavailable',
      renderKey: 'could-not-observe',
      successorAction: 'retry',
    },
    rendered:
      'Routing status could not be read (io-failed, errcode 5).\nNext step: retry coral-cli backend status without discarding. If this persists, repair the reported storage condition; discard is not permitted because this read did not establish a discardable classification.',
    publicationSuccessor: 'retry',
  },
] as const satisfies readonly PolicyFixture[];

describe('handoff routing status classification policy', () => {
  it('keeps the maximum compactable terminal in bounded history', () => {
    expect(
      persistedHandoffDispositionPolicy(MAX_LEGAL_COMPACTABLE_CONTINUATION_FINALIZED_TRANSITION.disposition),
    ).toEqual({
      durability: 'lifecycle-journal',
      retention: 'bounded-history',
      severity: 'warning',
      classification: 'history',
      exitContribution: 0,
    });
  });

  it('classifies an abandoned startup child as a warning hold', () => {
    expect(
      persistedHandoffDispositionPolicy({
        kind: 'delegated-startup-observation-aborted',
        version: '2.3.4',
        child: { pid: 4242, incarnation: testIncarnation('selected-backend') },
        childDisposition: 'left-running-and-unobserved',
      }),
    ).toEqual({
      durability: 'lifecycle-journal',
      retention: 'until-resolved',
      severity: 'warning',
      classification: 'hold',
      exitContribution: 75,
    });
  });

  it('holds until the unobserved child is proven absent', () => {
    const contribution = (childLiveness: OwnerLiveness): 0 | 75 =>
      handoffRoutingStatusExitContribution({
        kind: 'current',
        generation,
        statuses: [
          {
            kind: 'terminal',
            selection: {
              generation,
              sequence: 1,
              eventId: 'selection-event',
              invocationId: 'routing-invocation',
              observedAt: '2026-09-01T00:00:00.000Z',
              eventKind: 'routing-selected',
              phase: 'selection',
              owner: { pid: 4000, incarnation: testIncarnation('routing-owner') },
              disposition: { kind: 'continue-current', basis: { kind: 'incumbent-absent' } },
            },
            childLiveness,
            terminal: {
              generation,
              sequence: 2,
              eventId: 'terminal-event',
              invocationId: 'routing-invocation',
              observedAt: '2026-09-01T00:00:00.000Z',
              eventKind: 'continuation-finalized',
              phase: 'terminal',
              selection: { kind: 'with-selection-sequence', selectionSequence: 1 },
              disposition: {
                kind: 'delegated-startup-observation-aborted',
                version: '2.3.4',
                child: { pid: 4242, incarnation: testIncarnation('selected-backend') },
                childDisposition: 'left-running-and-unobserved',
              },
            },
          },
        ],
        retirementHistoryTruncated: emptyRetirementHistory,
      });

    expect([
      contribution({ kind: 'alive' }),
      contribution({ kind: 'unobservable', cause: 'probe-failed' }),
      contribution({ kind: 'absent' }),
    ]).toEqual([75, 75, 0]);
  });

  it('matches every independent policy fixture and no additional classification arm', () => {
    expect(Object.keys(HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY).sort()).toEqual(
      policyFixtures.map(({ classification }) => classification.kind).sort(),
    );
    for (const fixture of policyFixtures) {
      expect(HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY[fixture.classification.kind]).toEqual(fixture.expectedPolicy);
    }
  });

  it.each(policyFixtures)('renders $classification.kind and its successor independently', (fixture) => {
    const rendered = formatHandoffRoutingStatus(fixture.classification);
    expect(rendered).toBe(fixture.rendered);
    if (fixture.publicationSuccessor === null) {
      expect(rendered ?? '').not.toContain('Next step:');
      return;
    }
    const successor = formatHandoffPublicationFailureSuccessor({
      kind: 'resolution',
      invocationId: '123e4567-e89b-42d3-a456-426614174000',
      outcome: { kind: 'artifact-refused', classification: fixture.classification },
    });
    expect(successor).toContain(fixture.publicationSuccessor);
  });
});
