import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY,
  handoffRoutingStatusStoreSchema,
} from '#src/coordinator/handoff-routing/status.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  handoffRoutingStatusFingerprint,
  handoffRoutingStatusGeneration,
  HandoffRoutingStoreInvalidRecordError,
  HandoffRoutingStoreUnreadableError,
  publishHandoffRoutingStoreTransaction,
  readHandoffRoutingStoreSnapshotWithObservation,
  SQLITE_CORRUPT,
  SQLITE_ERROR,
  SQLITE_NOTADB,
  type HandoffRoutingRecordInput,
  type HandoffRoutingStatusTransaction,
  type HandoffRoutingStoreSnapshot,
} from '#src/store/handoff-routing-status-store/index.js';
import type { StorageBigIntStat, StoragePort } from '#src/infra/port-types.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const temporaryDirectories: string[] = [];
const owner = { pid: 101, incarnation: testIncarnation(101) } as const;
const selectedDisposition = { kind: 'continue-current', basis: { kind: 'incumbent-absent' } } as const;

const schema = handoffRoutingStatusStoreSchema();
const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(schema);

function admitSnapshot(snapshot: HandoffRoutingStoreSnapshot) {
  return { kind: 'admitted', snapshot } as const;
}

function readStoreSnapshot(storage: StoragePort, path: string) {
  return readHandoffRoutingStoreSnapshotWithObservation(storage, path, schema, admitSnapshot).classification;
}

function publishStore<T>(
  storage: StoragePort,
  path: string,
  mutate: (transaction: HandoffRoutingStatusTransaction) => T,
) {
  return publishHandoffRoutingStoreTransaction(
    storage,
    path,
    schema,
    (classification) => HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY[classification.kind].publication,
    admitSnapshot,
    mutate,
  );
}

const selectionBody = {
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  sequence: 1,
  eventId: 'selection-event',
  invocationId: 'selection-invocation',
  observedAt: '2026-08-03T00:00:00.000Z',
  eventKind: 'routing-selected',
  phase: 'selection',
  owner,
  disposition: selectedDisposition,
} as const;

const terminalBody = {
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  sequence: 1,
  eventId: 'terminal-event',
  invocationId: 'terminal-invocation',
  observedAt: '2026-08-03T00:00:00.000Z',
  eventKind: 'continuation-finalized',
  phase: 'terminal',
  selection: { kind: 'with-selection-sequence', selectionSequence: 1 },
  disposition: {
    kind: 'continued-current',
    reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
  },
} as const;

const retirementBody = {
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  sequence: 1,
  eventId: 'retirement-event',
  invocationId: 'retirement-invocation',
  observedAt: '2026-08-03T00:00:00.000Z',
  eventKind: 'retirement-tombstone',
  phase: 'retirement',
  selectionSequence: 1,
  selectedAt: '2026-08-02T00:00:00.000Z',
  owner,
  selectedDisposition,
  retirementCause: 'selection-evicted-at-capacity',
  terminalExisted: false,
} as const;

type RecordBody = typeof selectionBody | typeof terminalBody | typeof retirementBody;

function recordInput(
  body: RecordBody,
  fields: Pick<HandoffRoutingRecordInput, 'recordKind' | 'selectionSequence' | 'retirementCause' | 'terminalExisted'>,
): HandoffRoutingRecordInput {
  return {
    generation: body.generation,
    sequence: body.sequence,
    eventId: body.eventId,
    invocationId: body.invocationId,
    observedAt: body.observedAt,
    eventKind: body.eventKind,
    bodyJson: JSON.stringify(body),
    ...fields,
  };
}

const legalRecords = [
  {
    name: 'selection',
    record: recordInput(selectionBody, {
      recordKind: 'selection',
      selectionSequence: null,
      retirementCause: null,
      terminalExisted: null,
    }),
  },
  {
    name: 'terminal',
    record: recordInput(terminalBody, {
      recordKind: 'terminal',
      selectionSequence: terminalBody.selection.selectionSequence,
      retirementCause: null,
      terminalExisted: null,
    }),
  },
  {
    name: 'retirement',
    record: recordInput(retirementBody, {
      recordKind: 'retirement',
      selectionSequence: retirementBody.selectionSequence,
      retirementCause: retirementBody.retirementCause,
      terminalExisted: retirementBody.terminalExisted,
    }),
  },
] as const satisfies readonly Readonly<{ name: string; record: HandoffRoutingRecordInput }>[];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-store-'));
  temporaryDirectories.push(directory);
  return join(directory, `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`);
}

