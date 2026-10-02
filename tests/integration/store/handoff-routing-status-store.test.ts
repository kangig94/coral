import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY,
  handoffRoutingStatusStoreSchema,
} from '#src/coordinator/handoff-routing/status.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  handoffRoutingStatusGeneration,
  HandoffRoutingStoreInvalidRecordError,
  HandoffRoutingStoreUnreadableError,
  publishHandoffRoutingStoreTransaction,
  readHandoffRoutingStoreSnapshotWithObservation,
  type HandoffRoutingRecordInput,
  type HandoffRoutingStatusTransaction,
  type HandoffRoutingStoreSnapshot,
} from '#src/store/handoff-routing-status-store/index.js';
import type { StoragePort } from '#src/infra/port-types.js';

const temporaryDirectories: string[] = [];

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

const malformedRecord: HandoffRoutingRecordInput = {
  generation: HANDOFF_ROUTING_STATUS_GENERATION,
  sequence: 1,
  eventId: 'terminal-event',
  invocationId: 'terminal-invocation',
  observedAt: '2026-08-03T00:00:00.000Z',
  eventKind: 'continuation-finalized',
  recordKind: 'terminal',
  selectionSequence: 1,
  retirementCause: null,
  terminalExisted: null,
  bodyJson: '{',
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-store-'));
  temporaryDirectories.push(directory);
  return join(directory, `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`);
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

  it('rejects malformed JSON through the production validator before inserting a row', () => {
    expectInvalidRecord(databasePath(), malformedRecord, 'malformed-json');
  });
});
