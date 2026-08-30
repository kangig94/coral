import { dirname } from 'node:path';

import { errorNumber } from '../../infra/error-number.js';
import type { SqliteDatabasePort, StorageBigIntStat, StoragePort } from '../../infra/port-types.js';
import {
  HandoffRoutingStatusTransaction,
  HandoffRoutingStoreUnreadableError,
  SQLITE_CORRUPT,
  SQLITE_ERROR,
  SQLITE_NOTADB,
  readRetirementHistory,
  type HandoffRoutingRetirementHistoryRow,
} from './transaction.js';
import {
  databaseSchemaMatches,
  handoffRoutingStatusFingerprint,
  handoffRoutingStatusGeneration,
  schemaSql,
  type HandoffRoutingStatusStoreOperationalCapacity,
  type HandoffRoutingStatusStoreSchema,
} from './durable-format.js';

export class HandoffRoutingStorePathObservationError extends Error {
  readonly cause: unknown;
  readonly errcode: number;

  constructor(cause: unknown) {
    super();
    this.cause = cause;
    this.errcode = errorNumber(cause, SQLITE_ERROR);
  }
}

export type HandoffRoutingStoreUnreadableReason = 'invalid-json' | 'invalid-shape' | 'too-large';

type HandoffRoutingStoreNonCurrentClassification =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'vacant' }>
  | Readonly<{ kind: 'uninitialized' }>
  | Readonly<{ kind: 'detached-wal' }>
  | Readonly<{ kind: 'generation-missing' }>
  | Readonly<{ kind: 'foreign-generation'; generation: number }>
  | Readonly<{ kind: 'format-mismatch' }>
  | Readonly<{ kind: 'schema-divergent' }>
  | Readonly<{ kind: 'unreadable'; reason: HandoffRoutingStoreUnreadableReason }>
  | Readonly<{ kind: 'undeterminable'; cause: 'io-failed'; errcode: number }>;

export type HandoffRoutingStoreClassification<T> =
  | HandoffRoutingStoreNonCurrentClassification
  | Readonly<{ kind: 'current'; snapshot: T }>;

export type HandoffRoutingStoreArtifactRefusal = Extract<
  HandoffRoutingStoreClassification<never>,
  {
    kind:
      | 'detached-wal'
      | 'generation-missing'
      | 'foreign-generation'
      | 'format-mismatch'
      | 'schema-divergent'
      | 'unreadable'
      | 'undeterminable';
  }
>;

export type HandoffRoutingStorePublication<T> =
  | Readonly<{ kind: 'committed'; value: T }>
  | Readonly<{ kind: 'artifact-refused'; classification: HandoffRoutingStoreArtifactRefusal }>
  | Readonly<{ kind: 'failed'; error: unknown; commitStarted: boolean }>;

export type HandoffRoutingStoreSnapshot = Readonly<{
  rows: readonly unknown[];
  reserves: readonly unknown[];
  retirement: HandoffRoutingRetirementHistoryRow | undefined;
}>;

export type HandoffRoutingStoreBodyAdmission<T> = (
  snapshot: HandoffRoutingStoreSnapshot,
) =>
  | Readonly<{ kind: 'admitted'; snapshot: T }>
  | Readonly<{ kind: 'unreadable'; reason: HandoffRoutingStoreUnreadableReason }>;

export type HandoffRoutingStorePublicationPolicy = (
  classification: HandoffRoutingStoreClassification<unknown>,
) => 'initialize' | 'mutate' | 'refuse';

export type HandoffRoutingWalStatReceipt = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}>;

export type HandoffRoutingWalObservationReceipt =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'zero'; stat: HandoffRoutingWalStatReceipt }>
  | Readonly<{ kind: 'non-empty'; stat: HandoffRoutingWalStatReceipt }>;

type HandoffRoutingStorePathObservation =
  | Readonly<{
      kind: 'observed';
      disposition: 'absent' | 'vacant' | 'detached-wal' | 'sqlite';
      mainState: 'absent' | 'zero' | 'non-empty';
      walReceipt: HandoffRoutingWalObservationReceipt;
    }>
  | Readonly<{ kind: 'undeterminable'; error: unknown }>;

type HandoffRoutingPathObservation =
  | Readonly<{ kind: 'present'; stat: StorageBigIntStat }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'undeterminable'; error: HandoffRoutingStorePathObservationError }>;

