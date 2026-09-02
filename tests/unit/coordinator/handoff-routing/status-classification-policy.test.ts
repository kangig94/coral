import { describe, expect, it } from 'vitest';

import { formatHandoffRoutingStatus } from '#src/cli/format/backend.js';
import { formatHandoffPublicationFailureSuccessor } from '#src/cli/format/handoff-publication.js';
import {
  HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY,
  MAX_LEGAL_CLOSING_RECORD_BYTES,
  MAX_LEGAL_COMPACTABLE_CONTINUATION_FINALIZED_TRANSITION,
  MAX_LEGAL_DIRECT_HANDOFF_ROUTING_TERMINAL_BYTES,
  MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES,
  MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
  MAX_UNRESERVED_CLOSING_RECORD_BYTES,
  handoffRoutingStatusStoreSchema,
  persistedHandoffDispositionPolicy,
  type HandoffRoutingStatusClassification,
  type HandoffRoutingStatusClassificationPolicy,
} from '#src/coordinator/handoff-routing/status.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';

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

  it('reserves for the direct close and admits the wider wrapped close', () => {
    // The reserve a retained selection allocates is redeemed only by a direct terminal or a tombstone, so it
    // is fitted to those. Admission that redeems no reserve inserts the wrapped late terminals too, and
    // reserving their width would make the durable format's own bound wrong for what it names.
    expect(MAX_LEGAL_CLOSING_RECORD_BYTES).toBe(
      Math.max(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES, MAX_LEGAL_DIRECT_HANDOFF_ROUTING_TERMINAL_BYTES),
    );
    expect(MAX_UNRESERVED_CLOSING_RECORD_BYTES).toBe(
      Math.max(
        MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
        MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES['execution-failed'],
        MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES['continuation-finalized'],
      ),
    );
    expect(MAX_UNRESERVED_CLOSING_RECORD_BYTES).toBeGreaterThan(MAX_LEGAL_CLOSING_RECORD_BYTES);
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
