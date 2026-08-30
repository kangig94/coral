import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  ABSENT_HANDOFF_RESULT_POLICY_PROJECTION,
  HANDOFF_CONTINUATION_REASON_POLICY_PROJECTIONS,
  HANDOFF_ROUTING_COMPLETED_RETENTION_MS,
  HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION,
  MAX_HANDOFF_ROUTING_OWNER_SWEEP_MS,
  MAX_COMPLETED_HANDOFF_ROUTING_PAIRS,
  MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES,
  MAX_HANDOFF_ROUTING_STATUS_BYTES,
  MAX_LEGAL_CLOSING_RECORD_BYTES,
  MAX_LEGAL_ROUTING_SELECTED_TRANSITION,
  MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
  MAX_RETIREMENT_TOMBSTONE_BYTES,
  MAX_RETIREMENT_TOMBSTONES,
  MAX_UNRESOLVED_INVOCATIONS,
  handoffRoutingRecordSchemaRegistry,
  handoffRoutingSentinelRecordSchemaRegistry,
  handoffRoutingStatusExitContribution,
  handoffRoutingStatusStoreSchema,
  handoffRoutingTransitionSchema,
  invalidTargetSummarySchema,
  persistedHandoffDispositionPolicy,
  publishGenerationCoordinatedHandoffRoutingTransitions,
  readHandoffRoutingStatus as readHandoffRoutingStatusWithRuntime,
  readHandoffRoutingStatusForDiscard,
  readHandoffRoutingStatusWithOwnerObservations,
  resolveHandoffRoutingStatus,
  type DurableHandoffRoutingBasis,
  type HandoffRoutingTransition,
  type PublicationOutcome,
  type RetirementTombstone,
} from '#src/coordinator/handoff-routing/status.js';
import {
  clearHandoffRoutingStatusQuarantine,
  discardHandoffRoutingStatus,
  type HandoffRoutingStatusOperatorOptions,
} from '#src/coordinator/handoff-routing/status-operator.js';
import { formatHandoffRoutingStatus } from '#src/cli/format/backend.js';
import type { ProcessIdentityObservation } from '#src/infra/port-types.js';
import { zodPersistedContract } from '#src/infra/persisted-contract.js';
import { DirectoryLockOwnershipLostError, tryAcquireDirectoryLock } from '#src/infra/fs-lock.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { acquireOperatorSocketGuard } from '#src/cli/operator-socket-guard.js';
import {
  acquireGenerationMaintenanceLease,
  resolveGenerationBoundaryPaths,
  tryAcquireGenerationWriterLease,
} from '#src/store/generation-mutation-coordination.js';
import { SimulationRuntime } from '../../../../tools/simulation/runtime.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import type { SqliteDatabasePort, StoragePort } from '#src/infra/port-types.js';
import {
  HANDOFF_ROUTING_STATUS_GENERATION_BAND,
  handoffRoutingStatusGeneration,
  MAX_HANDOFF_ROUTING_STATUS_QUARANTINES,
  clearHandoffRoutingStoreQuarantine,
  quarantineHandoffRoutingStoreArtifact,
  SQLITE_CORRUPT,
  SQLITE_FULL,
  listHandoffRoutingStoreQuarantines,
  type HandoffRoutingStatusQuarantineList,
} from '#src/store/handoff-routing-status-store/index.js';

const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());
const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const BUILD_SET_ID = '123e4567-e89b-42d3-a456-426614174000';
const OWNER = { pid: 101, incarnation: testIncarnation(101) } as const;
const temporaryDirectories: string[] = [];
const runtimeBaseDir = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-runtime-'));
const runtime = createRealRuntime('prod', { baseDir: runtimeBaseDir });

function routingStatusOperatorOptions(runtime: Runtime, path: string): HandoffRoutingStatusOperatorOptions {
  return { runtime, path, acquireSocketGuard: acquireOperatorSocketGuard };
}

function at(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-'));
  temporaryDirectories.push(directory);
  return join(directory, `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`);
}

function listedQuarantines(
  storage: StoragePort,
  path: string,
): Extract<HandoffRoutingStatusQuarantineList, { kind: 'listed' }> {
  const result = listHandoffRoutingStoreQuarantines(storage, path);
  if (result.kind !== 'listed') throw new Error(`Expected quarantine listing, received ${result.kind}`);
  return result;
}

function createDurabilityAwareStorage(
  base: StoragePort,
  initialEntries: ReadonlyMap<string, string>,
): Readonly<{ storage: StoragePort; crash: () => ReadonlyMap<string, string> }> {
  const pendingEntries = new Map(initialEntries);
  const durableEntries = new Map(initialEntries);
  const trackedPaths = new Set(initialEntries.keys());
  const storage: StoragePort = {
    ...base,
    linkSync: (source, destination) => {
      base.linkSync(source, destination);
      const payloadIdentity = pendingEntries.get(source);
      if (payloadIdentity !== undefined) {
        trackedPaths.add(destination);
        pendingEntries.set(destination, payloadIdentity);
      }
    },
    unlinkSync: (path) => {
      base.unlinkSync(path);
      if (trackedPaths.has(path)) pendingEntries.delete(path);
    },
    syncDirectoryDurableSync: (directory) => {
      const synced = base.syncDirectoryDurableSync(directory);
      if (!synced) return false;
      for (const path of trackedPaths) {
        if (dirname(path) !== directory) continue;
        const payloadIdentity = pendingEntries.get(path);
        if (payloadIdentity === undefined) durableEntries.delete(path);
        else durableEntries.set(path, payloadIdentity);
      }
      return true;
    },
  };
  return {
    storage,
    crash: () => {
      pendingEntries.clear();
      for (const [path, payloadIdentity] of durableEntries) pendingEntries.set(path, payloadIdentity);
      return new Map(pendingEntries);
    },
  };
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

function unsupportedWalDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=1');
  } finally {
    database.close();
  }
  if (existsSync(`${path}-wal`)) unlinkSync(`${path}-wal`);
  if (existsSync(`${path}-shm`)) unlinkSync(`${path}-shm`);
}

function publish(
  path: string,
  transitions: readonly HandoffRoutingTransition[],
  signal?: AbortSignal,
): Promise<PublicationOutcome> {
  return publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, transitions, signal);
}

function storageFailingOnSqliteStatement(
  storage: StoragePort,
  failingStatement: string,
  errcode = SQLITE_FULL,
): StoragePort {
  return new Proxy(storage, {
    get(target, property) {
      if (property !== 'openSqliteDatabaseSync') return Reflect.get(target, property, target);
      return (path: string, options?: { readOnly?: boolean }): SqliteDatabasePort => {
        const database = target.openSqliteDatabaseSync(path, options);
        // Publication opens read-write and reading opens read-only, so sparing read-only connections aims
        // the injection at the publication even when a caller reads first.
        if (options?.readOnly === true) return database;
        return {
          exec(sql) {
            if (sql === failingStatement) {
              throw Object.assign(new Error(`injected ${failingStatement} failure`), { errcode });
            }
            database.exec(sql);
          },
          prepare: database.prepare.bind(database),
          close: database.close.bind(database),
        };
      };
    },
  });
}

function storageFailingOnSqliteRun(storage: StoragePort, sqlFragment: string, errcode: number): StoragePort {
  return new Proxy(storage, {
    get(target, property) {
      if (property !== 'openSqliteDatabaseSync') return Reflect.get(target, property, target);
      return (path: string, options?: { readOnly?: boolean }): SqliteDatabasePort => {
        const database = target.openSqliteDatabaseSync(path, options);
        if (options?.readOnly === true) return database;
        return {
          exec: database.exec.bind(database),
          close: database.close.bind(database),
          prepare(sql) {
            const statement = database.prepare(sql);
            if (!sql.includes(sqlFragment)) return statement;
            return {
              all: statement.all.bind(statement),
              get: statement.get.bind(statement),
              run: () => {
                throw Object.assign(new Error(`injected ${sqlFragment} failure`), { errcode });
              },
            };
          },
        };
      };
    },
  });
}