export function observeHandoffRoutingPath(storage: StoragePort, path: string): HandoffRoutingPathObservation {
  try {
    return { kind: 'present', stat: storage.statSync(path, { bigint: true }) };
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'undeterminable', error: new HandoffRoutingStorePathObservationError(error) };
  }
}

// Node 24 `node:sqlite` unlinked a frames-bearing wal beside a zero-byte main after a read-only open and
// `PRAGMA user_version`, so the main/wal product must be decided before any SQLite open.
function observeHandoffRoutingStorePath(storage: StoragePort, path: string): HandoffRoutingStorePathObservation {
  const mainObservation = observeHandoffRoutingPath(storage, path);
  if (mainObservation.kind === 'undeterminable') return mainObservation;
  const main = mainObservation.kind === 'absent' ? 'absent' : mainObservation.stat.size === 0n ? 'zero' : 'non-empty';

  let walReceipt: HandoffRoutingWalObservationReceipt;
  const walObservation = observeHandoffRoutingPath(storage, `${path}-wal`);
  if (walObservation.kind === 'undeterminable') return walObservation;
  if (walObservation.kind === 'absent') {
    walReceipt = { kind: 'absent' };
  } else {
    const wal = walObservation.stat;
    const stat = { dev: wal.dev, ino: wal.ino, size: wal.size, mtimeNs: wal.mtimeNs };
    walReceipt = wal.size === 0n ? { kind: 'zero', stat } : { kind: 'non-empty', stat };
  }

  if (main !== 'non-empty' && walReceipt.kind === 'non-empty') {
    return { kind: 'observed', disposition: 'detached-wal', mainState: main, walReceipt };
  }
  if (main === 'absent') return { kind: 'observed', disposition: 'absent', mainState: main, walReceipt };
  if (main === 'zero') return { kind: 'observed', disposition: 'vacant', mainState: main, walReceipt };
  return { kind: 'observed', disposition: 'sqlite', mainState: main, walReceipt };
}

function undeterminableClassification(
  error: unknown,
): Extract<HandoffRoutingStoreClassification<never>, { kind: 'undeterminable' }> {
  return {
    kind: 'undeterminable',
    cause: 'io-failed',
    errcode:
      error instanceof HandoffRoutingStorePathObservationError ? error.errcode : errorNumber(error, SQLITE_ERROR),
  };
}

function unreadableOrUndeterminableClassification(
  error: unknown,
): Extract<HandoffRoutingStoreClassification<never>, { kind: 'unreadable' | 'undeterminable' }> {
  if (error instanceof HandoffRoutingStoreUnreadableError) {
    return { kind: 'unreadable', reason: 'invalid-shape' };
  }
  const reportedError = error as { readonly errcode?: unknown; readonly errno?: unknown } | null;
  const reportedErrcode =
    typeof reportedError?.errcode === 'number' && Number.isInteger(reportedError.errcode)
      ? reportedError.errcode
      : typeof reportedError?.errno === 'number' && Number.isInteger(reportedError.errno)
        ? reportedError.errno
        : undefined;
  if (reportedErrcode === undefined) {
    const errcode = errorNumber(error, SQLITE_ERROR);
    return { kind: 'undeterminable', cause: 'io-failed', errcode };
  }
  const errcode = reportedErrcode;
  const primaryErrcode = errcode & 0xff;
  return primaryErrcode === SQLITE_ERROR || primaryErrcode === SQLITE_NOTADB || primaryErrcode === SQLITE_CORRUPT
    ? { kind: 'unreadable', reason: 'invalid-shape' }
    : { kind: 'undeterminable', cause: 'io-failed', errcode };
}

function preflightClassification(
  observation: HandoffRoutingStorePathObservation,
): Extract<
  HandoffRoutingStoreClassification<never>,
  { kind: 'absent' | 'vacant' | 'detached-wal' | 'undeterminable' }
> | null {
  if (observation.kind === 'undeterminable') return undeterminableClassification(observation.error);
  switch (observation.disposition) {
    case 'absent':
      return { kind: 'absent' };
    case 'vacant':
      return { kind: 'vacant' };
    case 'detached-wal':
      return { kind: 'detached-wal' };
    case 'sqlite':
      return null;
  }
}

