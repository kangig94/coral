import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ABSENT_HANDOFF_RESULT_POLICY_PROJECTION,
  HANDOFF_CONTINUATION_REASON_POLICY_PROJECTIONS,
  HANDOFF_ROUTING_BASIS_POLICIES,
  HANDOFF_ROUTING_COMPLETED_RETENTION_MS,
  HANDOFF_ROUTING_STATUS_GENERATION,
  MAX_COMPLETED_HANDOFF_ROUTING_PAIRS,
  MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES,
  MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES,
  MAX_HANDOFF_ROUTING_STATUS_BYTES,
  MAX_LEGAL_CLOSING_RECORD_BYTES,
  MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
  MAX_RETIREMENT_TOMBSTONE_BYTES,
  MAX_RETIREMENT_TOMBSTONES,
  MAX_UNRESOLVED_INVOCATIONS,
  durableHandoffRoutingBasisSchema,
  invalidTargetSummarySchema,
  persistedHandoffDispositionPolicy,
  publishHandoffRoutingTransitions,
  retirementTombstoneSchema,
  type DurableHandoffRoutingBasis,
  type HandoffRoutingTransition,
  type PublicationOutcome,
  type RetirementTombstone,
} from '#src/coordinator/handoff-routing-status.js';
import { HANDOFF_ROUTING_BASIS_OBLIGATIONS } from '#src/coordinator/handoff-routing.js';
import { createRealTimePort } from '#src/infra/time.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const BUILD_SET_ID = '123e4567-e89b-42d3-a456-426614174000';
const OWNER = { pid: 101, incarnation: testIncarnation(101) } as const;
const temporaryDirectories: string[] = [];
const time = createRealTimePort();

function at(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-'));
  temporaryDirectories.push(directory);
  return join(directory, 'handoff-routing.1.db');
}

function selection(
  invocationId: string,
  index: number,
  basis: DurableHandoffRoutingBasis = { kind: 'same-build-set', buildSetId: BUILD_SET_ID },
): HandoffRoutingTransition {
  return {
    kind: 'routing-selected',
    eventId: `event-${index}`,
    invocationId,
    observedAt: at(index),
    owner: OWNER,
    disposition: { kind: 'continue-current', basis },
  };
}

function terminal(invocationId: string, index: number, selectionSequence: number): HandoffRoutingTransition {
  return {
    kind: 'continuation-finalized',
    eventId: `event-${index}`,
    invocationId,
    observedAt: at(index),
    selection: { kind: 'with-selection-sequence', selectionSequence },
    disposition: {
      kind: 'continued-current',
      reason: { kind: 'routing', basis: { kind: 'same-build-set', buildSetId: BUILD_SET_ID } },
    },
  };
}

async function committed(
  path: string,
  transitions: readonly HandoffRoutingTransition[],
): Promise<Extract<PublicationOutcome, { kind: 'committed' }>> {
  const outcome = await publish(path, transitions);
  expect(outcome.kind).toBe('committed');
  if (outcome.kind !== 'committed') throw new Error(`Expected a commit, received ${outcome.kind}`);
  return outcome;
}

function publish(
  path: string,
  transitions: readonly HandoffRoutingTransition[],
  signal?: AbortSignal,
): Promise<PublicationOutcome> {
  return publishHandoffRoutingTransitions(time, path, transitions, signal);
}

