import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ABSENT_HANDOFF_RESULT_POLICY_PROJECTION,
  HANDOFF_CONTINUATION_REASON_POLICY_PROJECTIONS,
  HANDOFF_ROUTING_COMPLETED_RETENTION_MS,
  HANDOFF_ROUTING_STATUS_GENERATION,
  MAX_COMPLETED_HANDOFF_ROUTING_PAIRS,
  MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES,
  MAX_HANDOFF_ROUTING_STATUS_BYTES,
  MAX_LEGAL_CLOSING_RECORD_BYTES,
  MAX_LEGAL_ROUTING_SELECTED_TRANSITION,
  MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
  MAX_RETIREMENT_TOMBSTONE_BYTES,
  MAX_RETIREMENT_TOMBSTONES,
  MAX_UNRESOLVED_INVOCATIONS,
  invalidTargetSummarySchema,
  persistedHandoffDispositionPolicy,
  publishHandoffRoutingTransitions,
  readHandoffRoutingStatus,
  retirementTombstoneSchema,
  terminalEventSchema,
  type DurableHandoffRoutingBasis,
  type HandoffRoutingTransition,
  type PublicationOutcome,
  type RetirementTombstone,
} from '#src/coordinator/handoff-routing-status.js';
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

function createReadFixtureDatabase(
  path: string,
  rows: readonly Readonly<{ recordKind: 'selection'; bodyJson: string | null }>[],
): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE handoff_routing_metadata (
        singleton INTEGER PRIMARY KEY,
        generation INTEGER NOT NULL,
        expired_identity_count INTEGER NOT NULL,
        capacity_eviction_count INTEGER NOT NULL,
        completed_pair_compaction_count INTEGER NOT NULL,
        operator_resolved_count INTEGER NOT NULL,
        min_selection_sequence INTEGER,
        max_selection_sequence INTEGER,
        earliest_selected_at TEXT,
        latest_selected_at TEXT
      );
      CREATE TABLE handoff_routing_records (
        sequence INTEGER PRIMARY KEY,
        generation INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        record_kind TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        selection_sequence INTEGER,
        retirement_cause TEXT,
        terminal_existed INTEGER,
        body_json TEXT,
        encoded_bytes INTEGER
      );
      CREATE TABLE handoff_routing_closing_reserve (
        invocation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        allocation BLOB NOT NULL
      );
      INSERT INTO handoff_routing_metadata VALUES (${HANDOFF_ROUTING_STATUS_GENERATION}, ${HANDOFF_ROUTING_STATUS_GENERATION}, 0, 0, 0, 0, NULL, NULL, NULL, NULL);
      PRAGMA user_version=${HANDOFF_ROUTING_STATUS_GENERATION};
    `);
    const insert = db.prepare(
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
        body_json,
        encoded_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    );
    rows.forEach((row, index) => {
      insert.run(
        index + 1,
        HANDOFF_ROUTING_STATUS_GENERATION,
        `fixture-event-${index}`,
        `fixture-invocation-${index}`,
        at(index),
        row.recordKind,
        'routing-selected',
        row.bodyJson,
        typeof row.bodyJson === 'string' ? Buffer.byteLength(row.bodyJson, 'utf8') : null,
      );
      db.prepare(
        `INSERT INTO handoff_routing_closing_reserve (invocation_id, event_id, observed_at, allocation)
          VALUES (?, ?, ?, zeroblob(?))`,
      ).run(`fixture-invocation-${index}`, `fixture-event-${index}`, at(index), MAX_LEGAL_CLOSING_RECORD_BYTES);
    });
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('handoff routing status', () => {
  it('projects continuation and absent obligations without inventing persisted status for ephemeral bindings', () => {
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

  it('keeps bounded projections within maximum legal fixture limits', () => {
    expect(
      invalidTargetSummarySchema.safeParse({ failure: 'bundle-dir-unavailable', bundleDir: '/tmp/x' }).success,
    ).toBe(false);
    expect(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBeLessThanOrEqual(MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES);
    expect(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBeLessThanOrEqual(MAX_LEGAL_CLOSING_RECORD_BYTES);
    expect(MAX_RETIREMENT_TOMBSTONES * MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBeLessThanOrEqual(
      MAX_RETIREMENT_TOMBSTONE_BYTES,
    );
  });

  it('creates the bounded schema with persistent settings and relational uniqueness', async () => {
    const path = databasePath();
    await committed(path, [selection('active', 1)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: HANDOFF_ROUTING_STATUS_GENERATION });
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
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

      const activeSequence = active.sequence;
      if (typeof activeSequence !== 'number') throw new Error('Active fixture has no numeric sequence');
      const contradictoryTerminal = terminalEventSchema.parse({
        generation: HANDOFF_ROUTING_STATUS_GENERATION,
        sequence: 2,
        eventId: 'terminal-for-retained-selection',
        invocationId: 'active',
        observedAt: at(2),
        eventKind: 'continuation-finalized',
        phase: 'terminal',
        selection: { kind: 'with-selection-sequence', selectionSequence: activeSequence },
        disposition: {
          kind: 'terminal-after-operator-resolution',
          resolutionReason: 'owner-absent',
          retiredSelection: {
            selectionSequence: activeSequence,
            selectedAt: active.observedAt,
            owner: active.owner,
            selectedDisposition: active.disposition,
          },
          terminal: {
            kind: 'continued-current',
            reason: { kind: 'routing', basis: { kind: 'same-build-set', buildSetId: BUILD_SET_ID } },
          },
        },
      });
      expect(() =>
        db
          .prepare(
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
            ) VALUES (?, ?, ?, ?, ?, 'terminal', ?, ?, NULL, NULL, ?)`,
          )
          .run(
            contradictoryTerminal.sequence,
            contradictoryTerminal.generation,
            contradictoryTerminal.eventId,
            contradictoryTerminal.invocationId,
            contradictoryTerminal.observedAt,
            contradictoryTerminal.eventKind,
            activeSequence,
            JSON.stringify(contradictoryTerminal),
          ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('reads one stable projection with unresolved liveness, paired and gap terminals, and retirement', async () => {
    const path = databasePath();
    const alive = { ...selection('alive', 1), owner: { pid: 101, incarnation: testIncarnation(101) } } as const;
    const absent = { ...selection('absent', 2), owner: { pid: 102, incarnation: testIncarnation(102) } } as const;
    const incarnationUnavailable = {
      ...selection('incarnation-unavailable', 3),
      owner: { pid: 103, incarnation: testIncarnation(103) },
    } as const;
    const deadlineExpired = {
      ...selection('deadline-expired', 4),
      owner: { pid: 104, incarnation: testIncarnation(104) },
    } as const;
    const probeFailed = {
      ...selection('probe-failed', 5),
      owner: { pid: 105, incarnation: testIncarnation(105) },
    } as const;
    await committed(path, [alive, absent, incarnationUnavailable, deadlineExpired, probeFailed]);
    const paired = await committed(path, [selection('paired', 6)]);
    await committed(path, [terminal('paired', 7, paired.sequence)]);
    await committed(path, [
      {
        kind: 'execution-failed',
        eventId: 'gap-terminal',
        invocationId: 'gap',
        observedAt: at(8),
        selection: { kind: 'without-selection' },
        disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
      },
    ]);
    const retired = await committed(path, [selection('retired', 9)]);
    await committed(path, [
      {
        kind: 'operator-resolved',
        eventId: 'retired-resolution',
        invocationId: 'retired',
        observedAt: at(10),
        selectionSequence: retired.sequence,
        reason: 'owner-absent',
      },
    ]);

    const result = readHandoffRoutingStatus(path, (owner) => {
      switch (owner.pid) {
        case 101:
          return { kind: 'alive' };
        case 102:
          return { kind: 'absent' };
        case 103:
          return { kind: 'unobservable', cause: 'incarnation-unavailable' };
        case 104:
          return { kind: 'unobservable', cause: 'deadline-expired' };
        case 105:
          throw new Error('probe failed');
        default:
          return { kind: 'alive' };
      }
    });

    expect(result).toMatchObject({
      kind: 'current',
      generation: HANDOFF_ROUTING_STATUS_GENERATION,
      retirementHistoryTruncated: { expiredIdentityCount: 0 },
    });
    if (result.kind !== 'current') throw new Error(`Expected current status, received ${result.kind}`);
    const status = (invocationId: string) =>
      result.statuses.find((candidate) =>
        candidate.kind === 'retired'
          ? candidate.tombstone.invocationId === invocationId
          : candidate.kind === 'unresolved'
            ? candidate.selection.invocationId === invocationId
            : candidate.terminal.invocationId === invocationId,
      );
    expect(status('alive')).toMatchObject({ kind: 'unresolved', ownerLiveness: { kind: 'alive' } });
    expect(status('absent')).toMatchObject({ kind: 'unresolved', ownerLiveness: { kind: 'absent' } });
    expect(status('incarnation-unavailable')).toMatchObject({
      kind: 'unresolved',
      ownerLiveness: { kind: 'unobservable', cause: 'incarnation-unavailable' },
    });
    expect(status('deadline-expired')).toMatchObject({
      kind: 'unresolved',
      ownerLiveness: { kind: 'unobservable', cause: 'deadline-expired' },
    });
    expect(status('probe-failed')).toMatchObject({
      kind: 'unresolved',
      ownerLiveness: { kind: 'unobservable', cause: 'probe-failed' },
    });
    expect(status('paired')).toMatchObject({
      kind: 'terminal',
      selection: { invocationId: 'paired' },
      terminal: { invocationId: 'paired' },
    });
    expect(status('gap')).toMatchObject({
      kind: 'terminal',
      selection: null,
      terminal: { selection: { kind: 'without-selection' } },
    });
    expect(status('retired')).toMatchObject({ kind: 'retired', tombstone: { invocationId: 'retired' } });

    const withoutProbe = readHandoffRoutingStatus(path);
    expect(withoutProbe).toMatchObject({ kind: 'current' });
    if (withoutProbe.kind !== 'current') throw new Error(`Expected current status, received ${withoutProbe.kind}`);
    expect(
      withoutProbe.statuses.find(
        (candidate) => candidate.kind === 'unresolved' && candidate.selection.invocationId === 'alive',
      ),
    ).toMatchObject({ ownerLiveness: { kind: 'unobservable', cause: 'probe-not-available' } });
  });

  it('returns distinct absent, unsupported-generation, unreadable, and I/O-failure results', async () => {
    const absentPath = databasePath();
    expect(readHandoffRoutingStatus(absentPath)).toEqual({ kind: 'absent' });

    const unsupportedPath = databasePath();
    const unsupported = new DatabaseSync(unsupportedPath);
    unsupported.exec(`PRAGMA user_version=${HANDOFF_ROUTING_STATUS_GENERATION + 1}`);
    unsupported.close();
    expect(readHandoffRoutingStatus(unsupportedPath)).toEqual({
      kind: 'unsupported-generation',
      generation: HANDOFF_ROUTING_STATUS_GENERATION + 1,
    });

    const invalidJsonPath = databasePath();
    createReadFixtureDatabase(invalidJsonPath, [{ recordKind: 'selection', bodyJson: '{' }]);
    expect(readHandoffRoutingStatus(invalidJsonPath)).toEqual({ kind: 'unreadable', reason: 'invalid-json' });

    const invalidShapePath = databasePath();
    createReadFixtureDatabase(invalidShapePath, [{ recordKind: 'selection', bodyJson: '{}' }]);
    expect(readHandoffRoutingStatus(invalidShapePath)).toEqual({ kind: 'unreadable', reason: 'invalid-shape' });

    const nullBodyPath = databasePath();
    createReadFixtureDatabase(nullBodyPath, [{ recordKind: 'selection', bodyJson: null }]);
    expect(readHandoffRoutingStatus(nullBodyPath)).toEqual({ kind: 'unreadable', reason: 'invalid-shape' });

    const tooLargePath = databasePath();
    createReadFixtureDatabase(tooLargePath, [
      { recordKind: 'selection', bodyJson: JSON.stringify({ padding: 'x'.repeat(10_000) }) },
    ]);
    expect(readHandoffRoutingStatus(tooLargePath)).toEqual({ kind: 'unreadable', reason: 'too-large' });

    const permissionDeniedPath = databasePath();
    await committed(permissionDeniedPath, [selection('permission-denied', 1)]);
    chmodSync(permissionDeniedPath, 0o000);
    try {
      if (process.platform !== 'win32') {
        expect(readHandoffRoutingStatus(permissionDeniedPath)).toEqual({
          kind: 'undeterminable',
          cause: 'io-failed',
          errcode: -13,
        });
      }
    } finally {
      chmodSync(permissionDeniedPath, 0o600);
    }
  });

  it('does not certify an unresolved selection whose closing reserve is missing', async () => {
    const path = databasePath();
    const selected = await committed(path, [selection('missing-reserve', 1)]);
    const db = new DatabaseSync(path);
    try {
      db.prepare("DELETE FROM handoff_routing_closing_reserve WHERE invocation_id = 'missing-reserve'").run();
    } finally {
      db.close();
    }

    expect(readHandoffRoutingStatus(path)).toEqual({ kind: 'unreadable', reason: 'invalid-shape' });
    await expect(publish(path, [terminal('missing-reserve', 2, selected.sequence)])).resolves.toEqual({
      kind: 'undeterminable',
      cause: 'unreadable',
      errcode: 11,
    });
  });

  it('reads the previous committed snapshot while a writer holds an immediate transaction', async () => {
    const path = databasePath();
    await committed(path, [selection('visible', 1)]);
    const writer = new DatabaseSync(path);
    try {
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare("DELETE FROM handoff_routing_records WHERE invocation_id = 'visible'").run();
      const result = readHandoffRoutingStatus(path);
      expect(result).toMatchObject({ kind: 'current' });
      if (result.kind !== 'current') throw new Error(`Expected current status, received ${result.kind}`);
      expect(result.statuses).toContainEqual(
        expect.objectContaining({
          kind: 'unresolved',
          selection: expect.objectContaining({ invocationId: 'visible' }),
        }),
      );
      writer.exec('ROLLBACK');
    } finally {
      if (writer.isTransaction) writer.exec('ROLLBACK');
      writer.close();
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

  it('measures the contention deadline on monotonic time', async () => {
    const path = databasePath();
    await committed(path, [selection('monotonic-seed', 1)]);
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN IMMEDIATE');
    let elapsedMs = 0n;
    let wallClockReads = 0;
    const jumpingWallClock = {
      now: (): number => {
        wallClockReads += 1;
        return wallClockReads * 10_000;
      },
      monotonicNow: (): bigint => elapsedMs,
      sleep: async (milliseconds: number): Promise<void> => {
        elapsedMs += BigInt(milliseconds);
      },
    };
    try {
      await expect(
        publishHandoffRoutingTransitions(jumpingWallClock, path, [selection('monotonic-contender', 2)]),
      ).resolves.toEqual({ kind: 'not-published', cause: 'contended' });
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(elapsedMs).toBe(1_000n);
    expect(wallClockReads).toBe(0);
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
    await expect(
      publish(path, [
        {
          ...selection('noncanonical-time', 1),
          observedAt: '9999-12-31T23:59:59.99999999999999+23:59',
        },
      ]),
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

  it('accepts maximum legal selection and tombstone rows at six-digit sequences', async () => {
    const path = databasePath();
    await committed(path, [selection('sequence-seed', 1)]);
    const db = new DatabaseSync(path);
    try {
      db.exec('DELETE FROM handoff_routing_closing_reserve');
      db.exec('DELETE FROM handoff_routing_records');
      db.prepare("UPDATE sqlite_sequence SET seq = 99999 WHERE name = 'handoff_routing_records'").run();
    } finally {
      db.close();
    }

    const selected = await committed(path, [MAX_LEGAL_ROUTING_SELECTED_TRANSITION]);
    expect(selected.sequence).toBe(100_000);
    const resolutionEventId = `${MAX_LEGAL_ROUTING_SELECTED_TRANSITION.eventId.slice(0, -1)}\u0801`;
    await expect(
      publish(path, [
        {
          kind: 'operator-resolved',
          eventId: resolutionEventId,
          invocationId: MAX_LEGAL_ROUTING_SELECTED_TRANSITION.invocationId,
          observedAt: MAX_LEGAL_ROUTING_SELECTED_TRANSITION.observedAt,
          selectionSequence: selected.sequence,
          reason: 'operator-abandoned-unobservable',
        },
      ]),
    ).resolves.toEqual({ kind: 'committed', sequence: 100_001 });
    expect(records(path)).toEqual([
      expect.objectContaining({
        sequence: 100_001,
        eventKind: 'retirement-tombstone',
        observedAt: MAX_LEGAL_ROUTING_SELECTED_TRANSITION.observedAt,
        selectedAt: MAX_LEGAL_ROUTING_SELECTED_TRANSITION.observedAt,
      }),
    ]);
  });

  it('attributes domain conflicts before SQLite and does not call an unexpected constraint a rejected transition', async () => {
    const path = databasePath();
    await committed(path, [selection('seed', 1)]);
    await expect(publish(path, [{ ...selection('duplicate-event', 2), eventId: 'event-1' }])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });

    const db = new DatabaseSync(path);
    try {
      db.exec(`
        CREATE TRIGGER reject_handoff_routing_insert
        BEFORE INSERT ON handoff_routing_records
        BEGIN
          SELECT RAISE(ABORT, 'unexpected durable shape');
        END
      `);
    } finally {
      db.close();
    }

    await expect(publish(path, [selection('valid-transition', 3)])).resolves.toEqual({
      kind: 'undeterminable',
      cause: 'io-failed',
      errcode: 1_811,
    });
  });

  it('preserves the SQLite code that makes a generation-matching artifact unreadable', async () => {
    const path = databasePath();
    await committed(path, [selection('seed', 1)]);
    const db = new DatabaseSync(path);
    try {
      db.exec('DROP TABLE handoff_routing_metadata');
    } finally {
      db.close();
    }

    await expect(publish(path, [selection('next', 2)])).resolves.toEqual({
      kind: 'undeterminable',
      cause: 'unreadable',
      errcode: 1,
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