export function publishHandoffRoutingStoreTransaction<T>(
  storage: StoragePort,
  path: string,
  schema: HandoffRoutingStatusStoreSchema,
  publicationPolicy: HandoffRoutingStorePublicationPolicy,
  admitBody: HandoffRoutingStoreBodyAdmission<unknown>,
  mutate: (transaction: HandoffRoutingStatusTransaction) => T,
): HandoffRoutingStorePublication<T> {
  let database: SqliteDatabasePort | undefined;
  let transactionOpen = false;
  let commitStarted = false;
  try {
    const observation = observeHandoffRoutingStorePath(storage, path);
    const preflight = preflightClassification(observation);
    if (preflight !== null && publicationPolicy(preflight) === 'refuse') {
      return { kind: 'artifact-refused', classification: preflight as HandoffRoutingStoreArtifactRefusal };
    }
    storage.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      database = storage.openSqliteDatabaseSync(path);
    } catch (error: unknown) {
      return {
        kind: 'artifact-refused',
        classification: unreadableOrUndeterminableClassification(error),
      };
    }
    const advisory = classifyOpenHandoffRoutingStoreDatabase(database, schema, admitBody);
    if (publicationPolicy(advisory) === 'refuse') {
      return { kind: 'artifact-refused', classification: advisory as HandoffRoutingStoreArtifactRefusal };
    }
    storage.chmodSync(path, 0o600);
    configureDatabase(database, schema.operational);
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const admission = classifyOpenHandoffRoutingStoreDatabase(database, schema, admitBody);
    const admissionAction = publicationPolicy(admission);
    if (admissionAction === 'refuse') {
      rollback(database, transactionOpen, false);
      transactionOpen = false;
      return { kind: 'artifact-refused', classification: admission as HandoffRoutingStoreArtifactRefusal };
    }
    if (admissionAction === 'initialize') initializeDatabase(database, schema);
    const value = mutate(new HandoffRoutingStatusTransaction(database, schema));
    commitStarted = true;
    database.exec('COMMIT');
    transactionOpen = false;
    return { kind: 'committed', value };
  } catch (error) {
    rollback(database, transactionOpen, commitStarted);
    return { kind: 'failed', error, commitStarted };
  } finally {
    close(database);
  }
}

export type HandoffRoutingStoreSnapshotObservation<T> =
  | Readonly<{
      kind: 'observed';
      classification: HandoffRoutingStoreClassification<T>;
      mainState: 'absent' | 'zero' | 'non-empty';
      walReceipt: HandoffRoutingWalObservationReceipt;
    }>
  | Readonly<{
      kind: 'undeterminable';
      classification: Extract<HandoffRoutingStoreClassification<never>, { kind: 'undeterminable' }>;
    }>;

export function readHandoffRoutingStoreSnapshotWithObservation<T>(
  storage: StoragePort,
  path: string,
  schema: HandoffRoutingStatusStoreSchema,
  admitBody: HandoffRoutingStoreBodyAdmission<T>,
): HandoffRoutingStoreSnapshotObservation<T> {
  const observation = observeHandoffRoutingStorePath(storage, path);
  if (observation.kind === 'undeterminable') {
    return { kind: 'undeterminable', classification: undeterminableClassification(observation.error) };
  }
  const preflight = preflightClassification(observation);
  if (preflight !== null) {
    return {
      kind: 'observed',
      classification: preflight,
      mainState: observation.mainState,
      walReceipt: observation.walReceipt,
    };
  }

  try {
    storage.assertReadableSync(path);
  } catch (error) {
    return {
      kind: 'observed',
      classification: undeterminableClassification(error),
      mainState: observation.mainState,
      walReceipt: observation.walReceipt,
    };
  }

  let database: SqliteDatabasePort | undefined;
  let transactionOpen = false;
  try {
    database = storage.openSqliteDatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA busy_timeout=0');
    database.exec('BEGIN');
    transactionOpen = true;
    const classification = classifyOpenHandoffRoutingStoreDatabase(database, schema, admitBody);
    database.exec('COMMIT');
    transactionOpen = false;
    return {
      kind: 'observed',
      classification,
      mainState: observation.mainState,
      walReceipt: observation.walReceipt,
    };
  } catch (error) {
    rollback(database, transactionOpen, false);
    return {
      kind: 'observed',
      classification: unreadableOrUndeterminableClassification(error),
      mainState: observation.mainState,
      walReceipt: observation.walReceipt,
    };
  } finally {
    close(database);
  }
}