function records(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path);
  try {
    return (
      db.prepare('SELECT body_json FROM handoff_routing_records ORDER BY sequence').all() as Array<{
        body_json: string;
      }>
    ).map((row) => JSON.parse(row.body_json) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

function metadata(path: string): Record<string, number | string | null> {
  const db = new DatabaseSync(path);
  try {
    return db.prepare('SELECT * FROM handoff_routing_metadata WHERE singleton = 1').get() as Record<
      string,
      number | string | null
    >;
  } finally {
    db.close();
  }
}

function insertTombstoneFixture(db: DatabaseSync, tombstone: RetirementTombstone): void {
  db.prepare(
    `INSERT INTO handoff_routing_records (
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
      body_json
    ) VALUES (?, ?, ?, ?, ?, 'retirement', 'retirement-tombstone', ?, ?, ?, ?)`,
  ).run(
    tombstone.sequence,
    tombstone.generation,
    tombstone.eventId,
    tombstone.invocationId,
    tombstone.observedAt,
    tombstone.selectionSequence,
    tombstone.retirementCause,
    Number(tombstone.terminalExisted),
    JSON.stringify(tombstone),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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

  it('keeps bounded projections and derives per-row encoded limits from maximum legal fixtures', () => {
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

    expect(JSON.stringify(basis)).not.toMatch(/bundleDir|expectedManifest|cliBundleHash|storeFormatFingerprint/);
    expect(
      invalidTargetSummarySchema.safeParse({ failure: 'bundle-dir-unavailable', bundleDir: '/tmp/x' }).success,
    ).toBe(false);
    expect(Object.keys(MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES).sort()).toEqual([
      'continuation-finalized',
      'execution-failed',
      'routing-selected',
    ]);
    expect(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBeLessThanOrEqual(MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES);
    expect(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBeLessThanOrEqual(MAX_LEGAL_CLOSING_RECORD_BYTES);
    expect(MAX_RETIREMENT_TOMBSTONES * MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBeLessThanOrEqual(
      MAX_RETIREMENT_TOMBSTONE_BYTES,
    );
  });

  it('creates the bounded schema with nonblocking immediate-write pragmas and relational uniqueness', async () => {
    const path = databasePath();
    await committed(path, [selection('active', 1)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: HANDOFF_ROUTING_STATUS_GENERATION });
      expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 });
      expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      const objects = db
        .prepare(
          `SELECT name FROM sqlite_master
          WHERE name LIKE 'handoff_routing_%'
          ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      expect(objects.map((row) => row.name)).toEqual([
        'handoff_routing_closing_reserve',
        'handoff_routing_gap_terminal_or_selection_per_invocation',
        'handoff_routing_metadata',
        'handoff_routing_records',
        'handoff_routing_selection_or_retirement_per_invocation',
        'handoff_routing_terminal_or_retirement_per_invocation',
      ]);
      expect(
        db
          .prepare(
            `SELECT invocation_id, length(allocation) AS bytes
          FROM handoff_routing_closing_reserve`,
          )
          .all(),
      ).toEqual([{ invocation_id: 'active', bytes: MAX_LEGAL_CLOSING_RECORD_BYTES }]);

      const active = records(path)[0];
      const forgedRetirement = retirementTombstoneSchema.parse({
        generation: HANDOFF_ROUTING_STATUS_GENERATION,
        sequence: 2,
        eventId: 'retirement-for-active',
        invocationId: 'active',
        observedAt: at(2),
        eventKind: 'retirement-tombstone',
        phase: 'retirement',
        selectionSequence: active.sequence,
        selectedAt: active.observedAt,
        owner: OWNER,
        selectedDisposition: active.disposition,
        retirementCause: 'selection-evicted-at-capacity',
        terminalExisted: false,
      });
      expect(() => insertTombstoneFixture(db, forgedRetirement)).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects invalid batches before creating their durable address', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-invalid-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'absent', 'nested');
    const path = join(directory, 'handoff-routing.1.db');

    await expect(publish(path, [])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    expect(existsSync(directory)).toBe(false);
  });

  it('keeps the event loop responsive while a writer holds the database', async () => {
    const path = databasePath();
    await committed(path, [selection('holder-seed', 1)]);
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN IMMEDIATE');
    let publication: Promise<PublicationOutcome>;
    try {
      const eventLoopTick = new Promise<'event-loop-tick'>((resolve) => {
        setTimeout(() => resolve('event-loop-tick'), 0);
      });
      publication = publish(path, [selection('contended', 2)]);

      await expect(
        Promise.race([eventLoopTick, publication.then(() => 'publication-finished' as const)]),
      ).resolves.toBe('event-loop-tick');
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    await expect(publication).resolves.toMatchObject({ kind: 'committed' });
  });

  it('publishes all transition statements atomically and rejects every illegal transition row', async () => {
    const path = databasePath();
    await expect(publish(path, [])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    await expect(
      publish(path, [{ ...selection('invalid', 1), invocationId: '' } as HandoffRoutingTransition]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'rejected-transition' });

    const selected = await committed(path, [selection('active', 2)]);
    await expect(publish(path, [{ ...selection('other', 3), eventId: 'event-2' }])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    await expect(publish(path, [selection('active', 4)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    await expect(publish(path, [terminal('active', 5, 999)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });

    await committed(path, [terminal('active', 6, selected.sequence)]);
    await expect(publish(path, [terminal('active', 7, selected.sequence)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    await expect(
      publish(path, [
        {
          kind: 'operator-resolved',
          eventId: 'event-8',
          invocationId: 'active',
          observedAt: at(8),
          selectionSequence: selected.sequence,
          reason: 'owner-absent',
        },
      ]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'rejected-transition' });
    await expect(
      publish(path, [
        {
          kind: 'operator-resolved',
          eventId: 'event-9',
          invocationId: 'missing',
          observedAt: at(9),
          selectionSequence: 1,
          reason: 'owner-absent',
        },
      ]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'rejected-transition' });

    const before = records(path);
    await expect(publish(path, [selection('rolled-back', 10), selection('active', 11)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    expect(records(path)).toEqual(before);

    await committed(path, [
      {
        kind: 'execution-failed',
        eventId: 'event-12',
        invocationId: 'gap',
        observedAt: at(12),
        selection: { kind: 'without-selection' },
        disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
      },
    ]);
    expect(records(path).find((event) => event.invocationId === 'gap')).toMatchObject({
      disposition: { kind: 'failed-without-selection' },
    });
  });

  it('rejects a recording-gap terminal and selection for the same invocation in either order', async () => {
    const selectedFirstPath = databasePath();
    await committed(selectedFirstPath, [selection('same', 1)]);
    await expect(
      publish(selectedFirstPath, [
        {
          kind: 'execution-failed',
          eventId: 'gap-after-selection',
          invocationId: 'same',
          observedAt: at(2),
          selection: { kind: 'without-selection' },
          disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
        },
      ]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'rejected-transition' });
    expect(records(selectedFirstPath).filter((event) => event.invocationId === 'same')).toHaveLength(1);

    const gapFirstPath = databasePath();
    await committed(gapFirstPath, [
      {
        kind: 'execution-failed',
        eventId: 'gap-before-selection',
        invocationId: 'same',
        observedAt: at(3),
        selection: { kind: 'without-selection' },
        disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
      },
    ]);
    await expect(publish(gapFirstPath, [selection('same', 4)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    expect(records(gapFirstPath).filter((event) => event.invocationId === 'same')).toHaveLength(1);
  });

  it('admits a multi-eviction selection batch and keeps engine-allocated sequences ordered', async () => {
    const path = databasePath();
    const transitions = Array.from({ length: MAX_UNRESOLVED_INVOCATIONS + 3 }, (_, index) =>
      selection(`invocation-${index}`, index + 1),
    );
    await committed(path, transitions);
    const retained = records(path);
    const selections = retained.filter((event) => event.eventKind === 'routing-selected');
    const tombstones = retained.filter((event) => event.eventKind === 'retirement-tombstone');

    expect(selections).toHaveLength(MAX_UNRESOLVED_INVOCATIONS);
    expect(tombstones).toHaveLength(3);
    expect(tombstones.map((event) => event.invocationId)).toEqual(['invocation-0', 'invocation-1', 'invocation-2']);
    const sequences = retained.map((event) => event.sequence as number);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  });

  it('keeps the latest stable completed pair after the age window expires', async () => {
    const path = databasePath();
    const unstable: DurableHandoffRoutingBasis = { kind: 'incumbent-unresolved', cause: 'unreadable-record' };
    const stable = await committed(path, [selection('stable', 1)]);
    await committed(path, [terminal('stable', 2, stable.sequence)]);
    const expired = await committed(path, [selection('expired', 3, unstable)]);
    await committed(path, [terminal('expired', 4, expired.sequence)]);

    await committed(path, [selection('current', HANDOFF_ROUTING_COMPLETED_RETENTION_MS + 10)]);

    expect(records(path).filter((event) => event.invocationId === 'stable')).toHaveLength(2);
    expect(records(path).filter((event) => event.invocationId === 'expired')).toEqual([
      expect.objectContaining({
        eventKind: 'retirement-tombstone',
        retirementCause: 'completed-pair-compaction',
        terminalExisted: true,
      }),
    ]);
  });

  it('retires an out-of-order completed pair outside the newest completed window', async () => {
    const path = databasePath();
    const unstable: DurableHandoffRoutingBasis = { kind: 'incumbent-unresolved', cause: 'health-request-failed' };
    await committed(path, [selection('old', 1, unstable)]);
    const pairs = Array.from({ length: MAX_COMPLETED_HANDOFF_ROUTING_PAIRS }, (_, index) => {
      const selectionSequence = 2 + index * 2;
      return [
        selection(`new-${index}`, selectionSequence, unstable),
        terminal(`new-${index}`, selectionSequence + 1, selectionSequence),
      ];
    }).flat();
    await committed(path, pairs);
    await committed(path, [terminal('old', 1_000, 1)]);

    const retained = records(path);
    expect(retained.filter((event) => event.invocationId === 'old')).toEqual([
      expect.objectContaining({
        eventKind: 'retirement-tombstone',
        retirementCause: 'completed-pair-compaction',
        terminalExisted: true,
      }),
    ]);
  });

  it('classifies late terminals while capacity identity is retained and after it expires', async () => {
    const path = databasePath();
    const transitions = Array.from({ length: MAX_UNRESOLVED_INVOCATIONS + MAX_RETIREMENT_TOMBSTONES + 1 }, (_, index) =>
      selection(`opening-${index}`, index + 1),
    );
    await committed(path, transitions);
    const aggregate = metadata(path);
    expect(aggregate.expired_identity_count).toBe(1);
    expect(aggregate.capacity_eviction_count).toBe(1);

    await committed(path, [terminal('opening-0', 1_000, 1)]);
    expect(records(path).find((event) => event.invocationId === 'opening-0')).toMatchObject({
      disposition: { kind: 'terminal-without-retained-selection' },
    });

    await committed(path, [terminal('opening-1', 1_001, 2)]);
    expect(records(path)).toContainEqual(
      expect.objectContaining({
        invocationId: 'opening-1',
        eventKind: 'retirement-tombstone',
        retirementCause: 'selection-evicted-at-capacity',
        terminalExisted: true,
      }),
    );
    await expect(publish(path, [terminal('opening-1', 1_002, 2)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
  });

  it('rolls up a newly created oldest tombstone immediately', async () => {
    const path = databasePath();
    const selected = await committed(path, [selection('opening', 1)]);
    const db = new DatabaseSync(path);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (let index = 0; index < MAX_RETIREMENT_TOMBSTONES; index += 1) {
        insertTombstoneFixture(
          db,
          retirementTombstoneSchema.parse({
            generation: HANDOFF_ROUTING_STATUS_GENERATION,
            sequence: index + 2,
            eventId: `seed-retirement-${index}`,
            invocationId: `seed-retired-${index}`,
            observedAt: at(index + 2),
            eventKind: 'retirement-tombstone',
            phase: 'retirement',
            selectionSequence: 1_000 + index,
            selectedAt: at(1_000 + index),
            owner: OWNER,
            selectedDisposition: {
              kind: 'continue-current',
              basis: { kind: 'same-build-set', buildSetId: BUILD_SET_ID },
            },
            retirementCause: 'selection-evicted-at-capacity',
            terminalExisted: false,
          }),
        );
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }

    await committed(path, [
      {
        kind: 'operator-resolved',
        eventId: 'resolve-opening',
        invocationId: 'opening',
        observedAt: at(2_000),
        selectionSequence: selected.sequence,
        reason: 'owner-absent',
      },
    ]);
    expect(records(path).some((event) => event.invocationId === 'opening')).toBe(false);
    expect(metadata(path)).toMatchObject({
      expired_identity_count: 1,
      operator_resolved_count: 1,
      min_selection_sequence: selected.sequence,
      max_selection_sequence: selected.sequence,
    });
  });

  it('rejects a duplicate terminal after completed-pair compaction', async () => {
    const path = databasePath();
    const unstable: DurableHandoffRoutingBasis = { kind: 'incumbent-unresolved', cause: 'unreadable-record' };
    const selected = await committed(path, [selection('completed', 1, unstable)]);
    await committed(path, [terminal('completed', 2, selected.sequence)]);
    await committed(path, [selection('current', HANDOFF_ROUTING_COMPLETED_RETENTION_MS + 10)]);
    expect(records(path)).toContainEqual(
      expect.objectContaining({
        invocationId: 'completed',
        retirementCause: 'completed-pair-compaction',
        terminalExisted: true,
      }),
    );
    await expect(publish(path, [terminal('completed', 3, selected.sequence)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
  });

  it('replaces operator resolution with a terminal that preserves both facts', async () => {
    const path = databasePath();
    const selected = await committed(path, [selection('resolved', 1)]);
    await committed(path, [
      {
        kind: 'operator-resolved',
        eventId: 'resolve-event',
        invocationId: 'resolved',
        observedAt: at(2),
        selectionSequence: selected.sequence,
        reason: 'operator-abandoned-unobservable',
      },
    ]);
    await committed(path, [terminal('resolved', 3, selected.sequence)]);

    expect(records(path).filter((event) => event.invocationId === 'resolved')).toEqual([
      expect.objectContaining({
        eventKind: 'continuation-finalized',
        disposition: expect.objectContaining({
          kind: 'terminal-after-operator-resolution',
          resolutionReason: 'operator-abandoned-unobservable',
          retiredSelection: expect.objectContaining({ selectionSequence: selected.sequence }),
        }),
      }),
    ]);
  });

  it('distinguishes unsupported, corrupt, and capacity-exhausted stores by outcome', async () => {
    const unsupportedPath = databasePath();
    await committed(unsupportedPath, [selection('supported', 1)]);
    const unsupported = new DatabaseSync(unsupportedPath);
    unsupported.exec(`PRAGMA user_version=${HANDOFF_ROUTING_STATUS_GENERATION + 1}`);
    unsupported.close();
    await expect(publish(unsupportedPath, [selection('next', 2)])).resolves.toEqual({
      kind: 'undeterminable',
      cause: 'unsupported-generation',
      errcode: 1,
    });

    const corruptPath = databasePath();
    writeFileSync(corruptPath, 'not a sqlite database');
    await expect(publish(corruptPath, [selection('corrupt', 3)])).resolves.toEqual({
      kind: 'undeterminable',
      cause: 'unreadable',
      errcode: 26,
    });

    const fullPath = databasePath();
    await committed(fullPath, [selection('seed', 4)]);
    const full = new DatabaseSync(fullPath);
    try {
      full.exec('PRAGMA synchronous=OFF');
      full.exec(`PRAGMA max_page_count=${MAX_HANDOFF_ROUTING_STATUS_BYTES / 4096}`);
      full.exec('CREATE TABLE padding (value BLOB NOT NULL)');
      const pad = full.prepare('INSERT INTO padding VALUES (?)');
      while (true) pad.run(Buffer.alloc(512));
    } catch (error) {
      expect(error).toMatchObject({ errcode: 13 });
    } finally {
      full.close();
    }
    let capacity: PublicationOutcome = { kind: 'committed', sequence: 0 };
    for (let index = 0; index < 10 && capacity.kind === 'committed'; index += 1) {
      capacity = await publish(fullPath, [
        {
          kind: 'execution-failed',
          eventId: `full-event-${index}`,
          invocationId: `full-gap-${index}`,
          observedAt: at(100 + index),
          selection: { kind: 'without-selection' },
          disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
        },
      ]);
    }
    expect(capacity).toEqual({ kind: 'not-published', cause: 'capacity-exhausted' });
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
