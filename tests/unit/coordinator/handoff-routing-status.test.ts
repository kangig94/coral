import { describe, expect, it } from 'vitest';

import {
  ABSENT_HANDOFF_RESULT_POLICY_PROJECTION,
  HANDOFF_CONTINUATION_REASON_POLICY_PROJECTIONS,
  HANDOFF_ROUTING_BASIS_POLICIES,
  HANDOFF_ROUTING_COMPLETED_RETENTION_MS,
  HANDOFF_ROUTING_STATUS_GENERATION,
  MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES,
  MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES,
  MAX_HANDOFF_ROUTING_JOURNAL_BYTES,
  MAX_LEGAL_CLOSING_REPLACEMENT_BYTES,
  MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
  MAX_RETIREMENT_TOMBSTONE_BYTES,
  MAX_RETIREMENT_TOMBSTONES,
  MAX_UNRESOLVED_INVOCATIONS,
  durableHandoffRoutingBasisSchema,
  emptyHandoffRoutingJournal,
  handoffRoutingJournalSchema,
  invalidTargetSummarySchema,
  persistedHandoffDispositionPolicy,
  reduceHandoffRoutingJournal,
  retirementTombstoneSchema,
  routingSelectedEventSchema,
  serializeHandoffRoutingJournal,
  type DurableHandoffRoutingBasis,
  type HandoffRoutingJournal,
  type HandoffRoutingReductionResult,
  type HandoffRoutingTransition,
} from '#src/coordinator/handoff-routing-status.js';
import { HANDOFF_ROUTING_BASIS_OBLIGATIONS } from '#src/coordinator/handoff-routing.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const BUILD_SET_ID = '123e4567-e89b-42d3-a456-426614174000';
const OWNER = { pid: 101, incarnation: testIncarnation(101) } as const;

function at(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

function eventId(index: number): string {
  return `event-${index}`;
}

function selection(
  invocationId: string,
  index: number,
  basis: DurableHandoffRoutingBasis = { kind: 'same-build-set', buildSetId: BUILD_SET_ID },
): HandoffRoutingTransition {
  return {
    kind: 'routing-selected',
    eventId: eventId(index),
    invocationId,
    observedAt: at(index),
    owner: OWNER,
    disposition: { kind: 'continue-current', basis },
  };
}

function terminal(invocationId: string, index: number, selectionSequence: number): HandoffRoutingTransition {
  return {
    kind: 'continuation-finalized',
    eventId: eventId(index),
    invocationId,
    observedAt: at(index),
    selection: { kind: 'with-selection-sequence', selectionSequence },
    disposition: {
      kind: 'continued-current',
      reason: { kind: 'routing', basis: { kind: 'same-build-set', buildSetId: BUILD_SET_ID } },
    },
  };
}

function accept(result: HandoffRoutingReductionResult): HandoffRoutingJournal {
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') throw new Error(`Expected acceptance, received ${result.reason}`);
  return result.journal;
}

function selectionSequence(journal: HandoffRoutingJournal, invocationId: string): number {
  const selected = journal.events.find(
    (event) => event.eventKind === 'routing-selected' && event.invocationId === invocationId,
  );
  if (selected === undefined) throw new Error(`Missing selection for ${invocationId}`);
  return selected.sequence;
}

function completePair(
  journal: HandoffRoutingJournal,
  invocationId: string,
  eventIndex: number,
  basis?: DurableHandoffRoutingBasis,
): HandoffRoutingJournal {
  const selected = accept(reduceHandoffRoutingJournal(journal, [selection(invocationId, eventIndex, basis)]));
  return accept(
    reduceHandoffRoutingJournal(selected, [
      terminal(invocationId, eventIndex + 1, selectionSequence(selected, invocationId)),
    ]),
  );
}

function denseJournalNearByteLimit(openingCount = 3): HandoffRoutingJournal {
  const gapEvents = Array.from({ length: 5_000 }, (_, index) => {
    const sequence = index + 1;
    return {
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      sequence,
      eventId: `gap-event-${sequence}`,
      invocationId: `gap-${sequence}`,
      observedAt: at(sequence),
      eventKind: 'execution-failed',
      phase: 'terminal',
      selection: { kind: 'without-selection' },
      disposition: { kind: 'failed-without-selection', throwPhase: 'child-spawn' },
    } as const;
  });
  const journalWithGapCount = (gapCount: number) => {
    const openings = Array.from({ length: openingCount }, (_, index) => {
      const sequence = gapCount + index + 1;
      return routingSelectedEventSchema.parse({
        generation: HANDOFF_ROUTING_STATUS_GENERATION,
        sequence,
        eventId: `opening-event-${index}`,
        invocationId: `opening-${index}`,
        observedAt: at(sequence),
        eventKind: 'routing-selected',
        phase: 'selection',
        owner: OWNER,
        disposition: { kind: 'continue-current', basis: { kind: 'same-build-set', buildSetId: BUILD_SET_ID } },
      });
    });
    return {
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      sequenceHighWater: gapCount + openings.length,
      events: [...gapEvents.slice(0, gapCount), ...openings],
      retirementTombstones: [],
      retirementHistoryTruncated: emptyHandoffRoutingJournal().retirementHistoryTruncated,
    };
  };

  let lower = 0;
  let upper = gapEvents.length;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    const bytes = Buffer.byteLength(JSON.stringify(journalWithGapCount(candidate)), 'utf8');
    if (bytes + openingCount * MAX_LEGAL_CLOSING_REPLACEMENT_BYTES <= MAX_HANDOFF_ROUTING_JOURNAL_BYTES) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }
  return handoffRoutingJournalSchema.parse(journalWithGapCount(lower));
}