function configureDatabase(
  database: SqliteDatabasePort,
  operational: HandoffRoutingStatusStoreOperationalCapacity,
): void {
  database.exec('PRAGMA busy_timeout=0');
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=FULL');
  database.exec('PRAGMA foreign_keys=ON');
  const pageSize = Number((database.prepare('PRAGMA page_size').get() as Readonly<{ page_size: number }>).page_size);
  const maximumBytes = operational.maximumBytes;
  const maximumPages = Math.max(1, Math.floor(maximumBytes / pageSize));
  database.exec(`PRAGMA max_page_count=${maximumPages}`);
  database.exec(`PRAGMA journal_size_limit=${maximumBytes}`);
  database.exec(`PRAGMA wal_autocheckpoint=${maximumPages}`);
}

function initializeDatabase(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema): void {
  const expectedGeneration = handoffRoutingStatusGeneration(schema);
  const expectedFingerprint = handoffRoutingStatusFingerprint(schema);
  database.exec(schemaSql(schema));
  database
    .prepare(
      `INSERT INTO handoff_routing_metadata (
        singleton,
        generation,
        fingerprint,
        expired_identity_count,
        capacity_eviction_count,
        completed_pair_compaction_count,
        operator_resolved_count
      ) VALUES (1, ?, ?, 0, 0, 0, 0)`,
    )
    .run(expectedGeneration, expectedFingerprint);
  database.exec(`PRAGMA user_version=${expectedGeneration}`);
}

function metadataFingerprintMatches(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema): boolean {
  const expectedGeneration = handoffRoutingStatusGeneration(schema);
  const expectedFingerprint = handoffRoutingStatusFingerprint(schema);
  const metadata = database
    .prepare('SELECT generation, fingerprint FROM handoff_routing_metadata WHERE singleton = 1')
    .get() as Readonly<{ generation: number; fingerprint: unknown }> | undefined;
  if (
    metadata?.generation !== expectedGeneration ||
    !(metadata.fingerprint instanceof Uint8Array) ||
    metadata.fingerprint.byteLength !== 32
  ) {
    throw new HandoffRoutingStoreUnreadableError();
  }
  return expectedFingerprint.equals(metadata.fingerprint);
}

function readOpenHandoffRoutingStoreSnapshot(database: SqliteDatabasePort): HandoffRoutingStoreSnapshot {
  const retirement = readRetirementHistory(database);
  const rows = database
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
  const reserves = database
    .prepare(
      `SELECT
        invocation_id,
        event_id,
        observed_at,
        length(allocation) AS allocation_bytes
      FROM handoff_routing_closing_reserve ORDER BY invocation_id`,
    )
    .all();
  return { rows, reserves, retirement };
}

export function classifyOpenHandoffRoutingStoreDatabase<T>(
  database: SqliteDatabasePort,
  schema: HandoffRoutingStatusStoreSchema,
  admitBody: HandoffRoutingStoreBodyAdmission<T>,
): HandoffRoutingStoreClassification<T> {
  try {
    const expectedGeneration = handoffRoutingStatusGeneration(schema);
    const storedGeneration = (database.prepare('PRAGMA user_version').get() as Readonly<{ user_version: number }>)
      .user_version;
    if (storedGeneration === 0) {
      const existing = database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .get() as Readonly<{ count: number }>;
      return existing.count === 0 ? { kind: 'uninitialized' } : { kind: 'generation-missing' };
    }
    if (storedGeneration !== expectedGeneration) {
      return { kind: 'foreign-generation', generation: storedGeneration };
    }
    if (!databaseSchemaMatches(database, schema)) return { kind: 'schema-divergent' };
    if (!metadataFingerprintMatches(database, schema)) return { kind: 'format-mismatch' };
    const admitted = admitBody(readOpenHandoffRoutingStoreSnapshot(database));
    return admitted.kind === 'admitted' ? { kind: 'current', snapshot: admitted.snapshot } : admitted;
  } catch (error: unknown) {
    return unreadableOrUndeterminableClassification(error);
  }
}

function rollback(database: SqliteDatabasePort | undefined, transactionOpen: boolean, commitStarted: boolean): void {
  if (database === undefined || !transactionOpen || commitStarted) return;
  try {
    database.exec('ROLLBACK');
  } catch (rollbackError) {
    void rollbackError;
  }
}

function close(database: SqliteDatabasePort | undefined): void {
  if (database === undefined) return;
  try {
    database.close();
  } catch (closeError) {
    void closeError;
  }
}