function readHandoffRoutingStatus(
  path: string,
  probe?: Parameters<typeof readHandoffRoutingStatusWithRuntime>[2],
): ReturnType<typeof readHandoffRoutingStatusWithRuntime> {
  return readHandoffRoutingStatusWithRuntime(runtime, path, probe);
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

async function createReadFixtureDatabase(
  path: string,
  rows: readonly Readonly<{ recordKind: 'selection'; bodyJson: string }>[],
): Promise<void> {
  await committed(path, [selection('read-fixture-seed', 0)]);
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA ignore_check_constraints=ON;
      DELETE FROM handoff_routing_records;
      DELETE FROM handoff_routing_closing_reserve;
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
        body_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
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

afterAll(() => {
  rmSync(runtimeBaseDir, { recursive: true, force: true });
});

describe('handoff-routing/status', () => {
  it('should initialize from a fresh module registry with an address in the generation band', async () => {
    vi.resetModules();
    const statusModule = await import('#src/coordinator/handoff-routing/status.js');
    const generation = handoffRoutingStatusGeneration(statusModule.handoffRoutingStatusStoreSchema());

    expect(generation).toBeGreaterThanOrEqual(HANDOFF_ROUTING_STATUS_GENERATION_BAND.minimum);
    expect(generation).toBeLessThanOrEqual(HANDOFF_ROUTING_STATUS_GENERATION_BAND.maximum);
  });

  it('should extract persisted contracts from every sentinel-generation record root', () => {
    expect(() => {
      for (const schema of Object.values(handoffRoutingSentinelRecordSchemaRegistry)) {
        zodPersistedContract(schema);
      }
    }).not.toThrow();
    expect(handoffRoutingStatusStoreSchema().durableFormat.recordContracts).toEqual({
      selection: zodPersistedContract(handoffRoutingSentinelRecordSchemaRegistry.selection),
      terminal: zodPersistedContract(handoffRoutingSentinelRecordSchemaRegistry.terminal),
      retirement: zodPersistedContract(handoffRoutingSentinelRecordSchemaRegistry.retirement),
    });
    expect(Object.keys(handoffRoutingStatusStoreSchema().durableFormat.bodyVocabulary)).toEqual([
      'completedPairStability',
    ]);
    expect(HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION).toBe(0);
  });

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
    expect(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBe(MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES);
    expect(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBeLessThanOrEqual(MAX_LEGAL_CLOSING_RECORD_BYTES);
    expect(MAX_RETIREMENT_TOMBSTONES * MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBe(MAX_RETIREMENT_TOMBSTONE_BYTES);
  });

  it('publishes through simulation storage without touching the host path', async () => {
    const simulation = new SimulationRuntime();
    const path = `/simulation-only/handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`;

    expect(existsSync(path)).toBe(false);
    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(simulation, path, [selection('simulated', 1)]),
    ).resolves.toEqual({ kind: 'committed', sequence: 1 });
    expect(simulation.storage.existsSync(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readHandoffRoutingStatusWithRuntime(simulation, path)).toMatchObject({
      kind: 'current',
      statuses: [{ kind: 'unresolved', selection: { invocationId: 'simulated' } }],
    });
  });

  it('restores, unlinks, and recreates the simulated SQLite artifact with the virtual filesystem', async () => {
    const simulation = new SimulationRuntime();
    const path = `/simulation-only/handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`;
    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(simulation, path, [selection('before-snapshot', 1)]),
    ).resolves.toMatchObject({
      kind: 'committed',
    });
    const snapshot = simulation.storage.snapshot();
    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(simulation, path, [selection('after-snapshot', 2)]),
    ).resolves.toMatchObject({
      kind: 'committed',
    });

    simulation.storage.restore(snapshot);
    expect(readHandoffRoutingStatusWithRuntime(simulation, path)).toMatchObject({
      kind: 'current',
      statuses: [{ selection: { invocationId: 'before-snapshot' } }],
    });

    const renamedPath = `/simulation-only/renamed-handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`;
    simulation.storage.renameSync(path, renamedPath);
    expect(readHandoffRoutingStatusWithRuntime(simulation, path)).toEqual({ kind: 'absent' });
    expect(readHandoffRoutingStatusWithRuntime(simulation, renamedPath)).toMatchObject({
      kind: 'current',
      statuses: [{ selection: { invocationId: 'before-snapshot' } }],
    });
    simulation.storage.renameSync(renamedPath, path);

    simulation.storage.unlinkSync(path);
    expect(readHandoffRoutingStatusWithRuntime(simulation, path)).toEqual({ kind: 'absent' });
    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(simulation, path, [selection('after-unlink', 3)]),
    ).resolves.toMatchObject({
      kind: 'committed',
    });
    expect(readHandoffRoutingStatusWithRuntime(simulation, path)).toMatchObject({
      kind: 'current',
      statuses: [{ selection: { invocationId: 'after-unlink' } }],
    });
  });

  it.each(['absent', 'zero'] as const)('maps a %s main with a detached wal without opening SQLite', async (main) => {
    const path = databasePath();
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    if (main === 'zero') writeFileSync(path, Buffer.alloc(0), { mode: 0o600 });
    writeFileSync(`${path}-wal`, 'detached wal');
    const openSqliteDatabaseSync = vi.fn(baseRuntime.storage.openSqliteDatabaseSync.bind(baseRuntime.storage));
    const observedRuntime: Runtime = {
      ...baseRuntime,
      storage: { ...baseRuntime.storage, openSqliteDatabaseSync },
    };

    expect(readHandoffRoutingStatusWithRuntime(observedRuntime, path)).toEqual({
      kind: 'detached-wal',
    });
    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(observedRuntime, path, [selection(`detached-${main}`, 1)]),
    ).resolves.toEqual({ kind: 'artifact-refused', classification: { kind: 'detached-wal' } });
    expect(openSqliteDatabaseSync).not.toHaveBeenCalled();
  });

  it('maps an operational wal stat failure to I/O failure and blocks initialization', async () => {
    const path = databasePath();
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const statSync = ((candidate: string, options?: { bigint: true }) => {
      if (candidate === `${path}-wal`) {
        const error = new Error('injected wal stat failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        error.errno = SQLITE_FULL;
        throw error;
      }
      return options === undefined
        ? baseRuntime.storage.statSync(candidate)
        : baseRuntime.storage.statSync(candidate, options);
    }) as StoragePort['statSync'];
    const openSqliteDatabaseSync = vi.fn(baseRuntime.storage.openSqliteDatabaseSync.bind(baseRuntime.storage));
    const failingRuntime: Runtime = {
      ...baseRuntime,
      storage: { ...baseRuntime.storage, statSync, openSqliteDatabaseSync },
    };

    expect(readHandoffRoutingStatusWithRuntime(failingRuntime, path)).toEqual({
      kind: 'undeterminable',
      cause: 'io-failed',
      errcode: SQLITE_FULL,
    });
    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(failingRuntime, path, [selection('stat-failed', 1)]),
    ).resolves.toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'undeterminable', cause: 'io-failed', errcode: SQLITE_FULL },
    });
    expect(openSqliteDatabaseSync).not.toHaveBeenCalled();
  });

  it('carries the first and guarded wal receipts through the discard adapter', async () => {
    const path = databasePath();
    await committed(path, [selection('receipt-seed', 1)]);
    if (existsSync(`${path}-wal`)) unlinkSync(`${path}-wal`);
    const receiptRuntime = createRealRuntime('prod', { baseDir: dirname(path) });

    const firstObservation = readHandoffRoutingStatusForDiscard(receiptRuntime, path);
    const guardedObservation = readHandoffRoutingStatusForDiscard(receiptRuntime, path);

    expect(firstObservation).toMatchObject({
      kind: 'observed',
      status: { kind: 'current' },
      mainState: 'non-empty',
      walReceipt: { kind: 'absent' },
    });
    expect(guardedObservation).toMatchObject({
      kind: 'observed',
      status: { kind: 'current' },
      mainState: 'non-empty',
      walReceipt: { kind: 'zero', stat: { size: 0n } },
    });
  });

  it('quarantines a frames-bearing wal beside a zero-byte main without a pre-quarantine open', async () => {
    const path = databasePath();
    const fixturePath = `${path}.wal-source`;
    const fixture = new DatabaseSync(fixturePath);
    fixture.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('wal')");
    const walBytes = readFileSync(`${fixturePath}-wal`);
    expect(walBytes.length).toBeGreaterThan(0);
    fixture.close();
    writeFileSync(path, Buffer.alloc(0), { mode: 0o600 });
    writeFileSync(`${path}-wal`, walBytes);
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const openSqliteDatabaseSync = vi.fn(baseRuntime.storage.openSqliteDatabaseSync.bind(baseRuntime.storage));
    const discardRuntime: Runtime = {
      ...baseRuntime,
      storage: { ...baseRuntime.storage, openSqliteDatabaseSync },
    };

    const discarded = await discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path));

    expect(discarded).toMatchObject({
      kind: 'discarded',
      quarantineState: 'complete',
      previousStatus: { kind: 'detached-wal' },
    });
    if (discarded.kind !== 'discarded') throw new Error(`Expected discard, received ${discarded.kind}`);
    expect(readFileSync(`${discarded.quarantinePath}-wal`)).toEqual(walBytes);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(`${discarded.quarantinePath}-shm`)).toBe(false);
    expect(listHandoffRoutingStoreQuarantines(discardRuntime.storage, path)).toMatchObject({
      entries: [{ id: discarded.quarantineId, state: 'complete', artifacts: ['database', 'wal'] }],
    });
    expect(openSqliteDatabaseSync).not.toHaveBeenCalled();
  });

  it('retains a detached wal as an incomplete quarantine without attempting a missing-main link', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000041';
    const fixturePath = `${path}.wal-source`;
    const fixture = new DatabaseSync(fixturePath);
    fixture.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('wal')");
    const walBytes = readFileSync(`${fixturePath}-wal`);
    expect(walBytes.length).toBeGreaterThan(0);
    fixture.close();
    writeFileSync(`${path}-wal`, walBytes);
    writeFileSync(`${path}-shm`, 'rewritten index');
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    let mainLinkAttempted = false;
    const discardRuntime: Runtime = {
      ...baseRuntime,
      ids: { ...baseRuntime.ids, uuid: () => quarantineId },
      storage: {
        ...baseRuntime.storage,
        linkSync: (oldPath, newPath) => {
          if (oldPath === path) {
            mainLinkAttempted = true;
            throw new Error('missing main must not be linked');
          }
          baseRuntime.storage.linkSync(oldPath, newPath);
        },
      },
    };

    const discarded = await discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path));

    expect(discarded).toEqual({
      kind: 'discarded',
      artifactPath: path,
      quarantineId,
      quarantinePath: join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`),
      quarantineState: 'incomplete',
      previousStatus: { kind: 'detached-wal' },
    });
    if (discarded.kind !== 'discarded') throw new Error(`Expected discard, received ${discarded.kind}`);
    expect(mainLinkAttempted).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(readFileSync(`${discarded.quarantinePath}-wal`)).toEqual(walBytes);
    expect(listHandoffRoutingStoreQuarantines(baseRuntime.storage, path)).toEqual({
      kind: 'listed',
      entries: [
        {
          id: quarantineId,
          quarantinePath: discarded.quarantinePath,
          state: 'incomplete',
          artifacts: ['wal'],
        },
      ],
      overflow: false,
    });

    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(baseRuntime, path))).resolves.toEqual({
      kind: 'refused',
      status: { kind: 'absent' },
    });
    writeFileSync(path, 'different unreadable database', { mode: 0o600 });
    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(baseRuntime, path))).resolves.toEqual({
      kind: 'incomplete-quarantine',
      quarantineId,
    });
    await expect(
      clearHandoffRoutingStatusQuarantine(routingStatusOperatorOptions(baseRuntime, path), quarantineId),
    ).resolves.toMatchObject({ kind: 'cleared', entry: { state: 'incomplete', artifacts: ['wal'] } });
    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(baseRuntime, path))).resolves.toMatchObject({
      kind: 'discarded',
      quarantineState: 'complete',
    });
  });

  it('returns the exact wal-only store result when both observations found no main', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000042';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    writeFileSync(`${path}-wal`, 'detached wal evidence');
    const wal = statSync(`${path}-wal`, { bigint: true });
    const walReceipt = {
      kind: 'non-empty' as const,
      stat: { dev: wal.dev, ino: wal.ino, size: wal.size, mtimeNs: wal.mtimeNs },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        baseRuntime.storage,
        path,
        quarantineId,
        {
          firstMainState: 'absent',
          firstWalReceipt: walReceipt,
          guardedMainState: 'absent',
          guardedWalReceipt: walReceipt,
        },
        () => undefined,
      ),
    ).toEqual({
      kind: 'quarantined-incomplete',
      quarantineId,
      quarantinePath: join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`),
      retainedArtifacts: ['wal'],
    });
  });

  it('removes only an unchanged classifier-created zero wal from the retained set', async () => {
    const path = databasePath();
    unsupportedWalDatabase(path);
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    let movedWalSize: bigint | undefined;
    const discardRuntime: Runtime = {
      ...baseRuntime,
      storage: {
        ...baseRuntime.storage,
        linkSync: (oldPath, newPath) => {
          if (oldPath === `${path}-wal`) movedWalSize = statSync(oldPath, { bigint: true }).size;
          baseRuntime.storage.linkSync(oldPath, newPath);
        },
      },
    };

    const discarded = await discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path));

    if (discarded.kind !== 'discarded') throw new Error(`Expected discard, received ${discarded.kind}`);
    expect(discarded.quarantineState).toBe('complete');
    expect(movedWalSize).toBe(0n);
    expect(existsSync(`${discarded.quarantinePath}-wal`)).toBe(false);
    expect(listHandoffRoutingStoreQuarantines(discardRuntime.storage, path)).toMatchObject({
      entries: [{ id: discarded.quarantineId, state: 'complete', artifacts: ['database'] }],
    });
  });

  it('does not unlink evidence that replaces the validated classifier-created wal', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000060';
    unsupportedWalDatabase(path);
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    const quarantineWalPath = `${quarantinePath}-wal`;
    let movedWalValidated = false;
    let replacementInjected = false;
    const statSyncWithReplacement = ((candidate: string, options?: { bigint: true }) => {
      if (candidate === quarantineWalPath && movedWalValidated && !replacementInjected) {
        baseRuntime.storage.unlinkSync(candidate);
        baseRuntime.storage.writeFileSync(candidate, 'replacement wal evidence', { mode: 0o600 });
        replacementInjected = true;
      }
      return options === undefined
        ? baseRuntime.storage.statSync(candidate)
        : baseRuntime.storage.statSync(candidate, options);
    }) as StoragePort['statSync'];
    const discardRuntime: Runtime = {
      ...baseRuntime,
      ids: { ...baseRuntime.ids, uuid: () => quarantineId },
      storage: {
        ...baseRuntime.storage,
        openSync: (candidate, flags, mode) => {
          const fd = baseRuntime.storage.openSync(candidate, flags, mode);
          if (candidate === quarantineWalPath) movedWalValidated = true;
          return fd;
        },
        statSync: statSyncWithReplacement,
      },
    };

    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path))).resolves.toEqual({
      kind: 'quarantine-coordinate-occupied',
      quarantineId,
      quarantinePath,
      artifact: 'wal',
    });
    expect(replacementInjected).toBe(true);
    expect(readFileSync(quarantineWalPath, 'utf-8')).toBe('replacement wal evidence');
  });

  it('reports uncertain retention when sync fails after unlinking a classifier-created wal', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000046';
    unsupportedWalDatabase(path);
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const sync = baseRuntime.storage.syncDirectoryDurableSync.bind(baseRuntime.storage);
    const root = join(dirname(path), 'handoff-routing-quarantine');
    const quarantineWalPath = join(root, `${basename(path)}.${quarantineId}-wal`);
    let walRemoved = false;
    const discardRuntime: Runtime = {
      ...baseRuntime,
      ids: { ...baseRuntime.ids, uuid: () => quarantineId },
      storage: {
        ...baseRuntime.storage,
        unlinkSync: (candidate) => {
          baseRuntime.storage.unlinkSync(candidate);
          if (candidate === quarantineWalPath) walRemoved = true;
        },
        syncDirectoryDurableSync: (directory) => {
          if (directory === root && walRemoved) return false;
          return sync(directory);
        },
      },
    };

    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path))).resolves.toEqual({
      kind: 'quarantine-retention-undeterminable',
      quarantineId,
      quarantinePath: join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`),
      observedRetainedArtifacts: ['wal'],
      movedArtifacts: ['wal'],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: ['wal'],
      syncedDirectories: ['source', 'quarantine'],
      cause: 'directory-sync-failed',
    });
    expect(existsSync(path)).toBe(true);
    expect(listedQuarantines(baseRuntime.storage, path)).toEqual({
      kind: 'listed',
      entries: [],
      overflow: false,
    });
  });

  it('reports uncertain retention when ownership is lost after unlinking a classifier-created wal', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000056';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    writeFileSync(`${path}-wal`, '', { mode: 0o600 });
    const wal = statSync(`${path}-wal`, { bigint: true });
    const guardedWalReceipt = {
      kind: 'zero' as const,
      stat: { dev: wal.dev, ino: wal.ino, size: wal.size, mtimeNs: wal.mtimeNs },
    };
    let ownershipLost = false;
    const storage: StoragePort = {
      ...baseRuntime.storage,
      unlinkSync: (candidate) => {
        baseRuntime.storage.unlinkSync(candidate);
        if (candidate === `${quarantinePath}-wal`) ownershipLost = true;
      },
    };

    const result = quarantineHandoffRoutingStoreArtifact(
      storage,
      path,
      quarantineId,
      {
        firstMainState: 'non-empty',
        firstWalReceipt: { kind: 'absent' },
        guardedMainState: 'non-empty',
        guardedWalReceipt,
      },
      () => {
        if (ownershipLost) throw new DirectoryLockOwnershipLostError('/generation-maintenance');
      },
    );

    expect(result).toEqual({
      kind: 'quarantine-retention-undeterminable',
      quarantineId,
      quarantinePath,
      observedRetainedArtifacts: ['wal'],
      movedArtifacts: ['wal'],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: ['wal'],
      syncedDirectories: ['source', 'quarantine'],
      cause: 'ownership-lost',
    });
    expect(result).not.toHaveProperty('retainedArtifacts');
    expect(ownershipLost).toBe(true);
    expect(existsSync(`${quarantinePath}-wal`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('returns the quarantine coordinate and exact effects when ownership is lost after the wal link', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000047';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    writeFileSync(`${path}-wal`, 'retained wal');
    const wal = statSync(`${path}-wal`, { bigint: true });
    const walReceipt = {
      kind: 'non-empty' as const,
      stat: { dev: wal.dev, ino: wal.ino, size: wal.size, mtimeNs: wal.mtimeNs },
    };
    const quarantineWalPath = join(
      dirname(path),
      'handoff-routing-quarantine',
      `${basename(path)}.${quarantineId}-wal`,
    );
    let walLinked = false;
    const storage: StoragePort = {
      ...baseRuntime.storage,
      linkSync: (source, destination) => {
        baseRuntime.storage.linkSync(source, destination);
        if (source === `${path}-wal` && destination === quarantineWalPath) walLinked = true;
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: walReceipt,
          guardedMainState: 'non-empty',
          guardedWalReceipt: walReceipt,
        },
        () => {
          if (walLinked) throw new DirectoryLockOwnershipLostError('/generation-maintenance');
        },
      ),
    ).toEqual({
      kind: 'quarantine-storage-failed',
      quarantineId,
      quarantinePath: join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`),
      retainedArtifacts: ['wal'],
      movedArtifacts: [],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: [],
      syncedDirectories: ['source', 'quarantine'],
      cause: 'ownership-lost',
    });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(readFileSync(quarantineWalPath, 'utf-8')).toBe('retained wal');
  });

  it('reports a failed wal move when link ENOENT came from a vanished destination parent', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000049';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const root = join(dirname(path), 'handoff-routing-quarantine');
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    writeFileSync(`${path}-wal`, 'source wal');
    const wal = statSync(`${path}-wal`, { bigint: true });
    const walReceipt = {
      kind: 'non-empty' as const,
      stat: { dev: wal.dev, ino: wal.ino, size: wal.size, mtimeNs: wal.mtimeNs },
    };
    const storage: StoragePort = {
      ...baseRuntime.storage,
      linkSync: (source, destination) => {
        if (source === `${path}-wal`) {
          rmSync(root, { recursive: true, force: true });
          const error = new Error('injected missing destination parent') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        baseRuntime.storage.linkSync(source, destination);
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: walReceipt,
          guardedMainState: 'non-empty',
          guardedWalReceipt: walReceipt,
        },
        () => undefined,
      ),
    ).toEqual({
      kind: 'quarantine-storage-failed',
      quarantineId,
      quarantinePath: join(root, `${basename(path)}.${quarantineId}`),
      retainedArtifacts: [],
      movedArtifacts: [],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: [],
      syncedDirectories: ['source'],
      cause: 'artifact-move-failed',
    });
    expect(readFileSync(`${path}-wal`, 'utf-8')).toBe('source wal');
    expect(readFileSync(path, 'utf-8')).toBe('not a sqlite database');
  });

  it('reports unknown retention when a completed link is followed by an unobservable destination', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000050';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    writeFileSync(`${path}-wal`, 'source wal');
    const wal = statSync(`${path}-wal`, { bigint: true });
    const walReceipt = {
      kind: 'non-empty' as const,
      stat: { dev: wal.dev, ino: wal.ino, size: wal.size, mtimeNs: wal.mtimeNs },
    };
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    let linkReportedFailure = false;
    const statSyncWithFailedDestinationObservation = ((candidate: string, options?: { bigint: true }) => {
      if (linkReportedFailure && candidate === `${quarantinePath}-wal`) {
        const error = new Error('injected destination observation failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        error.errno = SQLITE_FULL;
        throw error;
      }
      return options === undefined
        ? baseRuntime.storage.statSync(candidate)
        : baseRuntime.storage.statSync(candidate, options);
    }) as StoragePort['statSync'];
    const storage: StoragePort = {
      ...baseRuntime.storage,
      statSync: statSyncWithFailedDestinationObservation,
      linkSync: (source, destination) => {
        if (source === `${path}-wal`) {
          baseRuntime.storage.linkSync(source, destination);
          linkReportedFailure = true;
          const error = new Error('injected ambiguous link failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        baseRuntime.storage.linkSync(source, destination);
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: walReceipt,
          guardedMainState: 'non-empty',
          guardedWalReceipt: walReceipt,
        },
        () => undefined,
      ),
    ).toMatchObject({
      kind: 'quarantine-retention-undeterminable',
      quarantineId,
      observedRetainedArtifacts: [],
      movedArtifacts: [],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: [],
      cause: 'artifact-observation-failed',
      errcode: SQLITE_FULL,
    });
    expect(readFileSync(`${path}-wal`, 'utf-8')).toBe('source wal');
    expect(readFileSync(`${quarantinePath}-wal`, 'utf-8')).toBe('source wal');
    expect(existsSync(path)).toBe(true);
  });

  it('refuses an unobservable quarantine coordinate before attempting mutation', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000055';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const root = join(dirname(path), 'handoff-routing-quarantine');
    const quarantinePath = join(root, `${basename(path)}.${quarantineId}`);
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    const statSyncWithUnobservableCoordinate = ((candidate: string, options?: { bigint: true }) => {
      if (candidate === quarantinePath) {
        const error = new Error('injected coordinate observation failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        error.errno = SQLITE_FULL;
        throw error;
      }
      return options === undefined
        ? baseRuntime.storage.statSync(candidate)
        : baseRuntime.storage.statSync(candidate, options);
    }) as StoragePort['statSync'];

    expect(
      quarantineHandoffRoutingStoreArtifact(
        { ...baseRuntime.storage, statSync: statSyncWithUnobservableCoordinate },
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => undefined,
      ),
    ).toEqual({ kind: 'undeterminable', cause: 'artifact-observation-failed', errcode: SQLITE_FULL });
    expect(existsSync(root)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('treats root creation as operation mutation when ownership is lost before artifact moves', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000051';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const root = join(dirname(path), 'handoff-routing-quarantine');
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    let rootCreated = false;
    const storage: StoragePort = {
      ...baseRuntime.storage,
      mkdirSync: (directory, options) => {
        baseRuntime.storage.mkdirSync(directory, options);
        if (directory === root) rootCreated = true;
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => {
          if (rootCreated) throw new DirectoryLockOwnershipLostError('/generation-maintenance');
        },
      ),
    ).toEqual({
      kind: 'quarantine-storage-failed',
      quarantineId,
      quarantinePath: join(root, `${basename(path)}.${quarantineId}`),
      retainedArtifacts: [],
      movedArtifacts: [],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: [],
      syncedDirectories: ['source'],
      cause: 'ownership-lost',
    });
    expect(existsSync(root)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('should report exact effects when ownership is lost after the main quarantine directory sync', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000063';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const root = join(dirname(path), 'handoff-routing-quarantine');
    const quarantinePath = join(root, `${basename(path)}.${quarantineId}`);
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    let ownershipLost = false;
    const storage: StoragePort = {
      ...baseRuntime.storage,
      syncDirectoryDurableSync: (directory) => {
        const synced = baseRuntime.storage.syncDirectoryDurableSync(directory);
        if (directory === root) ownershipLost = true;
        return synced;
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => {
          if (ownershipLost) throw new DirectoryLockOwnershipLostError('/generation-maintenance');
        },
      ),
    ).toEqual({
      kind: 'quarantine-storage-failed',
      quarantineId,
      quarantinePath,
      retainedArtifacts: ['database'],
      movedArtifacts: [],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: [],
      syncedDirectories: ['source', 'quarantine'],
      cause: 'ownership-lost',
    });
    expect(ownershipLost).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('not a sqlite database');
    expect(readFileSync(quarantinePath, 'utf-8')).toBe('not a sqlite database');
  });

  it('does not return quarantine success when ownership is lost during the final directory sync', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000052';
    const sourceDirectory = dirname(path);
    const baseRuntime = createRealRuntime('prod', { baseDir: sourceDirectory });
    const root = join(sourceDirectory, 'handoff-routing-quarantine');
    const quarantinePath = join(root, `${basename(path)}.${quarantineId}`);
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    let databaseRemoved = false;
    let ownershipLost = false;
    const storage: StoragePort = {
      ...baseRuntime.storage,
      unlinkSync: (candidate) => {
        baseRuntime.storage.unlinkSync(candidate);
        if (candidate === path) databaseRemoved = true;
      },
      syncDirectoryDurableSync: (directory) => {
        const synced = baseRuntime.storage.syncDirectoryDurableSync(directory);
        if (directory === sourceDirectory && databaseRemoved) ownershipLost = true;
        return synced;
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => {
          if (ownershipLost) throw new DirectoryLockOwnershipLostError('/generation-maintenance');
        },
      ),
    ).toEqual({
      kind: 'quarantine-storage-failed',
      quarantineId,
      quarantinePath,
      retainedArtifacts: ['database'],
      movedArtifacts: ['database'],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: [],
      syncedDirectories: ['source', 'quarantine'],
      cause: 'ownership-lost',
    });
    expect(databaseRemoved).toBe(true);
    expect(ownershipLost).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(quarantinePath, 'utf-8')).toBe('not a sqlite database');
  });

  it('does not replace a quarantine coordinate created at the atomic database-link boundary', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000053';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    writeFileSync(path, 'new source database evidence', { mode: 0o600 });
    let collisionInjected = false;
    const discardRuntime: Runtime = {
      ...baseRuntime,
      ids: { ...baseRuntime.ids, uuid: () => quarantineId },
      storage: {
        ...baseRuntime.storage,
        linkSync: (source, destination) => {
          if (source === path) {
            writeFileSync(destination, 'racing retained database evidence');
            collisionInjected = true;
          }
          baseRuntime.storage.linkSync(source, destination);
        },
      },
    };

    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path))).resolves.toEqual({
      kind: 'quarantine-coordinate-occupied',
      quarantineId,
      quarantinePath,
      artifact: 'database',
    });
    expect(collisionInjected).toBe(true);
    expect(readFileSync(quarantinePath, 'utf-8')).toBe('racing retained database evidence');
    expect(readFileSync(path, 'utf-8')).toBe('new source database evidence');
  });

  it('resumes a database move when a previous attempt linked the same file identity', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000056';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    mkdirSync(dirname(quarantinePath), { recursive: true, mode: 0o700 });
    writeFileSync(path, 'database evidence', { mode: 0o600 });
    baseRuntime.storage.linkSync(path, quarantinePath);
    const linked = statSync(quarantinePath, { bigint: true });

    expect(
      quarantineHandoffRoutingStoreArtifact(
        baseRuntime.storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => undefined,
      ),
    ).toEqual({ kind: 'quarantined', quarantineId, quarantinePath, retainedArtifacts: ['database'] });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(quarantinePath, 'utf-8')).toBe('database evidence');
    const resumed = statSync(quarantinePath, { bigint: true });
    expect({ dev: resumed.dev, ino: resumed.ino }).toEqual({ dev: linked.dev, ino: linked.ino });
  });

  it('does not unlink a replacement source when EEXIST refers to the previously observed inode', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000057';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    mkdirSync(dirname(quarantinePath), { recursive: true, mode: 0o700 });
    writeFileSync(path, 'inode A', { mode: 0o600 });
    baseRuntime.storage.linkSync(path, quarantinePath);
    const storage: StoragePort = {
      ...baseRuntime.storage,
      linkSync: (source, destination) => {
        if (source === path) {
          baseRuntime.storage.unlinkSync(source);
          baseRuntime.storage.writeFileSync(source, 'inode B', { mode: 0o600 });
        }
        baseRuntime.storage.linkSync(source, destination);
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => undefined,
      ),
    ).toEqual({ kind: 'quarantine-coordinate-occupied', quarantineId, quarantinePath, artifact: 'database' });
    expect(readFileSync(path, 'utf-8')).toBe('inode B');
    expect(readFileSync(quarantinePath, 'utf-8')).toBe('inode A');
  });

  it('does not unlink a source replacement created during the quarantine durability barrier', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000061';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const root = join(dirname(path), 'handoff-routing-quarantine');
    const quarantinePath = join(root, `${basename(path)}.${quarantineId}`);
    writeFileSync(path, 'inode A', { mode: 0o600 });
    let replacementInjected = false;
    const storage: StoragePort = {
      ...baseRuntime.storage,
      syncDirectoryDurableSync: (directory) => {
        const synced = baseRuntime.storage.syncDirectoryDurableSync(directory);
        if (directory === root && !replacementInjected) {
          baseRuntime.storage.unlinkSync(path);
          baseRuntime.storage.writeFileSync(path, 'inode B', { mode: 0o600 });
          replacementInjected = true;
        }
        return synced;
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => undefined,
      ),
    ).toEqual({ kind: 'quarantine-coordinate-occupied', quarantineId, quarantinePath, artifact: 'database' });
    expect(replacementInjected).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('inode B');
    expect(readFileSync(quarantinePath, 'utf-8')).toBe('inode A');
  });

  it.each([
    ['after link before quarantine sync', 'before-quarantine-sync', ['source']],
    ['after quarantine sync before unlink', 'before-unlink', ['source', 'quarantine']],
    ['after unlink before source sync', 'before-source-sync', ['source', 'quarantine']],
  ] as const)('retains a durable payload name across a crash %s', (_label, crashPoint, expectedDurableNames) => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000058';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const sourceDirectory = dirname(path);
    const root = join(sourceDirectory, 'handoff-routing-quarantine');
    writeFileSync(path, 'durable payload', { mode: 0o600 });
    const payloadIdentity = 'database-payload-A';
    const durability = createDurabilityAwareStorage(baseRuntime.storage, new Map([[path, payloadIdentity]]));
    let linked = false;
    let sourceUnlinked = false;
    const storage: StoragePort = {
      ...durability.storage,
      linkSync: (source, destination) => {
        durability.storage.linkSync(source, destination);
        if (source === path) linked = true;
      },
      unlinkSync: (candidate) => {
        if (candidate === path && crashPoint === 'before-unlink') throw new Error('simulated crash before unlink');
        durability.storage.unlinkSync(candidate);
        if (candidate === path) sourceUnlinked = true;
      },
      syncDirectoryDurableSync: (directory) => {
        if (directory === root && linked) {
          if (crashPoint === 'before-quarantine-sync') {
            throw new Error('simulated crash before quarantine sync');
          }
        }
        if (directory === sourceDirectory && sourceUnlinked && crashPoint === 'before-source-sync') {
          throw new Error('simulated crash before source sync');
        }
        return durability.storage.syncDirectoryDurableSync(directory);
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => undefined,
      ),
    ).toMatchObject({ kind: 'quarantine-storage-failed', retainedArtifacts: ['database'] });
    const recoveredNames = [...durability.crash()].map(([recoveredPath, recoveredPayload]) => [
      recoveredPath === path ? 'source' : 'quarantine',
      recoveredPayload,
    ]);
    expect(recoveredNames).toEqual(expectedDurableNames.map((name) => [name, payloadIdentity]));
  });

  it('orders the quarantine durability barriers around source removal', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000059';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const sourceDirectory = dirname(path);
    const root = join(sourceDirectory, 'handoff-routing-quarantine');
    const quarantinePath = join(root, `${basename(path)}.${quarantineId}`);
    writeFileSync(path, 'ordered payload', { mode: 0o600 });
    const operations: string[] = [];
    const storage: StoragePort = {
      ...baseRuntime.storage,
      mkdirSync: (directory, options) => {
        if (directory === root) operations.push('mkdir-quarantine');
        baseRuntime.storage.mkdirSync(directory, options);
      },
      linkSync: (source, destination) => {
        if (source === path && destination === quarantinePath) operations.push('link');
        baseRuntime.storage.linkSync(source, destination);
      },
      unlinkSync: (candidate) => {
        if (candidate === path) operations.push('unlink-source');
        baseRuntime.storage.unlinkSync(candidate);
      },
      syncDirectoryDurableSync: (directory) => {
        operations.push(directory === root ? 'sync-quarantine' : 'sync-source');
        return baseRuntime.storage.syncDirectoryDurableSync(directory);
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => undefined,
      ),
    ).toEqual({ kind: 'quarantined', quarantineId, quarantinePath, retainedArtifacts: ['database'] });
    expect(operations).toEqual([
      'mkdir-quarantine',
      'sync-source',
      'link',
      'sync-quarantine',
      'unlink-source',
      'sync-source',
    ]);
  });

  it('retains a pre-existing zero wal with its original file identity', async () => {
    const path = databasePath();
    unsupportedWalDatabase(path);
    writeFileSync(`${path}-wal`, Buffer.alloc(0));
    const before = statSync(`${path}-wal`, { bigint: true });
    const discardRuntime = createRealRuntime('prod', { baseDir: dirname(path) });

    const discarded = await discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path));

    if (discarded.kind !== 'discarded') throw new Error(`Expected discard, received ${discarded.kind}`);
    const after = statSync(`${discarded.quarantinePath}-wal`, { bigint: true });
    expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
      dev: before.dev,
      ino: before.ino,
      size: 0n,
    });
  });

  it('retains a classifier-created wal that grows after the guarded receipt', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000043';
    const racingBytes = Buffer.from('racing wal evidence');
    unsupportedWalDatabase(path);
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const discardRuntime: Runtime = {
      ...baseRuntime,
      ids: {
        ...baseRuntime.ids,
        uuid: () => {
          expect(statSync(`${path}-wal`, { bigint: true }).size).toBe(0n);
          writeFileSync(`${path}-wal`, racingBytes);
          return quarantineId;
        },
      },
    };

    const discarded = await discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path));

    if (discarded.kind !== 'discarded') throw new Error(`Expected discard, received ${discarded.kind}`);
    expect(readFileSync(`${discarded.quarantinePath}-wal`)).toEqual(racingBytes);
  });

  it('retains a zero wal replaced after the guarded receipt by comparing file identity', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000044';
    const replacementPath = `${path}.replacement-wal`;
    unsupportedWalDatabase(path);
    writeFileSync(replacementPath, Buffer.alloc(0));
    const replacement = statSync(replacementPath, { bigint: true });
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const discardRuntime: Runtime = {
      ...baseRuntime,
      ids: {
        ...baseRuntime.ids,
        uuid: () => {
          const classifierWal = statSync(`${path}-wal`, { bigint: true });
          expect(classifierWal.size).toBe(0n);
          expect({ dev: classifierWal.dev, ino: classifierWal.ino }).not.toEqual({
            dev: replacement.dev,
            ino: replacement.ino,
          });
          renameSync(replacementPath, `${path}-wal`);
          return quarantineId;
        },
      },
    };

    const discarded = await discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path));

    if (discarded.kind !== 'discarded') throw new Error(`Expected discard, received ${discarded.kind}`);
    const retained = statSync(`${discarded.quarantinePath}-wal`, { bigint: true });
    expect({ dev: retained.dev, ino: retained.ino, size: retained.size }).toEqual({
      dev: replacement.dev,
      ino: replacement.ino,
      size: 0n,
    });
  });

  it('quarantines an unreadable artifact, permits a clean publication, and refuses a current journal', async () => {
    const path = databasePath();
    const discardRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    writeFileSync(`${path}-wal`, 'retained wal');
    writeFileSync(`${path}-shm`, 'retained shm');

    const socket = await acquireOperatorSocketGuard({
      runtime: discardRuntime,
      operation: 'routing-status discard test',
      retryCommand: 'coral-cli backend routing-status discard',
    });
    try {
      await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path))).resolves.toEqual({
        kind: 'coordinator-running',
        socketPath: discardRuntime.paths.coral.coordinator.socketPath,
      });
    } finally {
      await socket.release();
    }

    const maintenance = await acquireGenerationMaintenanceLease(discardRuntime);
    let fastNow = discardRuntime.time.now();
    try {
      await expect(
        discardHandoffRoutingStatus(
          routingStatusOperatorOptions(
            {
              ...discardRuntime,
              time: {
                ...discardRuntime.time,
                now: () => fastNow,
                sleep: async (ms: number) => {
                  fastNow += ms;
                },
              },
            },
            path,
          ),
        ),
      ).resolves.toEqual({ kind: 'generation-maintenance-unavailable', cause: 'contended' });
    } finally {
      maintenance.release();
    }

    const ownershipLostRuntime = {
      ...discardRuntime,
      storage: {
        ...discardRuntime.storage,
        renameSync: (oldPath: string, newPath: string) => {
          if (newPath.includes('claim-refresh-')) throw new Error('injected maintenance lease loss');
          discardRuntime.storage.renameSync(oldPath, newPath);
        },
      },
      time: {
        ...discardRuntime.time,
        setInterval: (fn: () => void) => {
          fn();
          return {};
        },
        clearInterval: () => undefined,
      },
    };
    await expect(
      discardHandoffRoutingStatus(routingStatusOperatorOptions(ownershipLostRuntime, path)),
    ).resolves.toEqual({
      kind: 'generation-maintenance-unavailable',
      cause: 'ownership-lost',
    });

    const discarded = await discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path));
    expect(discarded).toMatchObject({
      kind: 'discarded',
      artifactPath: path,
      previousStatus: { kind: 'unreadable' },
    });
    if (discarded.kind !== 'discarded') throw new Error(`Expected discard, received ${discarded.kind}`);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(discarded.quarantinePath, 'utf-8')).toBe('not a sqlite database');
    expect(readFileSync(`${discarded.quarantinePath}-wal`, 'utf-8')).toBe('retained wal');
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(`${discarded.quarantinePath}-shm`)).toBe(false);

    await expect(publish(path, [selection('clean-generation', 1)])).resolves.toMatchObject({ kind: 'committed' });
    chmodSync(path, 0o000);
    try {
      if (process.platform !== 'win32') {
        await expect(
          discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path)),
        ).resolves.toMatchObject({
          kind: 'refused',
          status: { kind: 'undeterminable', cause: 'io-failed' },
        });
        expect(existsSync(path)).toBe(true);
      }
    } finally {
      chmodSync(path, 0o600);
    }
    await expect(
      discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path)),
    ).resolves.toMatchObject({
      kind: 'refused',
      status: { kind: 'current' },
    });
    expect(readHandoffRoutingStatus(path)).toMatchObject({
      kind: 'current',
      statuses: [{ selection: { invocationId: 'clean-generation' } }],
    });
  });

  it('surfaces an unobservable generation writer instead of collapsing it into maintenance contention', async () => {
    const path = databasePath();
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const pid = baseRuntime.env.pid();
    const incarnation = testIncarnation(pid);
    let now = baseRuntime.time.now();
    const writerRuntime: Runtime = {
      ...baseRuntime,
      env: {
        ...baseRuntime.env,
        platform: () => 'linux',
      },
      process: {
        ...baseRuntime.process,
        readProcessIncarnation: () => incarnation,
        observeLiveness: () => 'unknown',
      },
      time: {
        ...baseRuntime.time,
        now: () => now,
        sleep: async (milliseconds: number) => {
          now += milliseconds;
        },
      },
    };
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    const attempt = tryAcquireGenerationWriterLease(writerRuntime, {
      kind: 'routing-status',
      name: 'handoff-routing-status',
    });
    if (attempt.kind !== 'acquired') throw new Error(`Expected writer lease, received ${attempt.kind}`);
    try {
      await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(writerRuntime, path))).resolves.toEqual({
        kind: 'generation-maintenance-unavailable',
        cause: 'writer-observation-unknown',
        holder: `routing-status:handoff-routing-status (pid ${pid}), process identity unobservable`,
      });
    } finally {
      attempt.lease.release();
    }
  });

  it('keeps an interrupted wal move discoverable when source shm removal fails', async () => {
    const path = databasePath();
    const discardRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    writeFileSync(`${path}-wal`, 'retained wal');
    writeFileSync(`${path}-shm`, 'retained shm');
    const databaseBytes = readFileSync(path);
    const interruptedRuntime: Runtime = {
      ...discardRuntime,
      storage: {
        ...discardRuntime.storage,
        unlinkSync: (candidate) => {
          if (candidate === `${path}-shm`) throw new Error('injected shm removal failure');
          discardRuntime.storage.unlinkSync(candidate);
        },
      },
    };

    const interruptedResult = await discardHandoffRoutingStatus(routingStatusOperatorOptions(interruptedRuntime, path));
    expect(interruptedResult).toMatchObject({
      kind: 'quarantine-storage-failed',
      retainedArtifacts: ['wal'],
      movedArtifacts: ['wal'],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: [],
      syncedDirectories: ['source', 'quarantine'],
      cause: 'artifact-move-failed',
    });
    if (interruptedResult.kind !== 'quarantine-storage-failed') {
      throw new Error(`Expected partial quarantine, received ${interruptedResult.kind}`);
    }
    expect(existsSync(path)).toBe(true);
    const interrupted = listedQuarantines(discardRuntime.storage, path);
    expect(interrupted).toMatchObject({
      overflow: false,
      entries: [{ id: interruptedResult.quarantineId, state: 'incomplete', artifacts: ['wal'] }],
    });
    const incomplete = interrupted.entries[0];
    if (incomplete === undefined) throw new Error('Expected an incomplete quarantine.');

    const refused = await discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path));
    expect(refused).toEqual({ kind: 'incomplete-quarantine', quarantineId: incomplete.id });
    expect(readFileSync(path)).toEqual(databaseBytes);
    expect(readFileSync(`${incomplete.quarantinePath}-wal`, 'utf-8')).toBe('retained wal');
    expect(existsSync(`${path}-shm`)).toBe(true);
    expect(listHandoffRoutingStoreQuarantines(discardRuntime.storage, path)).toEqual(interrupted);

    await expect(
      clearHandoffRoutingStatusQuarantine(routingStatusOperatorOptions(discardRuntime, path), incomplete.id),
    ).resolves.toMatchObject({
      kind: 'cleared',
      entry: { id: incomplete.id },
    });
    expect(listHandoffRoutingStoreQuarantines(discardRuntime.storage, path)).toEqual({
      kind: 'listed',
      entries: [],
      overflow: false,
    });
  });

  it('reports the first move as observed when its source directory barrier fails', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000042';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    writeFileSync(`${path}-wal`, 'retained wal');
    writeFileSync(`${path}-shm`, 'retained shm');
    const sync = baseRuntime.storage.syncDirectoryDurableSync.bind(baseRuntime.storage);
    let walRemoved = false;
    const discardRuntime: Runtime = {
      ...baseRuntime,
      ids: { ...baseRuntime.ids, uuid: () => quarantineId },
      storage: {
        ...baseRuntime.storage,
        unlinkSync: (candidate) => {
          baseRuntime.storage.unlinkSync(candidate);
          if (candidate === `${path}-wal`) walRemoved = true;
        },
        syncDirectoryDurableSync: (directory) => {
          if (directory === dirname(path) && walRemoved) return false;
          return sync(directory);
        },
      },
    };

    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path))).resolves.toEqual({
      kind: 'quarantine-storage-failed',
      quarantineId,
      quarantinePath: join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`),
      retainedArtifacts: ['wal'],
      movedArtifacts: [],
      observedMovedArtifacts: ['wal'],
      removedArtifacts: [],
      observedRemovedArtifacts: [],
      syncedDirectories: ['source', 'quarantine'],
      cause: 'directory-sync-failed',
    });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(true);
    expect(listHandoffRoutingStoreQuarantines(baseRuntime.storage, path)).toMatchObject({
      entries: [{ id: quarantineId, state: 'incomplete', artifacts: ['wal'] }],
    });
  });

  it('reports source shm removal as observed when its directory barrier fails', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000043';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    writeFileSync(`${path}-wal`, 'retained wal');
    writeFileSync(`${path}-shm`, 'retained shm');
    const sync = baseRuntime.storage.syncDirectoryDurableSync.bind(baseRuntime.storage);
    let shmRemoved = false;
    const discardRuntime: Runtime = {
      ...baseRuntime,
      ids: { ...baseRuntime.ids, uuid: () => quarantineId },
      storage: {
        ...baseRuntime.storage,
        unlinkSync: (candidate) => {
          baseRuntime.storage.unlinkSync(candidate);
          if (candidate === `${path}-shm`) shmRemoved = true;
        },
        syncDirectoryDurableSync: (directory) => {
          if (directory === dirname(path) && shmRemoved) return false;
          return sync(directory);
        },
      },
    };

    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path))).resolves.toEqual({
      kind: 'quarantine-storage-failed',
      quarantineId,
      quarantinePath: join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`),
      retainedArtifacts: ['wal'],
      movedArtifacts: ['wal'],
      observedMovedArtifacts: [],
      removedArtifacts: [],
      observedRemovedArtifacts: ['shm'],
      syncedDirectories: ['source', 'quarantine'],
      cause: 'directory-sync-failed',
    });
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(listHandoffRoutingStoreQuarantines(baseRuntime.storage, path)).toMatchObject({
      entries: [{ id: quarantineId, state: 'incomplete', artifacts: ['wal'] }],
    });
  });

  it('reports the first clear removal as observed when its directory barrier fails', async () => {
    const path = databasePath();
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    writeFileSync(`${path}-wal`, 'retained wal');
    writeFileSync(`${path}-shm`, 'retained shm');
    const discarded = await discardHandoffRoutingStatus(routingStatusOperatorOptions(baseRuntime, path));
    if (discarded.kind !== 'discarded') throw new Error(`Expected discard, received ${discarded.kind}`);
    const retained = listedQuarantines(baseRuntime.storage, path).entries[0];
    if (retained === undefined) throw new Error('Expected retained quarantine.');
    const sync = baseRuntime.storage.syncDirectoryDurableSync.bind(baseRuntime.storage);
    let quarantineSyncFailed = false;
    const clearRuntime: Runtime = {
      ...baseRuntime,
      storage: {
        ...baseRuntime.storage,
        syncDirectoryDurableSync: (directory) => {
          if (!quarantineSyncFailed && directory === dirname(retained.quarantinePath)) {
            quarantineSyncFailed = true;
            return false;
          }
          return sync(directory);
        },
      },
    };

    await expect(
      clearHandoffRoutingStatusQuarantine(routingStatusOperatorOptions(clearRuntime, path), retained.id),
    ).resolves.toEqual({
      kind: 'quarantine-clear-storage-failed',
      quarantineId: retained.id,
      quarantinePath: retained.quarantinePath,
      removedArtifacts: [],
      observedRemovedArtifacts: ['wal'],
      syncedDirectories: [],
      cause: 'directory-sync-failed',
    });
    expect(listHandoffRoutingStoreQuarantines(baseRuntime.storage, path)).toMatchObject({
      entries: [{ id: retained.id, state: 'complete', artifacts: ['database'] }],
    });

    await expect(
      clearHandoffRoutingStatusQuarantine(routingStatusOperatorOptions(baseRuntime, path), retained.id),
    ).resolves.toMatchObject({ kind: 'cleared', entry: { id: retained.id } });
  });

  it('does not return clear success when ownership is lost during the final directory sync', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000054';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    mkdirSync(dirname(quarantinePath), { recursive: true, mode: 0o700 });
    writeFileSync(quarantinePath, 'retained database');
    writeFileSync(`${quarantinePath}-wal`, 'retained wal');
    let databaseRemoved = false;
    let ownershipLost = false;
    const storage: StoragePort = {
      ...baseRuntime.storage,
      unlinkSync: (candidate) => {
        baseRuntime.storage.unlinkSync(candidate);
        if (candidate === quarantinePath) databaseRemoved = true;
      },
      syncDirectoryDurableSync: (directory) => {
        const synced = baseRuntime.storage.syncDirectoryDurableSync(directory);
        if (directory === dirname(quarantinePath) && databaseRemoved) ownershipLost = true;
        return synced;
      },
    };

    expect(
      clearHandoffRoutingStoreQuarantine(storage, path, quarantineId, () => {
        if (ownershipLost) throw new DirectoryLockOwnershipLostError('/generation-maintenance');
      }),
    ).toEqual({
      kind: 'quarantine-clear-storage-failed',
      quarantineId,
      quarantinePath,
      removedArtifacts: ['wal', 'database'],
      observedRemovedArtifacts: [],
      syncedDirectories: ['quarantine'],
      cause: 'ownership-lost',
    });
    expect(existsSync(quarantinePath)).toBe(false);
    expect(existsSync(`${quarantinePath}-wal`)).toBe(false);
  });

  it('refuses another discard when retained quarantine reaches its explicit ceiling', async () => {
    const path = databasePath();
    const discardRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantineRoot = join(dirname(path), 'handoff-routing-quarantine');
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    for (let index = 0; index < MAX_HANDOFF_ROUTING_STATUS_QUARANTINES; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      writeFileSync(join(quarantineRoot, `${basename(path)}.${id}`), 'retained evidence');
    }
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });

    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path))).resolves.toEqual({
      kind: 'quarantine-capacity-exhausted',
      maximum: MAX_HANDOFF_ROUTING_STATUS_QUARANTINES,
    });
    expect(existsSync(path)).toBe(true);
    const retained = listedQuarantines(discardRuntime.storage, path);
    expect(retained.overflow).toBe(false);
    expect(retained.entries).toHaveLength(MAX_HANDOFF_ROUTING_STATUS_QUARANTINES);
  });

  it('reports an unreadable quarantine root and refuses capacity admission on that unknown listing', async () => {
    const path = databasePath();
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const root = join(dirname(path), 'handoff-routing-quarantine');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    const statSyncWithUnreadableRoot = ((candidate: string, options?: { bigint: true }) => {
      if (candidate === root) {
        const error = new Error('injected quarantine root stat failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        error.errno = SQLITE_FULL;
        throw error;
      }
      return options === undefined
        ? baseRuntime.storage.statSync(candidate)
        : baseRuntime.storage.statSync(candidate, options);
    }) as StoragePort['statSync'];
    let artifactLinkAttempted = false;
    const unreadableRuntime: Runtime = {
      ...baseRuntime,
      storage: {
        ...baseRuntime.storage,
        statSync: statSyncWithUnreadableRoot,
        linkSync: (source, destination) => {
          if (source === path || source === `${path}-wal`) artifactLinkAttempted = true;
          baseRuntime.storage.linkSync(source, destination);
        },
      },
    };
    const undeterminable = {
      kind: 'undeterminable' as const,
      cause: 'root-observation-failed' as const,
      errcode: SQLITE_FULL,
    };

    expect(listHandoffRoutingStoreQuarantines(unreadableRuntime.storage, path)).toEqual(undeterminable);
    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(unreadableRuntime, path))).resolves.toEqual(
      undeterminable,
    );
    expect(artifactLinkAttempted).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('returns an undeterminable clear result when a retained artifact cannot be observed', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000048';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    mkdirSync(dirname(quarantinePath), { recursive: true, mode: 0o700 });
    writeFileSync(quarantinePath, 'retained database');
    const statSyncWithUnreadableArtifact = ((candidate: string, options?: { bigint: true }) => {
      if (candidate === quarantinePath) {
        const error = new Error('injected quarantine artifact stat failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        error.errno = SQLITE_FULL;
        throw error;
      }
      return options === undefined
        ? baseRuntime.storage.statSync(candidate)
        : baseRuntime.storage.statSync(candidate, options);
    }) as StoragePort['statSync'];
    const unreadableRuntime: Runtime = {
      ...baseRuntime,
      storage: { ...baseRuntime.storage, statSync: statSyncWithUnreadableArtifact },
    };

    await expect(
      clearHandoffRoutingStatusQuarantine(routingStatusOperatorOptions(unreadableRuntime, path), quarantineId),
    ).resolves.toEqual({
      kind: 'quarantine-clear-undeterminable',
      quarantineId,
      quarantinePath,
      artifact: 'database',
      errcode: SQLITE_FULL,
    });
    expect(readFileSync(quarantinePath, 'utf-8')).toBe('retained database');
  });

  it('bounds quarantine scans for two retained artifacts per entry plus overflow detection', () => {
    const path = databasePath();
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantineRoot = join(dirname(path), 'handoff-routing-quarantine');
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    const readDirectoryBoundedSync = vi.fn(() => ({ entries: [], overflow: false }));

    listHandoffRoutingStoreQuarantines({ ...baseRuntime.storage, readDirectoryBoundedSync }, path);

    expect(readDirectoryBoundedSync).toHaveBeenCalledWith(quarantineRoot, 33);
  });

  it('does not recognize or clear unsupported legacy retained shm files', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000045';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    mkdirSync(dirname(quarantinePath), { recursive: true, mode: 0o700 });
    writeFileSync(quarantinePath, 'database');
    writeFileSync(`${quarantinePath}-wal`, 'wal');
    writeFileSync(`${quarantinePath}-shm`, 'unsupported legacy shm');

    expect(listHandoffRoutingStoreQuarantines(baseRuntime.storage, path)).toMatchObject({
      entries: [{ id: quarantineId, state: 'complete', artifacts: ['database', 'wal'] }],
    });
    await expect(
      clearHandoffRoutingStatusQuarantine(routingStatusOperatorOptions(baseRuntime, path), quarantineId),
    ).resolves.toMatchObject({
      kind: 'cleared',
      entry: { artifacts: ['database', 'wal'] },
    });
    expect(existsSync(`${quarantinePath}-shm`)).toBe(true);
    expect(listHandoffRoutingStoreQuarantines(baseRuntime.storage, path)).toEqual({
      kind: 'listed',
      entries: [],
      overflow: false,
    });
  });

  it('revalidates maintenance ownership after the guarded journal read', async () => {
    const path = databasePath();
    const discardRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const boundary = resolveGenerationBoundaryPaths(discardRuntime);
    writeFileSync(path, 'not a sqlite database', { mode: 0o600 });
    let guardedJournalReadCompleted = false;
    const generateQuarantineId = vi.fn(() => '00000000-0000-4000-8000-000000000062');
    const ownershipLostRuntime: Runtime = {
      ...discardRuntime,
      ids: { ...discardRuntime.ids, uuid: generateQuarantineId },
      storage: {
        ...discardRuntime.storage,
        openSqliteDatabaseSync: (databasePath, options): SqliteDatabasePort => {
          const database = discardRuntime.storage.openSqliteDatabaseSync(databasePath, options);
          if (!existsSync(boundary.maintenanceLock)) return database;
          return {
            exec: database.exec.bind(database),
            prepare: database.prepare.bind(database),
            close: () => {
              database.close();
              guardedJournalReadCompleted = true;
              discardRuntime.storage.rmSync(boundary.maintenanceLock, { recursive: true, force: true });
            },
          };
        },
      },
    };

    await expect(
      discardHandoffRoutingStatus(routingStatusOperatorOptions(ownershipLostRuntime, path)),
    ).resolves.toEqual({
      kind: 'generation-maintenance-unavailable',
      cause: 'ownership-lost',
    });
    expect(existsSync(path)).toBe(true);
    expect(guardedJournalReadCompleted).toBe(true);
    expect(generateQuarantineId).not.toHaveBeenCalled();
    expect(listHandoffRoutingStoreQuarantines(discardRuntime.storage, path)).toEqual({
      kind: 'listed',
      entries: [],
      overflow: false,
    });
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
      const forgedRetirement = handoffRoutingRecordSchemaRegistry.retirement.parse({
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
      const contradictoryTerminal = handoffRoutingRecordSchemaRegistry.terminal.parse({
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

  it.each([
    ['probe-not-available', 0],
    ['probe-failed', 75],
  ] as const)('maps unresolved owner cause %s to exit contribution %s', async (cause, exitContribution) => {
    const path = databasePath();
    await committed(path, [selection('owner-probe', 1)]);
    const observationRuntime: Runtime = {
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'unobservable' as const, cause } })),
      },
    };

    const result = await readHandoffRoutingStatusWithOwnerObservations(observationRuntime, path);
    expect(handoffRoutingStatusExitContribution(result)).toBe(exitContribution);
  });

  it.each([
    {
      name: 'handoff-abandoned-stdout',
      retainSelection: true,
      transitionDisposition: { kind: 'continued-current', reason: { kind: 'handoff-abandoned-stdout' } },
      durableDisposition: { kind: 'continued-current', reason: { kind: 'handoff-abandoned-stdout' } },
      rendered:
        'Routing invocation handoff-abandoned-stdout: terminal; continued current after stdout drain prevented delegation.',
      exitContribution: 0,
    },
    {
      name: 'delegated-signal',
      retainSelection: true,
      transitionDisposition: { kind: 'delegated-signal', version: '0.10.9', signal: 'SIGTERM' },
      durableDisposition: { kind: 'delegated-signal', version: '0.10.9', signal: 'SIGTERM' },
      rendered: 'Routing invocation delegated-signal: terminal; delegated to 0.10.9, which exited on SIGTERM.',
      exitContribution: 0,
    },
    {
      name: 'finalized-without-selection',
      retainSelection: false,
      transitionDisposition: { kind: 'delegated-success', version: '0.10.9' },
      durableDisposition: {
        kind: 'finalized-without-selection',
        terminal: { kind: 'delegated-success', version: '0.10.9' },
      },
      rendered:
        'Routing invocation finalized-without-selection: terminal; delegated successfully to 0.10.9 without a retained selection.',
      exitContribution: 0,
    },
  ] as const)(
    'round-trips $name from the durable record through status rendering and exit policy',
    async ({ name, retainSelection, transitionDisposition, durableDisposition, rendered, exitContribution }) => {
      const path = databasePath();
      const selected = retainSelection
        ? await committed(path, [
            handoffRoutingTransitionSchema.parse({
              kind: 'routing-selected',
              eventId: `${name}-selection`,
              invocationId: name,
              observedAt: at(1),
              owner: OWNER,
              disposition: {
                kind: 'continue-current',
                basis: { kind: 'same-build-set', buildSetId: BUILD_SET_ID },
              },
            }),
          ])
        : null;
      await committed(path, [
        handoffRoutingTransitionSchema.parse({
          kind: 'continuation-finalized',
          eventId: `${name}-terminal`,
          invocationId: name,
          observedAt: at(2),
          selection:
            selected === null
              ? { kind: 'without-selection' }
              : { kind: 'with-selection-sequence', selectionSequence: selected.sequence },
          disposition: transitionDisposition,
        }),
      ]);

      const durable = handoffRoutingRecordSchemaRegistry.terminal.parse(
        records(path).find((record) => record.eventKind === 'continuation-finalized'),
      );
      expect(durable.disposition).toEqual(durableDisposition);

      const result = readHandoffRoutingStatus(path);
      expect(result).toMatchObject({
        kind: 'current',
        statuses: [
          {
            kind: 'terminal',
            selection: retainSelection ? { invocationId: name } : null,
            terminal: { invocationId: name, disposition: durableDisposition },
          },
        ],
      });
      expect(formatHandoffRoutingStatus(result)).toBe(rendered);
      expect(handoffRoutingStatusExitContribution(result)).toBe(exitContribution);
    },
  );

  it('renders a failed-without-selection terminal as history that resolve cannot change', async () => {
    const path = databasePath();
    const invocationId = '123e4567-e89b-42d3-a456-426614174009';
    await committed(path, [
      {
        kind: 'execution-failed',
        eventId: 'failed-without-selection-terminal',
        invocationId,
        observedAt: at(1),
        selection: { kind: 'without-selection' },
        disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
      },
    ]);

    const result = readHandoffRoutingStatus(path);
    expect(formatHandoffRoutingStatus(result)).toBe(
      `Routing invocation ${invocationId}: terminal; execution failed during child-spawn without a retained selection.`,
    );
    expect(handoffRoutingStatusExitContribution(result)).toBe(0);
    await expect(
      resolveHandoffRoutingStatus(runtime, path, { invocationId, forceUnobservable: false }),
    ).resolves.toEqual({ kind: 'already-terminal', invocationId });
  });

  it('renders a completed warning routing basis without gating the current status exit', async () => {
    const path = databasePath();
    const invocationId = 'historical-health-shape-rejected';
    const basis = { kind: 'incumbent-unresolved', cause: 'health-shape-rejected' } as const;
    const selected = await committed(path, [selection(invocationId, 1, basis)]);
    await committed(path, [
      {
        kind: 'continuation-finalized',
        eventId: `${invocationId}-terminal`,
        invocationId,
        observedAt: at(2),
        selection: { kind: 'with-selection-sequence', selectionSequence: selected.sequence },
        disposition: { kind: 'continued-current', reason: { kind: 'routing', basis } },
      },
    ]);

    const result = readHandoffRoutingStatus(path);
    expect(formatHandoffRoutingStatus(result)).toContain('continued current (incumbent-unresolved)');
    expect(handoffRoutingStatusExitContribution(result)).toBe(0);
  });

  it('returns distinct absent, foreign, schema-divergent, unreadable, and I/O-failure results', async () => {
    const absentPath = databasePath();
    expect(readHandoffRoutingStatus(absentPath)).toEqual({ kind: 'absent' });

    const unsupportedPath = databasePath();
    const unsupported = new DatabaseSync(unsupportedPath);
    unsupported.exec(`PRAGMA user_version=${HANDOFF_ROUTING_STATUS_GENERATION + 1}`);
    unsupported.close();
    expect(readHandoffRoutingStatus(unsupportedPath)).toEqual({
      kind: 'foreign-generation',
      generation: HANDOFF_ROUTING_STATUS_GENERATION + 1,
    });

    const unsupportedShapePath = databasePath();
    const unsupportedShape = new DatabaseSync(unsupportedShapePath);
    unsupportedShape.exec(`
      CREATE TABLE handoff_routing_records (sequence INTEGER PRIMARY KEY, body_json TEXT NOT NULL) STRICT;
      PRAGMA user_version=${HANDOFF_ROUTING_STATUS_GENERATION};
    `);
    unsupportedShape.close();
    expect(readHandoffRoutingStatus(unsupportedShapePath)).toEqual({
      kind: 'schema-divergent',
    });
    await expect(publish(unsupportedShapePath, [selection('unsupported-shape', 1)])).resolves.toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'schema-divergent' },
    });

    const invalidJsonPath = databasePath();
    await createReadFixtureDatabase(invalidJsonPath, [{ recordKind: 'selection', bodyJson: '{' }]);
    expect(readHandoffRoutingStatus(invalidJsonPath)).toEqual({ kind: 'unreadable', reason: 'invalid-json' });

    const invalidShapePath = databasePath();
    await createReadFixtureDatabase(invalidShapePath, [{ recordKind: 'selection', bodyJson: '{}' }]);
    expect(readHandoffRoutingStatus(invalidShapePath)).toEqual({ kind: 'unreadable', reason: 'invalid-shape' });

    const tooLargePath = databasePath();
    await createReadFixtureDatabase(tooLargePath, [
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
      kind: 'artifact-refused',
      classification: { kind: 'unreadable', reason: 'invalid-shape' },
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
    const path = join(directory, `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`);

    await expect(publish(path, [])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    expect(existsSync(directory)).toBe(false);
  });

  it('returns a decisive invalid-record outcome when the production body validator rejects an append', async () => {
    const path = databasePath();
    await committed(path, [selection('valid-record', 1)]);
    const before = records(path);
    const stringifyJson = JSON.stringify;
    const stringify = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value) =>
        typeof value === 'object' && value !== null && 'eventId' in value && value.eventId === 'event-2'
          ? '{'
          : stringifyJson(value),
      );
    const outcome = await publish(path, [selection('malformed-record', 2)]).finally(() => stringify.mockRestore());

    expect(outcome).toEqual({
      kind: 'not-published',
      cause: 'invalid-record',
      validation: { kind: 'malformed-json' },
    });
    expect(outcome.kind).not.toBe('commit-outcome-unknown');
    expect(outcome).not.toMatchObject({ cause: 'storage-corrupt' });
    expect(records(path)).toEqual(before);
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
      ...runtime.time,
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
        publishGenerationCoordinatedHandoffRoutingTransitions({ ...runtime, time: jumpingWallClock }, path, [
          selection('monotonic-contender', 2),
        ]),
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

  it('attributes domain conflicts before SQLite and rejects an unexpected trigger as another schema', async () => {
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
      kind: 'artifact-refused',
      classification: { kind: 'schema-divergent' },
    });
  });

  it('treats generation-matching content corruption as unreadable', async () => {
    const path = databasePath();
    await committed(path, [selection('seed', 1)]);
    const db = new DatabaseSync(path);
    try {
      db.exec('DELETE FROM handoff_routing_metadata');
    } finally {
      db.close();
    }

    await expect(publish(path, [selection('next', 2)])).resolves.toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'unreadable', reason: 'invalid-shape' },
    });
  });

  it('treats a generation-matching artifact with a dropped table as schema-divergent', async () => {
    const path = databasePath();
    await committed(path, [selection('seed', 1)]);
    const db = new DatabaseSync(path);
    try {
      db.exec('DROP TABLE handoff_routing_metadata');
    } finally {
      db.close();
    }

    expect(readHandoffRoutingStatus(path)).toEqual({
      kind: 'schema-divergent',
    });
    await expect(publish(path, [selection('next', 2)])).resolves.toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'schema-divergent' },
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
          handoffRoutingRecordSchemaRegistry.retirement.parse({
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

  it('distinguishes foreign, corrupt, and capacity-exhausted stores by outcome', async () => {
    const unsupportedPath = databasePath();
    await committed(unsupportedPath, [selection('supported', 1)]);
    const unsupported = new DatabaseSync(unsupportedPath);
    unsupported.exec(`PRAGMA user_version=${HANDOFF_ROUTING_STATUS_GENERATION + 1}`);
    unsupported.close();
    await expect(publish(unsupportedPath, [selection('next', 2)])).resolves.toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'foreign-generation', generation: HANDOFF_ROUTING_STATUS_GENERATION + 1 },
    });

    const corruptPath = databasePath();
    writeFileSync(corruptPath, 'not a sqlite database');
    await expect(publish(corruptPath, [selection('corrupt', 3)])).resolves.toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'unreadable', reason: 'invalid-shape' },
    });

    const fullPath = databasePath();
    await committed(fullPath, [selection('seed', 4)]);
    const full = new DatabaseSync(fullPath);
    try {
      full.exec('PRAGMA synchronous=OFF');
      full.exec(`PRAGMA max_page_count=${MAX_HANDOFF_ROUTING_STATUS_BYTES / 4096}`);
      const insert = full.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
      const padding = 'x'.repeat(MAX_LEGAL_CLOSING_RECORD_BYTES);
      let index = 0;
      while (true) {
        insert.run(`padding-${index}-${padding}`, index);
        index += 1;
      }
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

  it.each([
    ['BEGIN IMMEDIATE', { kind: 'not-published', cause: 'capacity-exhausted' }],
    ['COMMIT', { kind: 'commit-outcome-unknown', cause: 'capacity-exhausted', errcode: SQLITE_FULL }],
  ] as const)('uses the COMMIT attempt boundary when SQLITE_FULL is raised by %s', async (statement, expected) => {
    const path = databasePath();
    const failingRuntime = { ...runtime, storage: storageFailingOnSqliteStatement(runtime.storage, statement) };

    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(failingRuntime, path, [
        selection(`full-at-${statement}`, 1),
      ]),
    ).resolves.toEqual(expected);
  });

  it('maps corruption raised after locked admission to storage-corrupt', async () => {
    const path = databasePath();
    await committed(path, [selection('corrupt-after-admission-seed', 1)]);
    const failingRuntime = {
      ...runtime,
      storage: storageFailingOnSqliteRun(
        runtime.storage,
        'INSERT INTO handoff_routing_closing_reserve',
        SQLITE_CORRUPT,
      ),
    };

    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(failingRuntime, path, [
        selection('corrupt-after-admission', 2),
      ]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'storage-corrupt' });
  });

  it('maps corruption raised after commit starts to an unknown commit outcome', async () => {
    const path = databasePath();
    const failingRuntime = {
      ...runtime,
      storage: storageFailingOnSqliteStatement(runtime.storage, 'COMMIT', SQLITE_CORRUPT),
    };

    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(failingRuntime, path, [
        selection('corrupt-commit-outcome', 1),
      ]),
    ).resolves.toEqual({
      kind: 'commit-outcome-unknown',
      cause: 'storage-corrupt',
      errcode: SQLITE_CORRUPT,
    });
  });

  it('assigns total policy to repair, gap, rollup, and lifecycle dispositions', () => {
    expect(
      persistedHandoffDispositionPolicy({ kind: 'selection-evicted-at-capacity', terminalExisted: false }),
    ).toEqual({
      durability: 'lifecycle-journal',
      retention: 'bounded-history',
      severity: 'warning',
      classification: 'hold',
      exitContribution: 75,
    });
    expect(persistedHandoffDispositionPolicy({ kind: 'operator-resolved', terminalExisted: false })).toEqual({
      durability: 'lifecycle-journal',
      retention: 'bounded-history',
      severity: 'info',
      classification: 'history',
      exitContribution: 0,
    });
    expect(
      persistedHandoffDispositionPolicy({ kind: 'failed-without-selection', throwPhase: 'child-spawn' }),
    ).toMatchObject({ severity: 'warning', classification: 'history', exitContribution: 0 });
    expect(
      persistedHandoffDispositionPolicy({
        kind: 'finalized-without-selection',
        terminal: { kind: 'delegated-success', version: '0.10.9' },
      }),
    ).toMatchObject({ severity: 'warning', classification: 'history', exitContribution: 0 });
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
    ).toMatchObject({ severity: 'info', classification: 'history', exitContribution: 0 });
  });

  it('keeps a warning routing basis actionable while selected but historical after its terminal', () => {
    const basis = { kind: 'incumbent-unresolved', cause: 'health-shape-rejected' } as const;

    expect(persistedHandoffDispositionPolicy({ kind: 'continue-current', basis })).toMatchObject({
      severity: 'warning',
      classification: 'hold',
      exitContribution: 75,
    });
    expect(
      persistedHandoffDispositionPolicy({
        kind: 'continued-current',
        reason: { kind: 'routing', basis },
      }),
    ).toMatchObject({ severity: 'warning', classification: 'history', exitContribution: 0 });
  });

  it('resolves only absent owners and returns typed stale, terminal, and live refusals', async () => {
    const absentId = '123e4567-e89b-42d3-a456-426614174001';
    const liveId = '123e4567-e89b-42d3-a456-426614174002';
    const terminalId = '123e4567-e89b-42d3-a456-426614174003';
    const staleId = '123e4567-e89b-42d3-a456-426614174004';
    const reusedId = '123e4567-e89b-42d3-a456-426614174007';
    const path = databasePath();
    const absentSelection = await committed(path, [selection(absentId, 1)]);
    await committed(path, [selection(liveId, 2)]);
    const terminalSelection = await committed(path, [selection(terminalId, 3)]);
    await committed(path, [terminal(terminalId, 4, terminalSelection.sequence)]);
    await committed(path, [selection(reusedId, 5)]);

    const repairRuntime = (evidence: ProcessIdentityObservation['evidence']) => ({
      ...runtime,
      process: {
        ...runtime.process,
        readProcessIncarnation: (pid: number, platform: NodeJS.Platform) => {
          if (pid === runtime.env.pid()) return runtime.process.readProcessIncarnation(pid, platform);
          throw new Error('repair must use the batch observer for record owners');
        },
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence })),
      },
    });

    await expect(
      resolveHandoffRoutingStatus(repairRuntime({ kind: 'pid-absent' }), path, {
        invocationId: staleId,
        forceUnobservable: false,
      }),
    ).resolves.toEqual({ kind: 'stale', invocationId: staleId });
    await expect(
      resolveHandoffRoutingStatus(repairRuntime({ kind: 'pid-absent' }), path, {
        invocationId: terminalId,
        forceUnobservable: false,
      }),
    ).resolves.toEqual({ kind: 'already-terminal', invocationId: terminalId });
    await expect(
      resolveHandoffRoutingStatus(repairRuntime({ kind: 'incarnation', incarnation: OWNER.incarnation }), path, {
        invocationId: liveId,
        forceUnobservable: false,
      }),
    ).resolves.toEqual({ kind: 'live-owner', invocationId: liveId });

    const resolved = await resolveHandoffRoutingStatus(repairRuntime({ kind: 'pid-absent' }), path, {
      invocationId: absentId,
      forceUnobservable: false,
    });
    expect(resolved).toMatchObject({
      kind: 'resolved',
      invocationId: absentId,
      reason: 'owner-absent',
    });
    expect(absentSelection.sequence).toBeGreaterThan(0);
    await expect(
      resolveHandoffRoutingStatus(repairRuntime({ kind: 'incarnation', incarnation: testIncarnation(999) }), path, {
        invocationId: reusedId,
        forceUnobservable: false,
      }),
    ).resolves.toMatchObject({ kind: 'resolved', invocationId: reusedId, reason: 'owner-absent' });
    const status = readHandoffRoutingStatus(path);
    expect(status.kind).toBe('current');
    if (status.kind !== 'current') throw new Error(`Expected current status, received ${status.kind}`);
    expect(
      status.statuses.find(
        (candidate) => candidate.kind === 'retired' && candidate.tombstone.invocationId === absentId,
      ),
    ).toMatchObject({
      kind: 'retired',
      tombstone: {
        invocationId: absentId,
        retirementCause: 'operator-resolved',
        resolutionReason: 'owner-absent',
      },
    });
    expect(handoffRoutingStatusExitContribution(status)).toBe(0);
  });

  it('acknowledges an exact capacity eviction through routing-status resolve', async () => {
    const path = databasePath();
    await committed(
      path,
      Array.from({ length: MAX_UNRESOLVED_INVOCATIONS + 1 }, (_, index) =>
        selection(`capacity-opening-${index}`, index + 1),
      ),
    );
    const repairRuntime = {
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' as const } })),
      },
    };

    await expect(
      resolveHandoffRoutingStatus(repairRuntime, path, {
        invocationId: 'capacity-opening-0',
        forceUnobservable: false,
      }),
    ).resolves.toEqual({
      kind: 'acknowledged-capacity-eviction',
      invocationId: 'capacity-opening-0',
      selectionSequence: 1,
    });

    const status = readHandoffRoutingStatus(path);
    expect(status).toMatchObject({
      kind: 'current',
      retirementHistoryTruncated: {
        expiredIdentityCount: 1,
        causes: { 'selection-evicted-at-capacity': 1 },
      },
    });
    if (status.kind !== 'current') throw new Error(`Expected current status, received ${status.kind}`);
    expect(status.statuses.some((candidate) => candidate.kind === 'retired')).toBe(false);
    expect(handoffRoutingStatusExitContribution(status)).toBe(0);
  });

  it('preserves an unknown operator-resolution commit at the resolve boundary', async () => {
    const invocationId = '123e4567-e89b-42d3-a456-426614174009';
    const path = databasePath();
    await committed(path, [selection(invocationId, 1)]);
    const repairRuntime = {
      ...runtime,
      storage: storageFailingOnSqliteStatement(runtime.storage, 'COMMIT'),
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' as const } })),
      },
    };

    await expect(
      resolveHandoffRoutingStatus(repairRuntime, path, {
        invocationId,
        forceUnobservable: false,
      }),
    ).resolves.toEqual({
      kind: 'commit-outcome-unknown',
      invocationId,
      cause: 'capacity-exhausted',
      errcode: SQLITE_FULL,
    });
  });

  it('preserves an unknown capacity-acknowledgement commit at the resolve boundary', async () => {
    const invocationId = 'capacity-opening-0';
    const path = databasePath();
    await committed(
      path,
      Array.from({ length: MAX_UNRESOLVED_INVOCATIONS + 1 }, (_, index) =>
        selection(`capacity-opening-${index}`, index + 1),
      ),
    );
    const repairRuntime = {
      ...runtime,
      storage: storageFailingOnSqliteStatement(runtime.storage, 'COMMIT'),
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' as const } })),
      },
    };

    await expect(
      resolveHandoffRoutingStatus(repairRuntime, path, {
        invocationId,
        forceUnobservable: false,
      }),
    ).resolves.toEqual({
      kind: 'commit-outcome-unknown',
      invocationId,
      cause: 'capacity-exhausted',
      errcode: SQLITE_FULL,
    });
  });

  it('refuses operator resolution while generation maintenance is held', async () => {
    const invocationId = '123e4567-e89b-42d3-a456-426614174008';
    const path = databasePath();
    await committed(path, [selection(invocationId, 1)]);
    const repairRuntime = {
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' as const } })),
      },
    };
    const maintenance = await acquireGenerationMaintenanceLease(repairRuntime);
    try {
      await expect(
        resolveHandoffRoutingStatus(repairRuntime, path, {
          invocationId,
          forceUnobservable: false,
        }),
      ).resolves.toEqual({
        kind: 'not-published',
        invocationId,
        cause: 'generation-maintenance',
      });
      expect(readHandoffRoutingStatus(path)).toMatchObject({
        kind: 'current',
        statuses: [{ kind: 'unresolved', selection: { invocationId } }],
      });
    } finally {
      maintenance.release();
    }
  });

  it('reports a coordination-root I/O failure without calling it contention', async () => {
    const path = databasePath();
    const writersRoot = resolveGenerationBoundaryPaths(runtime).writersRoot;
    const failedStorage = {
      ...runtime.storage,
      mkdirSync: (candidate: string, options?: { recursive?: boolean; mode?: number }) => {
        if (candidate === writersRoot) {
          throw Object.assign(new Error('coordination root is not writable'), { code: 'EACCES' });
        }
        runtime.storage.mkdirSync(candidate, options);
      },
    };

    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions({ ...runtime, storage: failedStorage }, path, [
        selection('coordination-io-failure', 1),
      ]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'coordination-unavailable' });
  });

  it('retries generation admission contention within the publication deadline', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-admission-retry-'));
    temporaryDirectories.push(baseDir);
    const isolatedRuntime = createRealRuntime('prod', { baseDir });
    const paths = resolveGenerationBoundaryPaths(isolatedRuntime);
    mkdirSync(paths.coordinationRoot, { recursive: true });
    const releaseAdmission = tryAcquireDirectoryLock(paths.admissionLock);
    if (releaseAdmission === null) throw new Error('Expected admission lock');
    let released = false;
    const retryRuntime: Runtime = {
      ...isolatedRuntime,
      time: {
        ...isolatedRuntime.time,
        sleep: async () => {
          if (released) return;
          released = true;
          releaseAdmission();
        },
      },
    };
    try {
      await expect(
        publishGenerationCoordinatedHandoffRoutingTransitions(
          retryRuntime,
          join(
            isolatedRuntime.paths.coral.coordinator.runDir,
            `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`,
          ),
          [selection('admission-retried', 1)],
        ),
      ).resolves.toMatchObject({ kind: 'committed' });
    } finally {
      if (!released) releaseAdmission();
    }
  });

  it('returns generation maintenance when maintenance wins an admission retry', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-maintenance-retry-'));
    temporaryDirectories.push(baseDir);
    const isolatedRuntime = createRealRuntime('prod', { baseDir });
    const paths = resolveGenerationBoundaryPaths(isolatedRuntime);
    mkdirSync(paths.coordinationRoot, { recursive: true });
    const releaseAdmission = tryAcquireDirectoryLock(paths.admissionLock);
    if (releaseAdmission === null) throw new Error('Expected admission lock');
    let maintenance: Awaited<ReturnType<typeof acquireGenerationMaintenanceLease>> | undefined;
    let admissionReleased = false;
    const retryRuntime: Runtime = {
      ...isolatedRuntime,
      time: {
        ...isolatedRuntime.time,
        sleep: async () => {
          if (admissionReleased) return;
          admissionReleased = true;
          releaseAdmission();
          maintenance = await acquireGenerationMaintenanceLease(isolatedRuntime);
        },
      },
    };
    try {
      await expect(
        publishGenerationCoordinatedHandoffRoutingTransitions(
          retryRuntime,
          join(
            isolatedRuntime.paths.coral.coordinator.runDir,
            `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`,
          ),
          [selection('maintenance-won-admission', 1)],
        ),
      ).resolves.toEqual({ kind: 'not-published', cause: 'generation-maintenance' });
    } finally {
      if (!admissionReleased) releaseAdmission();
      maintenance?.release();
    }
  });

  it('returns contention only after generation admission spends the publication budget', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-admission-timeout-'));
    temporaryDirectories.push(baseDir);
    const isolatedRuntime = createRealRuntime('prod', { baseDir });
    const paths = resolveGenerationBoundaryPaths(isolatedRuntime);
    mkdirSync(paths.coordinationRoot, { recursive: true });
    const releaseAdmission = tryAcquireDirectoryLock(paths.admissionLock);
    if (releaseAdmission === null) throw new Error('Expected admission lock');
    let monotonicNow = 0n;
    const retryRuntime: Runtime = {
      ...isolatedRuntime,
      time: {
        ...isolatedRuntime.time,
        monotonicNow: () => monotonicNow,
        sleep: async (milliseconds: number) => {
          monotonicNow += BigInt(milliseconds * 100);
        },
      },
    };
    try {
      await expect(
        publishGenerationCoordinatedHandoffRoutingTransitions(
          retryRuntime,
          join(
            isolatedRuntime.paths.coral.coordinator.runDir,
            `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`,
          ),
          [selection('admission-timeout', 1)],
        ),
      ).resolves.toEqual({ kind: 'not-published', cause: 'contended' });
    } finally {
      releaseAdmission();
    }
  });

  it('resolves a lost writer lease as coordination unavailable', async () => {
    const path = databasePath();
    const failedStorage = {
      ...runtime.storage,
      renameSync: (oldPath: string, newPath: string) => {
        if (newPath.includes('claim-refresh-')) {
          throw Object.assign(new Error('writer lease refresh failed'), { code: 'EIO' });
        }
        runtime.storage.renameSync(oldPath, newPath);
      },
    };

    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions({ ...runtime, storage: failedStorage }, path, [
        selection('lost-writer-lease', 1),
      ]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'coordination-unavailable' });
  });

  it('requires force for unobservable owners and never lets force override an expired deadline', async () => {
    const forcedId = '123e4567-e89b-42d3-a456-426614174005';
    const deadlineId = '123e4567-e89b-42d3-a456-426614174006';
    const path = databasePath();
    await committed(path, [selection(forcedId, 1), selection(deadlineId, 2)]);

    const repairRuntime = (cause: 'probe-failed' | 'deadline-expired') => ({
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'unobservable' as const, cause } })),
      },
    });

    await expect(
      resolveHandoffRoutingStatus(repairRuntime('probe-failed'), path, {
        invocationId: forcedId,
        forceUnobservable: false,
      }),
    ).resolves.toEqual({
      kind: 'unauthorized-unobservable',
      invocationId: forcedId,
      cause: 'probe-failed',
    });
    await expect(
      resolveHandoffRoutingStatus(repairRuntime('deadline-expired'), path, {
        invocationId: deadlineId,
        forceUnobservable: true,
      }),
    ).resolves.toEqual({
      kind: 'unauthorized-unobservable',
      invocationId: deadlineId,
      cause: 'deadline-expired',
    });
    await expect(
      resolveHandoffRoutingStatus(repairRuntime('probe-failed'), path, {
        invocationId: forcedId,
        forceUnobservable: true,
      }),
    ).resolves.toMatchObject({
      kind: 'resolved',
      invocationId: forcedId,
      reason: 'operator-abandoned-unobservable',
    });
  });

  it('observes the retained owner window in one bounded batch without the synchronous incarnation probe', async () => {
    const path = databasePath();
    const transitions = Array.from({ length: MAX_UNRESOLVED_INVOCATIONS + 1 }, (_, index) =>
      selection(`window-${index}`, index + 1),
    );
    await committed(path, transitions);
    const calls: Array<{ owners: readonly (typeof OWNER)[]; deadlineMs: number }> = [];
    const batchRuntime = {
      ...runtime,
      process: {
        ...runtime.process,
        readProcessIncarnation: () => {
          throw new Error('status read must use the batch observer');
        },
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[], deadlineMs: number) => {
          calls.push({ owners, deadlineMs });
          return owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' as const } }));
        },
      },
    };

    const result = await readHandoffRoutingStatusWithOwnerObservations(batchRuntime, path);

    expect(result.kind).toBe('current');
    if (result.kind !== 'current') throw new Error(`Expected current status, received ${result.kind}`);
    expect(result.statuses.filter((status) => status.kind === 'unresolved')).toHaveLength(MAX_UNRESOLVED_INVOCATIONS);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      owners: { length: MAX_UNRESOLVED_INVOCATIONS },
      deadlineMs: MAX_HANDOFF_ROUTING_OWNER_SWEEP_MS,
    });
  });
});