type PreflightPathState = 'absent' | 'zero' | 'non-empty' | 'failed';

function preflightStat(size: bigint): StorageBigIntStat {
  return {
    dev: 11n,
    ino: 12n,
    mode: 0o600n,
    size,
    mtimeNs: 13n,
    isDirectory: () => false,
    isFile: () => true,
  };
}

function preflightStorage(
  path: string,
  main: PreflightPathState,
  wal: PreflightPathState,
  openFailure: Error = new Error('SQLite open reached'),
): Readonly<{
  storage: StoragePort;
  openSqliteDatabaseSync: ReturnType<typeof vi.fn>;
  statSync: ReturnType<typeof vi.fn>;
}> {
  const runtime = createRealRuntime('prod', { baseDir: dirname(path) });
  const openSqliteDatabaseSync = vi.fn(() => {
    throw openFailure;
  });
  const states = new Map([
    [path, main],
    [`${path}-wal`, wal],
  ]);
  const stat = vi.fn((candidate: string): StorageBigIntStat => {
    const state = states.get(candidate);
    if (state === 'zero') return preflightStat(0n);
    if (state === 'non-empty') return preflightStat(4096n);
    const error = new Error(state === 'failed' ? 'stat failed' : 'path absent') as NodeJS.ErrnoException;
    error.code = state === 'failed' ? 'EACCES' : 'ENOENT';
    error.errno = state === 'failed' ? -13 : -2;
    throw error;
  });
  return {
    storage: {
      ...runtime.storage,
      assertReadableSync: () => undefined,
      mkdirSync: () => undefined,
      statSync: stat as unknown as StoragePort['statSync'],
      openSqliteDatabaseSync,
    },
    openSqliteDatabaseSync,
    statSync: stat,
  };
}

function initializeStore(path: string): void {
  expect(publishStore(createRealRuntime('prod', { baseDir: dirname(path) }).storage, path, () => undefined)).toEqual({
    kind: 'committed',
    value: undefined,
  });
}

function publishRecord(path: string, record: HandoffRoutingRecordInput) {
  const runtime = createRealRuntime('prod', { baseDir: dirname(path) });
  return publishStore(runtime.storage, path, (transaction) => transaction.insertRecord(record));
}

function expectInvalidRecord(
  path: string,
  record: HandoffRoutingRecordInput,
  validationKind: 'malformed-json' | 'schema-violation' | 'envelope-body-disagreement',
): void {
  initializeStore(path);
  const publication = publishRecord(path, record);

  expect(publication).toMatchObject({
    kind: 'failed',
    error: expect.any(HandoffRoutingStoreInvalidRecordError),
    commitStarted: false,
  });
  if (publication.kind !== 'failed') throw new Error('Expected invalid record publication to fail');
  expect(publication.error).toMatchObject({ validation: { kind: validationKind } });
  expect(publication.error).not.toBeInstanceOf(HandoffRoutingStoreUnreadableError);
  expect(publication.error).not.toHaveProperty('errcode');

  const database = new DatabaseSync(path);
  try {
    expect(database.prepare('SELECT COUNT(*) AS count FROM handoff_routing_records').get()).toEqual({ count: 0 });
  } finally {
    database.close();
  }
}