describe('handoff routing status', () => {
  it('projects all three obligation sources without inventing persisted status for ephemeral bindings', () => {
    expect(Object.keys(HANDOFF_ROUTING_BASIS_POLICIES).sort()).toEqual(
      Object.keys(HANDOFF_ROUTING_BASIS_OBLIGATIONS).sort(),
    );
    expect(
      Object.values(HANDOFF_ROUTING_BASIS_POLICIES).every((policy) => policy.durability === 'lifecycle-journal'),
    ).toBe(true);
    expect(HANDOFF_CONTINUATION_REASON_POLICY_PROJECTIONS).toEqual({
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
    expect(ABSENT_HANDOFF_RESULT_POLICY_PROJECTION).toEqual({
      kind: 'ephemeral',
      policy: { durability: 'ephemeral', severity: 'info', exitContribution: 0 },
    });
  });

  it('persists bounded projections without paths, complete manifests, target handles, or raw errors', () => {
    const basis = durableHandoffRoutingBasisSchema.parse({
      kind: 'invalid-incumbent-target',
      evidence: {
        failure: 'adjacent-bundle-mismatch',
        expectedBuild: {
          version: '1.2.3',
          buildSetId: BUILD_SET_ID,
          bundleHash: 'a'.repeat(16),
          flavor: 'prod',
        },
      },
    });
    const encoded = JSON.stringify(basis);

    expect(encoded).not.toContain('bundleDir');
    expect(encoded).not.toContain('expectedManifest');
    expect(encoded).not.toContain('cliBundleHash');
    expect(encoded).not.toContain('storeFormatFingerprint');
    expect(
      invalidTargetSummarySchema.safeParse({ failure: 'bundle-dir-unavailable', bundleDir: '/tmp/x' }).success,
    ).toBe(false);
  });

  it('derives and enforces the exact tombstone item bound without truncation', () => {
    expect(Object.keys(MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES).sort()).toEqual([
      'continuation-finalized',
      'execution-failed',
      'routing-selected',
    ]);
    expect(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBeLessThanOrEqual(MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES);
    expect(MAX_RETIREMENT_TOMBSTONES * MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBeLessThanOrEqual(
      MAX_RETIREMENT_TOMBSTONE_BYTES,
    );
    expect(MAX_LEGAL_CLOSING_REPLACEMENT_BYTES).toBe(
      Math.max(
        MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['execution-failed'],
        MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES['continuation-finalized'],
        MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
      ),
    );
    expect(
      invalidTargetSummarySchema.safeParse({
        failure: 'adjacent-bundle-mismatch',
        expectedBuild: {
          version: `1.0.0-${'x'.repeat(65)}`,
          buildSetId: BUILD_SET_ID,
          bundleHash: 'a'.repeat(16),
          flavor: 'prod',
        },
      }).success,
    ).toBe(false);
    expect(
      reduceHandoffRoutingJournal(emptyHandoffRoutingJournal(), [selection('\u0800'.repeat(59), 1)]),
    ).toMatchObject({ kind: 'rejected', reason: 'invalid-transition' });
  });

  it('admits a selection at the unresolved count bound by retiring the oldest opening atomically', () => {
    const initial = Array.from({ length: MAX_UNRESOLVED_INVOCATIONS }, (_, index) =>
      selection(`invocation-${index}`, index + 1),
    );
    const full = accept(reduceHandoffRoutingJournal(emptyHandoffRoutingJournal(), initial));
    const admitted = accept(
      reduceHandoffRoutingJournal(full, [selection('invocation-new', MAX_UNRESOLVED_INVOCATIONS + 1)]),
    );

    expect(admitted.events.filter((event) => event.eventKind === 'routing-selected')).toHaveLength(
      MAX_UNRESOLVED_INVOCATIONS,
    );
    expect(admitted.events.some((event) => event.invocationId === 'invocation-0')).toBe(false);
    expect(admitted.retirementTombstones).toContainEqual(
      expect.objectContaining({
        invocationId: 'invocation-0',
        retirementCause: 'selection-evicted-at-capacity',
        terminalExisted: false,
      }),
    );
    expect(admitted.sequenceHighWater).toBe(full.sequenceHighWater + 2);
  });

  it('keeps encoded state plus every unresolved closing reserve within the byte bound', () => {
    const largeBasis: DurableHandoffRoutingBasis = {
      kind: 'invoking-build-not-older',
      comparison: 'newer-version',
      invoking: {
        version: `1.0.0-${'a'.repeat(50)}`,
        buildSetId: BUILD_SET_ID,
        bundleHash: 'a'.repeat(16),
        flavor: 'prod',
      },
      incumbent: {
        version: `2.0.0-${'b'.repeat(50)}`,
        buildSetId: '223e4567-e89b-42d3-a456-426614174000',
        bundleHash: 'b'.repeat(16),
        flavor: 'prod',
      },
    };
    const transitions = Array.from({ length: MAX_UNRESOLVED_INVOCATIONS }, (_, index) =>
      selection(`large-${index}`, index + 1, largeBasis),
    );
    const journal = accept(reduceHandoffRoutingJournal(emptyHandoffRoutingJournal(), transitions));
    const serialized = serializeHandoffRoutingJournal(journal);
    expect(serialized.kind).toBe('serialized');
    if (serialized.kind !== 'serialized') return;
    expect(serialized.bytes + MAX_UNRESOLVED_INVOCATIONS * MAX_LEGAL_CLOSING_REPLACEMENT_BYTES).toBeLessThanOrEqual(
      MAX_HANDOFF_ROUTING_JOURNAL_BYTES,
    );
  });

  it('allocates multiple byte-pressure eviction replacements before admitting a selection', () => {
    const full = denseJournalNearByteLimit();
    const before = JSON.stringify(full);
    const result = reduceHandoffRoutingJournal(full, [
      selection('\u0800'.repeat(58), full.sequenceHighWater + 1, {
        kind: 'invoking-build-not-older',
        comparison: 'newer-version',
        invoking: {
          version: `1.0.0-${'a'.repeat(58)}`,
          buildSetId: BUILD_SET_ID,
          bundleHash: 'a'.repeat(16),
          flavor: 'prod',
        },
        incumbent: {
          version: `2.0.0-${'b'.repeat(58)}`,
          buildSetId: '223e4567-e89b-42d3-a456-426614174000',
          bundleHash: 'b'.repeat(16),
          flavor: 'prod',
        },
      }),
    ]);
    const admitted = accept(result);
    const admittedSelection = admitted.events.find(
      (event) => event.eventKind === 'routing-selected' && event.invocationId === '\u0800'.repeat(58),
    );
    const evictions = admitted.retirementTombstones.filter(
      (tombstone) => tombstone.retirementCause === 'selection-evicted-at-capacity',
    );
    const evictionCount =
      evictions.length + admitted.retirementHistoryTruncated.causes['selection-evicted-at-capacity'];

    expect(evictionCount).toBeGreaterThan(1);
    expect(admittedSelection).toBeDefined();
    expect(evictions.every((tombstone) => tombstone.sequence < (admittedSelection?.sequence ?? 0))).toBe(true);
    expect(result.kind === 'accepted' ? result.committedSequences : []).toEqual(
      Array.from(
        { length: admitted.sequenceHighWater - full.sequenceHighWater },
        (_, index) => full.sequenceHighWater + index + 1,
      ),
    );
    expect(JSON.stringify(full)).toBe(before);
  });

  it('retires an old selection when its terminal arrives out of order beyond the completed window', () => {
    let journal = accept(
      reduceHandoffRoutingJournal(emptyHandoffRoutingJournal(), [
        selection('old', 1, { kind: 'incumbent-unresolved', cause: 'health-request-failed' }),
      ]),
    );
    journal = accept(
      reduceHandoffRoutingJournal(
        journal,
        Array.from({ length: 256 }, (_, index) => {
          const sequence = 2 + index * 2;
          return [
            selection(`new-${index}`, sequence, { kind: 'incumbent-unresolved', cause: 'health-request-failed' }),
            terminal(`new-${index}`, sequence + 1, sequence),
          ];
        }).flat(),
      ),
    );
    journal = accept(reduceHandoffRoutingJournal(journal, [terminal('old', 600, selectionSequence(journal, 'old'))]));

    expect(journal.events.some((event) => event.invocationId === 'old')).toBe(false);
    expect(journal.retirementTombstones).toContainEqual(
      expect.objectContaining({ invocationId: 'old', retirementCause: 'completed-pair-compaction' }),
    );
  });

  it('rolls expired exact capacity identity into the cumulative aggregate', () => {
    let journal = accept(
      reduceHandoffRoutingJournal(
        emptyHandoffRoutingJournal(),
        Array.from({ length: MAX_UNRESOLVED_INVOCATIONS }, (_, index) => selection(`opening-${index}`, index + 1)),
      ),
    );
    for (let index = 0; index <= MAX_RETIREMENT_TOMBSTONES; index += 1) {
      journal = accept(
        reduceHandoffRoutingJournal(journal, [
          selection(`replacement-${index}`, MAX_UNRESOLVED_INVOCATIONS + index + 1),
        ]),
      );
    }

    expect(journal.retirementTombstones.length).toBeLessThanOrEqual(MAX_RETIREMENT_TOMBSTONES);
    expect(journal.retirementHistoryTruncated.expiredIdentityCount).toBeGreaterThan(0);
    expect(journal.retirementHistoryTruncated.causes['selection-evicted-at-capacity']).toBe(
      journal.retirementHistoryTruncated.expiredIdentityCount,
    );
    expect(journal.retirementHistoryTruncated.minSelectionSequence).not.toBeNull();
    expect(journal.retirementHistoryTruncated.maxSelectionSequence).not.toBeNull();

    const late = accept(reduceHandoffRoutingJournal(journal, [terminal('opening-0', 400, 1)]));
    expect(late.events.at(-1)).toMatchObject({
      invocationId: 'opening-0',
      disposition: { kind: 'terminal-without-retained-selection' },
    });
  });

  it('rolls up a newly created tombstone immediately when it is the oldest identity beyond the exact window', () => {
    const opening = routingSelectedEventSchema.parse({
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      sequence: 1,
      eventId: 'opening-event',
      invocationId: 'opening',
      observedAt: at(1),
      eventKind: 'routing-selected',
      phase: 'selection',
      owner: OWNER,
      disposition: { kind: 'continue-current', basis: { kind: 'same-build-set', buildSetId: BUILD_SET_ID } },
    });
    const retirementTombstones = Array.from({ length: MAX_RETIREMENT_TOMBSTONES }, (_, index) => {
      const sequence = index + 2;
      return retirementTombstoneSchema.parse({
        generation: HANDOFF_ROUTING_STATUS_GENERATION,
        sequence,
        eventId: `retirement-${index}`,
        invocationId: `retired-${index}`,
        observedAt: at(sequence),
        eventKind: 'retirement-tombstone',
        phase: 'retirement',
        selectionSequence: sequence,
        selectedAt: at(sequence),
        owner: OWNER,
        selectedDisposition: { kind: 'continue-current', basis: { kind: 'same-build-set', buildSetId: BUILD_SET_ID } },
        retirementCause: 'selection-evicted-at-capacity',
        terminalExisted: false,
      });
    });
    const journal = handoffRoutingJournalSchema.parse({
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      sequenceHighWater: MAX_RETIREMENT_TOMBSTONES + 1,
      events: [opening],
      retirementTombstones,
      retirementHistoryTruncated: emptyHandoffRoutingJournal().retirementHistoryTruncated,
    });
    const resolved = accept(
      reduceHandoffRoutingJournal(journal, [
        {
          kind: 'operator-resolved',
          eventId: 'resolve-opening',
          invocationId: 'opening',
          observedAt: at(500),
          selectionSequence: opening.sequence,
          reason: 'owner-absent',
        },
      ]),
    );

    expect(resolved.retirementTombstones).toHaveLength(MAX_RETIREMENT_TOMBSTONES);
    expect(resolved.retirementTombstones.some((tombstone) => tombstone.invocationId === 'opening')).toBe(false);
    expect(resolved.retirementHistoryTruncated).toMatchObject({
      expiredIdentityCount: 1,
      causes: { 'operator-resolved': 1 },
      minSelectionSequence: opening.sequence,
      maxSelectionSequence: opening.sequence,
    });
  });

  it('retains capacity-eviction identity for a late terminal and rejects the next duplicate', () => {
    const full = accept(
      reduceHandoffRoutingJournal(
        emptyHandoffRoutingJournal(),
        Array.from({ length: MAX_UNRESOLVED_INVOCATIONS }, (_, index) => selection(`opening-${index}`, index + 1)),
      ),
    );
    const retired = accept(
      reduceHandoffRoutingJournal(full, [selection('replacement', MAX_UNRESOLVED_INVOCATIONS + 1)]),
    );
    const late = accept(reduceHandoffRoutingJournal(retired, [terminal('opening-0', 200, 1)]));

    expect(late.retirementTombstones).toContainEqual(
      expect.objectContaining({
        invocationId: 'opening-0',
        retirementCause: 'selection-evicted-at-capacity',
        terminalExisted: true,
      }),
    );
    expect(reduceHandoffRoutingJournal(late, [terminal('opening-0', 201, 1)])).toMatchObject({
      kind: 'rejected',
      reason: 'duplicate-terminal',
    });
  });

  it('rejects a duplicate terminal after completed-pair compaction', () => {
    const completed = completePair(emptyHandoffRoutingJournal(), 'completed', 1, {
      kind: 'incumbent-unresolved',
      cause: 'health-request-failed',
    });
    const compacted = accept(
      reduceHandoffRoutingJournal(completed, [selection('current', HANDOFF_ROUTING_COMPLETED_RETENTION_MS + 10)]),
    );

    expect(compacted.retirementTombstones).toContainEqual(
      expect.objectContaining({
        invocationId: 'completed',
        retirementCause: 'completed-pair-compaction',
        terminalExisted: true,
      }),
    );
    expect(reduceHandoffRoutingJournal(compacted, [terminal('completed', 500, 1)])).toMatchObject({
      kind: 'rejected',
      reason: 'duplicate-terminal',
    });
  });

  it('implements the legal and rejected transition table', () => {
    const empty = emptyHandoffRoutingJournal();
    expect(reduceHandoffRoutingJournal(empty, [])).toMatchObject({ kind: 'rejected', reason: 'empty-transaction' });
    expect(
      reduceHandoffRoutingJournal({ ...empty, sequenceHighWater: -1 } as HandoffRoutingJournal, [selection('x', 1)]),
    ).toMatchObject({ kind: 'rejected', reason: 'invalid-journal' });
    expect(
      reduceHandoffRoutingJournal(empty, [
        {
          ...terminal('invalid', 1, 1),
          selection: { kind: 'with-selection-sequence' },
        } as HandoffRoutingTransition,
      ]),
    ).toMatchObject({ kind: 'rejected', reason: 'invalid-transition' });

    const selected = accept(reduceHandoffRoutingJournal(empty, [selection('active', 1)]));
    expect(reduceHandoffRoutingJournal(selected, [{ ...selection('other', 2), eventId: eventId(1) }])).toMatchObject({
      kind: 'rejected',
      reason: 'duplicate-event-id',
    });
    expect(reduceHandoffRoutingJournal(selected, [selection('active', 2)])).toMatchObject({
      kind: 'rejected',
      reason: 'duplicate-selection',
    });
    expect(reduceHandoffRoutingJournal(selected, [terminal('active', 3, 999)])).toMatchObject({
      kind: 'rejected',
      reason: 'selection-sequence-mismatch',
    });

    const completed = accept(
      reduceHandoffRoutingJournal(selected, [terminal('active', 4, selectionSequence(selected, 'active'))]),
    );
    expect(
      reduceHandoffRoutingJournal(completed, [terminal('active', 5, selectionSequence(selected, 'active'))]),
    ).toMatchObject({ kind: 'rejected', reason: 'duplicate-terminal' });
    expect(
      reduceHandoffRoutingJournal(completed, [
        {
          kind: 'operator-resolved',
          eventId: eventId(6),
          invocationId: 'active',
          observedAt: at(6),
          selectionSequence: 1,
          reason: 'owner-absent',
        },
      ]),
    ).toMatchObject({ kind: 'rejected', reason: 'resolution-after-terminal' });
    expect(
      reduceHandoffRoutingJournal(empty, [
        {
          kind: 'operator-resolved',
          eventId: eventId(7),
          invocationId: 'missing',
          observedAt: at(7),
          selectionSequence: 1,
          reason: 'owner-absent',
        },
      ]),
    ).toMatchObject({ kind: 'rejected', reason: 'resolution-without-opening' });

    const gap = accept(
      reduceHandoffRoutingJournal(empty, [
        {
          kind: 'execution-failed',
          eventId: eventId(8),
          invocationId: 'gap',
          observedAt: at(8),
          selection: { kind: 'without-selection' },
          disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
        },
      ]),
    );
    expect(gap.events[0]).toMatchObject({ disposition: { kind: 'failed-without-selection' } });

    const opening = accept(reduceHandoffRoutingJournal(empty, [selection('resolved', 9)]));
    const resolved = accept(
      reduceHandoffRoutingJournal(opening, [
        {
          kind: 'operator-resolved',
          eventId: eventId(10),
          invocationId: 'resolved',
          observedAt: at(10),
          selectionSequence: selectionSequence(opening, 'resolved'),
          reason: 'operator-abandoned-unobservable',
        },
      ]),
    );
    expect(resolved.retirementTombstones[0]).toMatchObject({ retirementCause: 'operator-resolved' });
    const late = accept(
      reduceHandoffRoutingJournal(resolved, [
        terminal('resolved', 11, resolved.retirementTombstones[0].selectionSequence),
      ]),
    );
    expect(late.retirementTombstones).toHaveLength(0);
    expect(late.events[0]).toMatchObject({
      disposition: {
        kind: 'terminal-after-operator-resolution',
        resolutionReason: 'operator-abandoned-unobservable',
      },
    });

    const saturated = denseJournalNearByteLimit(0);
    const capacity = reduceHandoffRoutingJournal(saturated, [
      {
        kind: 'execution-failed',
        eventId: 'capacity-terminal',
        invocationId: 'capacity-gap',
        observedAt: at(saturated.sequenceHighWater + 1),
        selection: { kind: 'without-selection' },
        disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
      },
    ]);
    expect(capacity).toMatchObject({ kind: 'rejected', reason: 'journal-capacity-exceeded', journal: saturated });
  });

  it('keeps the non-compactable sequence high-water after age compaction', () => {
    let journal = completePair(emptyHandoffRoutingJournal(), 'old', 1, {
      kind: 'incumbent-unresolved',
      cause: 'unreadable-record',
    });
    const highWater = journal.sequenceHighWater;
    journal = accept(
      reduceHandoffRoutingJournal(journal, [selection('new', HANDOFF_ROUTING_COMPLETED_RETENTION_MS + 10)]),
    );

    expect(journal.sequenceHighWater).toBeGreaterThan(highWater);
    expect(handoffRoutingJournalSchema.parse(journal).sequenceHighWater).toBe(journal.sequenceHighWater);
  });

  it('keeps unresolved selection pins and the latest stable pair across age compaction', () => {
    let journal = accept(reduceHandoffRoutingJournal(emptyHandoffRoutingJournal(), [selection('unresolved', 1)]));
    journal = completePair(journal, 'stable', 2);
    journal = completePair(journal, 'unstable', 4, {
      kind: 'incumbent-unresolved',
      cause: 'unreadable-record',
    });
    journal = accept(
      reduceHandoffRoutingJournal(journal, [selection('current', HANDOFF_ROUTING_COMPLETED_RETENTION_MS + 10)]),
    );

    expect(journal.events.some((event) => event.invocationId === 'unresolved')).toBe(true);
    expect(journal.events.some((event) => event.invocationId === 'stable')).toBe(true);
    expect(journal.events.some((event) => event.invocationId === 'unstable')).toBe(false);
    expect(journal.retirementTombstones).toContainEqual(
      expect.objectContaining({ invocationId: 'unstable', retirementCause: 'completed-pair-compaction' }),
    );
  });

  it('assigns total policy to repair, gap, rollup, and lifecycle dispositions', () => {
    expect(
      persistedHandoffDispositionPolicy({ kind: 'selection-evicted-at-capacity', terminalExisted: false }),
    ).toEqual({
      durability: 'lifecycle-journal',
      retention: 'bounded-history',
      severity: 'warning',
      exitContribution: 75,
    });
    expect(
      persistedHandoffDispositionPolicy({
        kind: 'retirement-history-truncated',
        expiredIdentityCount: 1,
        causes: {
          'selection-evicted-at-capacity': 0,
          'completed-pair-compaction': 1,
          'operator-resolved': 0,
        },
        minSelectionSequence: 1,
        maxSelectionSequence: 1,
        earliestSelectedAt: at(1),
        latestSelectedAt: at(1),
      }),
    ).toMatchObject({ severity: 'warning', exitContribution: 0 });
  });
});