describe('HandoffRoutingStatusTransaction', () => {
  it('derives the generation from the rendered schema bounds', () => {
    expect(
      handoffRoutingStatusGeneration({
        ...schema,
        durableFormat: {
          ...schema.durableFormat,
          maximumRetirementTombstoneBytes: schema.durableFormat.maximumRetirementTombstoneBytes + 1,
        },
      }),
    ).not.toBe(HANDOFF_ROUTING_STATUS_GENERATION);
  });

  it('derives the generation from the record contracts but not operational capacity', () => {
    expect(
      handoffRoutingStatusGeneration({
        ...schema,
        durableFormat: {
          ...schema.durableFormat,
          recordContracts: {
            ...schema.durableFormat.recordContracts,
            retirement: [schema.durableFormat.recordContracts.retirement, 'future-disposition'],
          },
        },
      }),
    ).not.toBe(HANDOFF_ROUTING_STATUS_GENERATION);
    expect(
      handoffRoutingStatusGeneration({
        ...schema,
        operational: { maximumBytes: schema.operational.maximumBytes + 1 },
      }),
    ).toBe(HANDOFF_ROUTING_STATUS_GENERATION);
  });

  it('derives the same generation from any durable-format object key order', () => {
    const format = schema.durableFormat;
    const stability = format.bodyVocabulary.completedPairStability;
    const reorderedFormat = {
      bodyVocabulary: {
        completedPairStability: {
          terminalDispositionKind: stability.terminalDispositionKind,
          selectionBasisKinds: stability.selectionBasisKinds,
          selectionDispositionKind: stability.selectionDispositionKind,
        },
      },
      recordContracts: {
        retirement: format.recordContracts.retirement,
        terminal: format.recordContracts.terminal,
        selection: format.recordContracts.selection,
      },
      closingRecordBytes: format.closingRecordBytes,
      maximumRetirementTombstoneBytes: format.maximumRetirementTombstoneBytes,
      maximumContinuationFinalizedBytes: format.maximumContinuationFinalizedBytes,
      maximumExecutionFailedBytes: format.maximumExecutionFailedBytes,
      maximumRoutingSelectedBytes: format.maximumRoutingSelectedBytes,
      maximumObservedAtLength: format.maximumObservedAtLength,
      maximumIdentifierLength: format.maximumIdentifierLength,
    };

    expect(handoffRoutingStatusGeneration({ ...schema, durableFormat: reorderedFormat })).toBe(
      HANDOFF_ROUTING_STATUS_GENERATION,
    );
  });

  it('persists and compares the full durable fingerprint as 32 raw bytes', () => {
    const path = databasePath();
    initializeStore(path);
    const expectedFingerprint = handoffRoutingStatusFingerprint(schema);
    const differentFingerprint = Buffer.from(expectedFingerprint);
    differentFingerprint.writeUInt8(expectedFingerprint.readUInt8(0) ^ 0xff, 0);
    const database = new DatabaseSync(path);
    try {
      const metadata = database
        .prepare(
          `SELECT
            fingerprint,
            typeof(fingerprint) AS storage_type,
            length(fingerprint) AS byte_length
          FROM handoff_routing_metadata WHERE singleton = 1`,
        )
        .get() as Readonly<{ fingerprint: Uint8Array; storage_type: string; byte_length: number }>;
      expect(metadata.storage_type).toBe('blob');
      expect(metadata.byte_length).toBe(32);
      expect(Buffer.from(metadata.fingerprint)).toEqual(expectedFingerprint);
      database
        .prepare('UPDATE handoff_routing_metadata SET fingerprint = ? WHERE singleton = 1')
        .run(differentFingerprint);
    } finally {
      database.close();
    }

    const runtime = createRealRuntime('prod', { baseDir: dirname(path) });
    expect(readStoreSnapshot(runtime.storage, path)).toEqual({ kind: 'format-mismatch' });
    expect(publishStore(runtime.storage, path, () => undefined)).toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'format-mismatch' },
    });
  });

  it('refuses noncanonical durable vocabulary before rendering retention SQL', () => {
    expect(() =>
      handoffRoutingStatusGeneration({
        ...schema,
        durableFormat: {
          ...schema.durableFormat,
          bodyVocabulary: {
            ...schema.durableFormat.bodyVocabulary,
            completedPairStability: {
              ...schema.durableFormat.bodyVocabulary.completedPairStability,
              terminalDispositionKind: 'Delegated success',
            },
          },
        },
      }),
    ).toThrow('unsafe identifier');
  });

  it('rejects a completed-pair literal that exists only at a different contract path', () => {
    expect(() =>
      handoffRoutingStatusFingerprint({
        ...schema,
        durableFormat: {
          ...schema.durableFormat,
          bodyVocabulary: {
            completedPairStability: {
              ...schema.durableFormat.bodyVocabulary.completedPairStability,
              selectionDispositionKind:
                schema.durableFormat.bodyVocabulary.completedPairStability.terminalDispositionKind,
            },
          },
        },
      }),
    ).toThrow('completed-pair selection disposition is outside the durable vocabulary');
  });

  it('derives main-file and checkpoint bounds from the same byte budget', () => {
    const path = databasePath();
    const probe = new DatabaseSync(path);
    const pageSize = Number((probe.prepare('PRAGMA page_size').get() as { page_size: number }).page_size);
    probe.close();

    const runtime = createRealRuntime('prod', { baseDir: dirname(path) });
    const executed: string[] = [];
    const storage = {
      ...runtime.storage,
      openSqliteDatabaseSync: (...args: Parameters<typeof runtime.storage.openSqliteDatabaseSync>) => {
        const database = runtime.storage.openSqliteDatabaseSync(...args);
        return {
          exec(sql: string): void {
            executed.push(sql);
            database.exec(sql);
          },
          prepare: (sql: string) => database.prepare(sql),
          close: () => database.close(),
        };
      },
    };

    expect(publishStore(storage, path, () => undefined)).toEqual({
      kind: 'committed',
      value: undefined,
    });
    const maximumPages = Math.floor(schema.operational.maximumBytes / pageSize);
    expect(executed).toContain(`PRAGMA max_page_count=${maximumPages}`);
    expect(executed).toContain(`PRAGMA journal_size_limit=${schema.operational.maximumBytes}`);
    expect(executed).toContain(`PRAGMA wal_autocheckpoint=${maximumPages}`);
  });

  it('classifies a colliding foreign schema before querying its missing fingerprint column', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    try {
      database.exec(`
        CREATE TABLE handoff_routing_metadata (
          singleton INTEGER PRIMARY KEY,
          generation INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE handoff_routing_records (sequence INTEGER PRIMARY KEY, body_json TEXT NOT NULL) STRICT;
        PRAGMA user_version=${HANDOFF_ROUTING_STATUS_GENERATION};
      `);
    } finally {
      database.close();
    }
    const runtime = createRealRuntime('prod', { baseDir: dirname(path) });
    const configured: string[] = [];
    const prepared: string[] = [];
    const chmodSync = vi.fn(runtime.storage.chmodSync);
    const storage = {
      ...runtime.storage,
      chmodSync,
      openSqliteDatabaseSync: (...args: Parameters<typeof runtime.storage.openSqliteDatabaseSync>) => {
        const database = runtime.storage.openSqliteDatabaseSync(...args);
        return {
          exec(sql: string): void {
            configured.push(sql);
            database.exec(sql);
          },
          prepare: (sql: string) => {
            prepared.push(sql);
            return database.prepare(sql);
          },
          close: () => database.close(),
        };
      },
    };

    expect(publishStore(storage, path, () => undefined)).toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'schema-divergent' },
    });
    expect(chmodSync).not.toHaveBeenCalled();
    expect(configured).toEqual([]);
    expect(prepared).not.toContain('SELECT generation, fingerprint FROM handoff_routing_metadata WHERE singleton = 1');
    expect(readStoreSnapshot(runtime.storage, path)).toEqual({ kind: 'schema-divergent' });
  });

  it('keeps an operational fingerprint read failure undeterminable', () => {
    const path = databasePath();
    initializeStore(path);
    const runtime = createRealRuntime('prod', { baseDir: dirname(path) });
    const operationalError = Object.assign(new Error('fingerprint unavailable'), { errno: -13 });
    const storage: StoragePort = {
      ...runtime.storage,
      openSqliteDatabaseSync: (...args) => {
        const database = runtime.storage.openSqliteDatabaseSync(...args);
        return {
          exec: database.exec.bind(database),
          close: database.close.bind(database),
          prepare: (sql) => {
            const statement = database.prepare(sql);
            if (sql !== 'SELECT generation, fingerprint FROM handoff_routing_metadata WHERE singleton = 1') {
              return statement;
            }
            return {
              all: statement.all.bind(statement),
              run: statement.run.bind(statement),
              get: () => {
                throw operationalError;
              },
            };
          },
        };
      },
    };

    expect(readStoreSnapshot(storage, path)).toEqual({ kind: 'undeterminable', cause: 'io-failed', errcode: -13 });
    expect(publishStore(storage, path, () => undefined)).toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'undeterminable', cause: 'io-failed', errcode: -13 },
    });
  });

  it('refuses a state change at the locked recheck before initialization or mutation', () => {
    const path = databasePath();
    initializeStore(path);
    const runtime = createRealRuntime('prod', { baseDir: dirname(path) });
    let changed = false;
    let initializationAttempted = false;
    const mutation = vi.fn(() => undefined);
    const storage: StoragePort = {
      ...runtime.storage,
      openSqliteDatabaseSync: (...args) => {
        const database = runtime.storage.openSqliteDatabaseSync(...args);
        return {
          prepare: database.prepare.bind(database),
          close: database.close.bind(database),
          exec: (sql) => {
            if (sql.includes('CREATE TABLE handoff_routing_metadata')) initializationAttempted = true;
            database.exec(sql);
            if (sql === 'BEGIN IMMEDIATE' && !changed) {
              changed = true;
              database.exec('DROP TABLE handoff_routing_metadata');
            }
          },
        };
      },
    };

    expect(publishStore(storage, path, mutation)).toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'schema-divergent' },
    });
    expect(initializationAttempted).toBe(false);
    expect(mutation).not.toHaveBeenCalled();
    const database = new DatabaseSync(path);
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'handoff_routing_metadata'").get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('classifies and initializes the measured post-journal-mode residue', () => {
    const path = databasePath();
    const runtime = createRealRuntime('prod', { baseDir: dirname(path) });
    let injected = false;
    const interruptedStorage: StoragePort = {
      ...runtime.storage,
      openSqliteDatabaseSync: (...args) => {
        const database = runtime.storage.openSqliteDatabaseSync(...args);
        return {
          prepare: database.prepare.bind(database),
          close: database.close.bind(database),
          exec: (sql) => {
            database.exec(sql);
            if (!injected && sql === 'PRAGMA journal_mode=WAL') {
              injected = true;
              throw new Error('Injected after journal mode and before DDL');
            }
          },
        };
      },
    };

    expect(publishStore(interruptedStorage, path, () => undefined)).toMatchObject({
      kind: 'failed',
      commitStarted: false,
    });
    expect(injected).toBe(true);
    expect(statSync(path).size).toBe(4096);

    const residue = new DatabaseSync(path);
    try {
      expect(residue.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(
        residue.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get(),
      ).toEqual({ count: 0 });
    } finally {
      residue.close();
    }
    expect(readStoreSnapshot(runtime.storage, path)).toEqual({ kind: 'uninitialized' });
    expect(publishStore(runtime.storage, path, () => undefined)).toEqual({ kind: 'committed', value: undefined });
    expect(readStoreSnapshot(runtime.storage, path)).toMatchObject({ kind: 'current' });
  });

  it('classifies a zero-byte journal as vacant and initializes it', () => {
    const path = databasePath();
    writeFileSync(path, '');
    const runtime = createRealRuntime('prod', { baseDir: dirname(path) });

    expect(readStoreSnapshot(runtime.storage, path)).toEqual({ kind: 'vacant' });
    expect(publishStore(runtime.storage, path, () => undefined)).toEqual({ kind: 'committed', value: undefined });
    expect(readStoreSnapshot(runtime.storage, path)).toMatchObject({ kind: 'current' });
  });

  it('distinguishes generation-missing objects from an uninitialized database', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE foreign_object (value INTEGER) STRICT');
    database.close();
    const runtime = createRealRuntime('prod', { baseDir: dirname(path) });

    expect(readStoreSnapshot(runtime.storage, path)).toEqual({ kind: 'generation-missing' });
    expect(publishStore(runtime.storage, path, () => undefined)).toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'generation-missing' },
    });
  });

  it.each([
    ['table', 'CREATE TABLE unexpected_table (value INTEGER) STRICT'],
    ['index', 'CREATE INDEX unexpected_index ON handoff_routing_metadata(generation)'],
    ['view', 'CREATE VIEW unexpected_view AS SELECT generation FROM handoff_routing_metadata'],
    [
      'trigger',
      `CREATE TRIGGER unexpected_trigger
       BEFORE INSERT ON handoff_routing_records
       BEGIN
         SELECT RAISE(ABORT, 'unexpected schema');
       END`,
    ],
  ] as const)('refuses a same-generation database with an additional %s', (_type, sql) => {
    const path = databasePath();
    initializeStore(path);
    const database = new DatabaseSync(path);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
    const runtime = createRealRuntime('prod', { baseDir: dirname(path) });

    expect(publishStore(runtime.storage, path, () => undefined)).toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'schema-divergent' },
    });
    expect(readStoreSnapshot(runtime.storage, path)).toEqual({ kind: 'schema-divergent' });
  });

  it('rejects malformed JSON through the production validator before inserting a row', () => {
    expectInvalidRecord(databasePath(), { ...legalRecords[1].record, bodyJson: '{' }, 'malformed-json');
  });

  it('rejects a schema-invalid record through the production validator before inserting a row', () => {
    expectInvalidRecord(
      databasePath(),
      {
        ...legalRecords[1].record,
        bodyJson: JSON.stringify({
          ...terminalBody,
          disposition: { kind: 'delegated-exit', version: '0.10.9', exitCode: 999 },
        }),
      },
      'schema-violation',
    );
  });

  it.each([
    ['selection', { ...legalRecords[0].record, selectionSequence: 1 }],
    ['terminal', { ...legalRecords[1].record, selectionSequence: 2 }],
    ['retirement', { ...legalRecords[2].record, terminalExisted: true }],
  ] as const)('rejects a %s envelope/body disagreement through the production validator', (_name, record) => {
    expectInvalidRecord(databasePath(), record, 'envelope-body-disagreement');
  });

  it.each(legalRecords)('accepts a legal $name record through the production validator', ({ record }) => {
    const path = databasePath();
    expect(publishRecord(path, record)).toEqual({ kind: 'committed', value: 1 });
  });
});

describe('handoff routing store path preflight', () => {
  it.each([
    ['absent', 'absent', 'observed', 'absent', 'absent', 0],
    ['absent', 'zero', 'observed', 'absent', 'zero', 0],
    ['absent', 'non-empty', 'observed', 'detached-wal', 'non-empty', 0],
    ['absent', 'failed', 'undeterminable', 'undeterminable', undefined, 0],
    ['zero', 'absent', 'observed', 'vacant', 'absent', 0],
    ['zero', 'zero', 'observed', 'vacant', 'zero', 0],
    ['zero', 'non-empty', 'observed', 'detached-wal', 'non-empty', 0],
    ['zero', 'failed', 'undeterminable', 'undeterminable', undefined, 0],
    ['non-empty', 'absent', 'observed', 'undeterminable', 'absent', 1],
    ['non-empty', 'zero', 'observed', 'undeterminable', 'zero', 1],
    ['non-empty', 'non-empty', 'observed', 'undeterminable', 'non-empty', 1],
    ['non-empty', 'failed', 'undeterminable', 'undeterminable', undefined, 0],
    ['failed', 'absent', 'undeterminable', 'undeterminable', undefined, 0],
    ['failed', 'zero', 'undeterminable', 'undeterminable', undefined, 0],
    ['failed', 'non-empty', 'undeterminable', 'undeterminable', undefined, 0],
    ['failed', 'failed', 'undeterminable', 'undeterminable', undefined, 0],
  ] as const)(
    'maps main %s and wal %s before opening SQLite',
    (main, wal, observationKind, resultKind, receiptKind, expectedOpens) => {
      const path = databasePath();
      const instrumented = preflightStorage(path, main, wal);

      const observation = readHandoffRoutingStoreSnapshotWithObservation(
        instrumented.storage,
        path,
        schema,
        admitSnapshot,
      );

      expect(observation.kind).toBe(observationKind);
      expect(observation.classification.kind).toBe(resultKind);
      expect(instrumented.openSqliteDatabaseSync).toHaveBeenCalledTimes(expectedOpens);
      if (observation.kind === 'observed') {
        expect(observation.mainState).toBe(main);
        expect(observation.walReceipt.kind).toBe(receiptKind);
      }
      if (main === 'failed') {
        expect(instrumented.statSync).toHaveBeenCalledTimes(1);
        expect(instrumented.statSync).not.toHaveBeenCalledWith(`${path}-wal`, expect.anything());
      }
    },
  );

  it.each(['absent', 'zero'] as const)(
    'refuses a %s main with a non-empty wal before read and publication opens',
    (main) => {
      const path = databasePath();
      const instrumented = preflightStorage(path, main, 'non-empty');

      expect(readStoreSnapshot(instrumented.storage, path)).toEqual({ kind: 'detached-wal' });
      expect(publishStore(instrumented.storage, path, () => undefined)).toEqual({
        kind: 'artifact-refused',
        classification: { kind: 'detached-wal' },
      });
      expect(instrumented.openSqliteDatabaseSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['absent', 'absent'],
    ['absent', 'zero'],
    ['zero', 'absent'],
    ['zero', 'zero'],
  ] as const)('authorizes publication for main %s and wal %s', (main, wal) => {
    const path = databasePath();
    const instrumented = preflightStorage(path, main, wal);

    expect(publishStore(instrumented.storage, path, () => undefined)).toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'undeterminable', cause: 'io-failed', errcode: SQLITE_ERROR },
    });
    expect(instrumented.openSqliteDatabaseSync).toHaveBeenCalledOnce();
  });

  it.each([
    ['SQLITE_ERROR via errcode', { errcode: SQLITE_ERROR }],
    ['SQLITE_NOTADB via errno', { errno: SQLITE_NOTADB }],
    ['SQLITE_CORRUPT via errcode', { errcode: SQLITE_CORRUPT }],
  ] as const)('classifies a reported %s open failure as unreadable', (_label, code) => {
    const path = databasePath();
    const failure = Object.assign(new Error('SQLite open failed'), code);
    const instrumented = preflightStorage(path, 'absent', 'absent', failure);

    expect(publishStore(instrumented.storage, path, () => undefined)).toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'unreadable', reason: 'invalid-shape' },
    });
    expect(instrumented.openSqliteDatabaseSync).toHaveBeenCalledOnce();
  });

  it('records exactly the wal identity and equality metadata in an existing-wal receipt', () => {
    const path = databasePath();
    const instrumented = preflightStorage(path, 'zero', 'non-empty');

    const observation = readHandoffRoutingStoreSnapshotWithObservation(
      instrumented.storage,
      path,
      schema,
      admitSnapshot,
    );

    expect(observation).toEqual({
      kind: 'observed',
      classification: { kind: 'detached-wal' },
      mainState: 'zero',
      walReceipt: {
        kind: 'non-empty',
        stat: { dev: 11n, ino: 12n, size: 4096n, mtimeNs: 13n },
      },
    });
  });

  it('does not authorize initialization when the wal stat fails operationally', () => {
    const path = databasePath();
    const instrumented = preflightStorage(path, 'absent', 'failed');

    const publication = publishStore(instrumented.storage, path, () => undefined);

    expect(publication).toEqual({
      kind: 'artifact-refused',
      classification: { kind: 'undeterminable', cause: 'io-failed', errcode: -13 },
    });
    expect(instrumented.openSqliteDatabaseSync).not.toHaveBeenCalled();
  });

  it('retains an absent wal receipt when classification creates a zero-byte wal', () => {
    const path = databasePath();
    initializeStore(path);
    if (existsSync(`${path}-wal`)) unlinkSync(`${path}-wal`);
    const storage = createRealRuntime('prod', { baseDir: dirname(path) }).storage;

    const observation = readHandoffRoutingStoreSnapshotWithObservation(storage, path, schema, admitSnapshot);

    expect(observation).toMatchObject({
      kind: 'observed',
      classification: { kind: 'current' },
      walReceipt: { kind: 'absent' },
    });
    expect(statSync(`${path}-wal`).size).toBe(0);
  });
});
