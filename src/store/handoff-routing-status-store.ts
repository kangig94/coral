import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import type { SqliteDatabasePort, StoragePort } from '../infra/port-types.js';
import { canonicalContractJson } from '../infra/persisted-contract.js';

export const SQLITE_BUSY = 5;
export const SQLITE_FULL = 13;
export const SQLITE_NOTADB = 26;
export const SQLITE_CORRUPT = 11;
export const SQLITE_ERROR = 1;
const HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH = 10;
export const HANDOFF_ROUTING_STATUS_GENERATION_BAND = {
  minimum: 10 ** (HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH - 1),
  // `PRAGMA user_version` cannot store a value above the signed 32-bit maximum.
  maximum: Math.min(10 ** HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH - 1, 2 ** 31 - 1),
  decimalWidth: HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH,
} as const;
const HANDOFF_ROUTING_STATUS_QUARANTINE_DIRECTORY = 'handoff-routing-quarantine';
export const MAX_HANDOFF_ROUTING_STATUS_QUARANTINES = 16;
const MAX_HANDOFF_ROUTING_STATUS_QUARANTINE_FILES = MAX_HANDOFF_ROUTING_STATUS_QUARANTINES * 3 + 1;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type HandoffRoutingStatusQuarantineArtifact = 'database' | 'wal' | 'shm';

export type HandoffRoutingStatusQuarantineEntry = Readonly<{
  id: string;
  quarantinePath: string;
  state: 'complete' | 'incomplete';
  artifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
}>;

export type HandoffRoutingStatusQuarantineList = Readonly<{
  entries: readonly HandoffRoutingStatusQuarantineEntry[];
  overflow: boolean;
}>;

export type HandoffRoutingStatusQuarantineResult =
  | Readonly<{ kind: 'quarantined'; quarantinePath: string }>
  | Readonly<{ kind: 'incomplete-quarantine'; quarantineId: string }>;

export class HandoffRoutingStatusQuarantineCapacityError extends Error {}

export type HandoffRoutingStatusBodyVocabulary = Readonly<{
  dispositionKinds: readonly string[];
  routingBasisKinds: readonly string[];
  completedPairStability: Readonly<{
    selectionDispositionKind: string;
    selectionBasisKinds: readonly string[];
    terminalDispositionKind: string;
  }>;
}>;

export type HandoffRoutingStatusStoreDurableFormat = Readonly<{
  maximumIdentifierLength: number;
  maximumObservedAtLength: number;
  maximumRoutingSelectedBytes: number;
  maximumExecutionFailedBytes: number;
  maximumContinuationFinalizedBytes: number;
  maximumRetirementTombstoneBytes: number;
  closingRecordBytes: number;
  bodyVocabulary: HandoffRoutingStatusBodyVocabulary;
}>;

export type HandoffRoutingStatusStoreOperationalCapacity = Readonly<{
  // Capacity tuning must not move the address of data that remains decodable.
  maximumBytes: number;
}>;

export type HandoffRoutingStatusStoreSchema = Readonly<{
  durableFormat: HandoffRoutingStatusStoreDurableFormat;
  operational: HandoffRoutingStatusStoreOperationalCapacity;
  validateRecordBody: (record: HandoffRoutingRecordInput) => HandoffRoutingRecordValidationResult;
}>;

export type HandoffRoutingRecordValidationResult =
  | Readonly<{ kind: 'valid' }>
  | Readonly<{ kind: 'malformed-json' }>
  | Readonly<{ kind: 'schema-violation' }>
  | Readonly<{ kind: 'envelope-body-disagreement' }>;

export type HandoffRoutingRecordValidationFailure = Exclude<
  HandoffRoutingRecordValidationResult,
  Readonly<{ kind: 'valid' }>
>;

export type HandoffRoutingRecordKind = 'selection' | 'terminal' | 'retirement';

export type HandoffRoutingRecordInput = Readonly<{
  generation: number;
  sequence: number;
  eventId: string;
  invocationId: string;
  observedAt: string;
  recordKind: HandoffRoutingRecordKind;
  eventKind: 'routing-selected' | 'execution-failed' | 'continuation-finalized' | 'retirement-tombstone';
  selectionSequence: number | null;
  retirementCause: 'selection-evicted-at-capacity' | 'completed-pair-compaction' | 'operator-resolved' | null;
  terminalExisted: boolean | null;
  bodyJson: string;
}>;

const DURABLE_VOCABULARY_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function sqlVocabularyLiteral(value: string): string {
  if (!DURABLE_VOCABULARY_IDENTIFIER_PATTERN.test(value)) {
    throw new Error('Routing-status durable vocabulary contains an unsafe identifier.');
  }
  return `'${value}'`;
}

function completedPairStableSql(vocabulary: HandoffRoutingStatusBodyVocabulary): string {
  const stability = vocabulary.completedPairStability;
  const selectionDisposition = sqlVocabularyLiteral(stability.selectionDispositionKind);
  const selectionBases = stability.selectionBasisKinds.map(sqlVocabularyLiteral).join(', ');
  const terminalDisposition = sqlVocabularyLiteral(stability.terminalDispositionKind);
  return `(
    (
      json_extract(selection.body_json, '$.disposition.kind') = ${selectionDisposition} AND
      json_extract(selection.body_json, '$.disposition.basis.kind') IN (${selectionBases})
    ) OR json_extract(terminal.body_json, '$.disposition.kind') = ${terminalDisposition}
  )`;
}

export type HandoffRoutingRetirementHistoryRow = Readonly<{
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

export type HandoffRoutingRetirementHistoryUpdate = Readonly<{
  expiredIdentityCount: number;
  capacityEvictionCount: number;
  completedPairCompactionCount: number;
  operatorResolvedCount: number;
  minSelectionSequence: number | null;
  maxSelectionSequence: number | null;
  earliestSelectedAt: string | null;
  latestSelectedAt: string | null;
}>;

export class HandoffRoutingStoreInvalidRecordError extends Error {
  readonly validation: HandoffRoutingRecordValidationFailure;

  constructor(validation: HandoffRoutingRecordValidationFailure) {
    super();
    this.validation = validation;
  }
}

export class HandoffRoutingStoreUnreadableError extends Error {
  readonly errcode: number;

  constructor(errcode = SQLITE_CORRUPT) {
    super();
    this.errcode = errcode;
  }
}

export class HandoffRoutingStoreUnsupportedGenerationError extends Error {}

export class HandoffRoutingStatusTransaction {
  readonly #database: SqliteDatabasePort;
  readonly #schema: HandoffRoutingStatusStoreSchema;

  constructor(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema) {
    this.#database = database;
    this.#schema = schema;
  }

  nextRecordSequence(): number {
    const row = this.#database
      .prepare(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'handoff_routing_records'), 0) + 1 AS next",
      )
      .get() as Readonly<{ next: number }>;
    return row.next;
  }

  insertRecord(record: HandoffRoutingRecordInput): number {
    const validation = this.#schema.validateRecordBody(record);
    if (validation.kind !== 'valid') throw new HandoffRoutingStoreInvalidRecordError(validation);
    const inserted = this.#database
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
        record.generation,
        record.eventId,
        record.invocationId,
        record.observedAt,
        record.recordKind,
        record.eventKind,
        record.selectionSequence,
        record.retirementCause,
        record.terminalExisted === null ? null : Number(record.terminalExisted),
        record.bodyJson,
      ) as Readonly<{ sequence: number }> | undefined;
    if (inserted?.sequence !== record.sequence) throw new HandoffRoutingStoreUnreadableError();
    return inserted.sequence;
  }

  recordBody(invocationId: string, recordKind: HandoffRoutingRecordKind): string | undefined {
    const row = this.#database
      .prepare('SELECT body_json FROM handoff_routing_records WHERE invocation_id = ? AND record_kind = ?')
      .get(invocationId, recordKind) as Readonly<{ body_json: string }> | undefined;
    return row?.body_json;
  }

  insertClosingReserve(invocationId: string, eventId: string, observedAt: string): void {
    this.#database
      .prepare(
        `INSERT INTO handoff_routing_closing_reserve (invocation_id, event_id, observed_at, allocation)
        VALUES (?, ?, ?, zeroblob(?))`,
      )
      .run(invocationId, eventId, observedAt, this.#schema.durableFormat.closingRecordBytes);
  }

  releaseClosingReserve(invocationId: string): boolean {
    return (
      this.#database.prepare('DELETE FROM handoff_routing_closing_reserve WHERE invocation_id = ?').run(invocationId)
        .changes === 1
    );
  }

  readRetirementHistory(): HandoffRoutingRetirementHistoryRow | undefined {
    return readRetirementHistory(this.#database);
  }

  updateRetirementHistory(update: HandoffRoutingRetirementHistoryUpdate): void {
    this.#database
      .prepare(
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
      )
      .run(
        update.expiredIdentityCount,
        update.capacityEvictionCount,
        update.completedPairCompactionCount,
        update.operatorResolvedCount,
        update.minSelectionSequence,
        update.maxSelectionSequence,
        update.earliestSelectedAt,
        update.latestSelectedAt,
      );
  }

  deleteRecord(sequence: number): void {
    this.#database.prepare('DELETE FROM handoff_routing_records WHERE sequence = ?').run(sequence);
  }

  deleteInvocationRecords(invocationId: string): void {
    this.#database.prepare('DELETE FROM handoff_routing_records WHERE invocation_id = ?').run(invocationId);
  }

  tombstoneBounds(): Readonly<{ count: number; bytes: number }> {
    return this.#database
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(encoded_bytes), 0) AS bytes
        FROM handoff_routing_records WHERE record_kind = 'retirement'`,
      )
      .get() as Readonly<{ count: number; bytes: number }>;
  }

  oldestTombstoneBody(): string | undefined {
    const row = this.#database
      .prepare(
        `SELECT body_json FROM handoff_routing_records
        WHERE record_kind = 'retirement'
        ORDER BY selection_sequence, invocation_id
        LIMIT 1`,
      )
      .get() as Readonly<{ body_json: string }> | undefined;
    return row?.body_json;
  }

  oldestCompletedSelectionBody(): string | undefined {
    const completedPairStable = completedPairStableSql(this.#schema.durableFormat.bodyVocabulary);
    const row = this.#database
      .prepare(
        `WITH latest_stable_pair AS (
          SELECT selection.sequence
          FROM handoff_routing_records AS selection
          JOIN handoff_routing_records AS terminal ON terminal.invocation_id = selection.invocation_id
          WHERE selection.record_kind = 'selection'
            AND terminal.record_kind = 'terminal'
            AND ${completedPairStable}
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
      .get() as Readonly<{ body_json: string }> | undefined;
    return row?.body_json;
  }

  hasAdmissionCapacity(recordBytes: number): boolean {
    const pageSize = this.#pragmaNumber('page_size');
    const pageCount = this.#pragmaNumber('page_count');
    const freeListCount = this.#database.prepare('PRAGMA freelist_count').get() as Readonly<{
      freelist_count: number;
    }>;
    const maxPageCount = this.#pragmaNumber('max_page_count');
    const availableBytes = (maxPageCount - pageCount + freeListCount.freelist_count) * pageSize;
    const maximumIdentifierBytes = Buffer.byteLength(
      '\u0800'.repeat(this.#schema.durableFormat.maximumIdentifierLength),
      'utf8',
    );
    const indexedEnvelopeBytes = maximumIdentifierBytes * 4 + this.#schema.durableFormat.maximumObservedAtLength * 2;
    const btreeAllocationMarginBytes = pageSize * 8;
    return availableBytes >= recordBytes + indexedEnvelopeBytes + btreeAllocationMarginBytes;
  }

  deleteOldestBoundedTerminal(): boolean {
    return (
      this.#database
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
        .run().changes === 1
    );
  }

  boundedTerminalCount(): number {
    const row = this.#database
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

  completedSelectionBodiesForCompaction(limit: number, cutoff: string): readonly string[] {
    const completedPairStable = completedPairStableSql(this.#schema.durableFormat.bodyVocabulary);
    const rows = this.#database
      .prepare(
        `WITH completed_pairs AS MATERIALIZED (
          SELECT
            selection.sequence,
            selection.observed_at,
            selection.body_json,
            ${completedPairStable} AS stable
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
      .all(limit, cutoff) as ReadonlyArray<Readonly<{ body_json: string }>>;
    return rows.map((row) => row.body_json);
  }

  unresolvedCount(): number {
    const row = this.#database
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

  oldestOpeningBody(): string | undefined {
    const row = this.#database
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
      .get() as Readonly<{ body_json: string }> | undefined;
    return row?.body_json;
  }

  eventExists(eventId: string): boolean {
    return (
      this.#database.prepare('SELECT 1 FROM handoff_routing_records WHERE event_id = ?').get(eventId) !== undefined
    );
  }

  #pragmaNumber(name: 'page_size' | 'page_count' | 'max_page_count'): number {
    const row = this.#database.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
    const value = row[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw new HandoffRoutingStoreUnreadableError();
    return value;
  }
}

export type HandoffRoutingStorePublication<T> =
  | Readonly<{ kind: 'committed'; value: T }>
  | Readonly<{ kind: 'failed'; error: unknown; commitStarted: boolean }>;

function quarantineRoot(path: string): string {
  return join(dirname(path), HANDOFF_ROUTING_STATUS_QUARANTINE_DIRECTORY);
}

function quarantineArtifact(
  fileName: string,
  databaseName: string,
): Readonly<{ id: string; artifact: HandoffRoutingStatusQuarantineArtifact }> | null {
  const prefix = `${databaseName}.`;
  if (!fileName.startsWith(prefix)) return null;
  const remainder = fileName.slice(prefix.length);
  const suffix = remainder.endsWith('-wal') ? '-wal' : remainder.endsWith('-shm') ? '-shm' : '';
  const id = suffix === '' ? remainder : remainder.slice(0, -suffix.length);
  if (!CANONICAL_UUID_PATTERN.test(id)) return null;
  return { id, artifact: suffix === '-wal' ? 'wal' : suffix === '-shm' ? 'shm' : 'database' };
}

export function listHandoffRoutingStoreQuarantines(
  storage: StoragePort,
  path: string,
): HandoffRoutingStatusQuarantineList {
  const root = quarantineRoot(path);
  if (!storage.existsSync(root)) return { entries: [], overflow: false };
  const bounded = storage.readDirectoryBoundedSync(root, MAX_HANDOFF_ROUTING_STATUS_QUARANTINE_FILES);
  const artifactsById = new Map<string, Set<HandoffRoutingStatusQuarantineArtifact>>();
  for (const fileName of bounded.entries) {
    const parsed = quarantineArtifact(fileName, basename(path));
    if (parsed === null) continue;
    const artifacts = artifactsById.get(parsed.id) ?? new Set<HandoffRoutingStatusQuarantineArtifact>();
    artifacts.add(parsed.artifact);
    artifactsById.set(parsed.id, artifacts);
  }
  const artifactOrder: readonly HandoffRoutingStatusQuarantineArtifact[] = ['database', 'wal', 'shm'];
  const entries = [...artifactsById.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, artifacts]): HandoffRoutingStatusQuarantineEntry => ({
        id,
        quarantinePath: join(root, `${basename(path)}.${id}`),
        state: artifacts.has('database') ? 'complete' : 'incomplete',
        artifacts: artifactOrder.filter((artifact) => artifacts.has(artifact)),
      }),
    );
  return { entries, overflow: bounded.overflow };
}

function moveQuarantineArtifact(storage: StoragePort, source: string, destination: string): boolean {
  if (storage.existsSync(destination)) {
    if (storage.existsSync(source)) throw new Error('Routing-status quarantine contains duplicate source evidence.');
    return false;
  }
  try {
    storage.renameSync(source, destination);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function syncQuarantineMove(storage: StoragePort, sourceDirectory: string, root: string): void {
  const sourceSynced = storage.syncDirectoryDurableSync(sourceDirectory);
  const quarantineSynced = storage.syncDirectoryDurableSync(root);
  if (!sourceSynced || !quarantineSynced) throw new Error('Routing-status quarantine directory sync failed.');
}

export function quarantineHandoffRoutingStoreArtifact(
  storage: StoragePort,
  path: string,
  quarantineId: string,
  assertOwned: () => void,
): HandoffRoutingStatusQuarantineResult {
  const sourceDirectory = dirname(path);
  const root = quarantineRoot(path);
  storage.mkdirSync(root, { recursive: true, mode: 0o700 });
  const retained = listHandoffRoutingStoreQuarantines(storage, path);
  const incomplete = retained.entries.filter((entry) => entry.state === 'incomplete');
  if (incomplete.length > 1 || retained.overflow) throw new HandoffRoutingStatusQuarantineCapacityError();
  const incompleteEntry = incomplete[0];
  if (incompleteEntry !== undefined) {
    assertOwned();
    return { kind: 'incomplete-quarantine', quarantineId: incompleteEntry.id };
  }
  if (retained.entries.length >= MAX_HANDOFF_ROUTING_STATUS_QUARANTINES) {
    throw new HandoffRoutingStatusQuarantineCapacityError();
  }
  if (!CANONICAL_UUID_PATTERN.test(quarantineId)) {
    throw new Error('Routing-status quarantine ID must be a canonical lowercase UUID.');
  }
  const quarantinePath = join(root, `${basename(path)}.${quarantineId}`);
  assertOwned();
  for (const suffix of ['-wal', '-shm'] as const) {
    if (moveQuarantineArtifact(storage, `${path}${suffix}`, `${quarantinePath}${suffix}`)) {
      syncQuarantineMove(storage, sourceDirectory, root);
    }
    assertOwned();
  }
  storage.renameSync(path, quarantinePath);
  syncQuarantineMove(storage, sourceDirectory, root);
  return { kind: 'quarantined', quarantinePath };
}

function unlinkIfPresent(storage: StoragePort, path: string): boolean {
  try {
    storage.unlinkSync(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function syncQuarantineClear(storage: StoragePort, path: string): void {
  if (!storage.syncDirectoryDurableSync(quarantineRoot(path))) {
    throw new Error('Routing-status quarantine directory sync failed.');
  }
}

export function clearHandoffRoutingStoreQuarantine(
  storage: StoragePort,
  path: string,
  quarantineId: string,
  assertOwned: () => void,
): HandoffRoutingStatusQuarantineEntry | null {
  if (!CANONICAL_UUID_PATTERN.test(quarantineId)) return null;
  const quarantinePath = join(quarantineRoot(path), `${basename(path)}.${quarantineId}`);
  const artifacts: HandoffRoutingStatusQuarantineArtifact[] = [];
  if (storage.existsSync(quarantinePath)) artifacts.push('database');
  if (storage.existsSync(`${quarantinePath}-wal`)) artifacts.push('wal');
  if (storage.existsSync(`${quarantinePath}-shm`)) artifacts.push('shm');
  if (artifacts.length === 0) return null;
  const entry: HandoffRoutingStatusQuarantineEntry = {
    id: quarantineId,
    quarantinePath,
    state: artifacts.includes('database') ? 'complete' : 'incomplete',
    artifacts,
  };
  assertOwned();
  for (const suffix of ['-wal', '-shm'] as const) {
    if (unlinkIfPresent(storage, `${entry.quarantinePath}${suffix}`)) syncQuarantineClear(storage, path);
    assertOwned();
  }
  if (unlinkIfPresent(storage, entry.quarantinePath)) syncQuarantineClear(storage, path);
  return entry;
}

export function publishHandoffRoutingStoreTransaction<T>(
  storage: StoragePort,
  path: string,
  schema: HandoffRoutingStatusStoreSchema,
  mutate: (transaction: HandoffRoutingStatusTransaction) => T,
): HandoffRoutingStorePublication<T> {
  let database: SqliteDatabasePort | undefined;
  let transactionOpen = false;
  let commitStarted = false;
  try {
    storage.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    database = storage.openSqliteDatabaseSync(path);
    databaseOwnership(database, schema);
    storage.chmodSync(path, 0o600);
    configureDatabase(database, schema.operational);
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    initializeOrValidateDatabase(database, schema);
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

export type HandoffRoutingStoreSnapshotRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unsupported-generation'; generation: number }>
  | Readonly<{
      kind: 'snapshot';
      rows: readonly unknown[];
      reserves: readonly unknown[];
      retirement: HandoffRoutingRetirementHistoryRow | undefined;
    }>
  | Readonly<{ kind: 'failed'; error: unknown }>;

export function readHandoffRoutingStoreSnapshot(
  storage: StoragePort,
  path: string,
  schema: HandoffRoutingStatusStoreSchema,
): HandoffRoutingStoreSnapshotRead {
  try {
    storage.assertReadableSync(path);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'failed', error };
  }

  let database: SqliteDatabasePort | undefined;
  let transactionOpen = false;
  try {
    database = storage.openSqliteDatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA busy_timeout=0');
    database.exec('BEGIN');
    transactionOpen = true;
    const generation = handoffRoutingStatusGeneration(schema);
    const storedGeneration = (database.prepare('PRAGMA user_version').get() as Readonly<{ user_version: number }>)
      .user_version;
    if (storedGeneration !== generation) {
      database.exec('COMMIT');
      transactionOpen = false;
      return { kind: 'unsupported-generation', generation: storedGeneration };
    }
    const schemaMatches = databaseSchemaMatches(database, schema);
    if (!schemaMatches) {
      database.exec('COMMIT');
      transactionOpen = false;
      return { kind: 'unsupported-generation', generation: storedGeneration };
    }
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
    database.exec('COMMIT');
    transactionOpen = false;
    return { kind: 'snapshot', rows, reserves, retirement };
  } catch (error) {
    rollback(database, transactionOpen, false);
    return { kind: 'failed', error };
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

function readRetirementHistory(database: SqliteDatabasePort): HandoffRoutingRetirementHistoryRow | undefined {
  return database
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
    .get() as HandoffRoutingRetirementHistoryRow | undefined;
}

function initializeOrValidateDatabase(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema): void {
  const expectedGeneration = handoffRoutingStatusGeneration(schema);
  if (databaseOwnership(database, schema) === 'initialized') return;
  database.exec(schemaSql(schema));
  database
    .prepare(
      `INSERT INTO handoff_routing_metadata (
        singleton,
        generation,
        expired_identity_count,
        capacity_eviction_count,
        completed_pair_compaction_count,
        operator_resolved_count
      ) VALUES (1, ?, 0, 0, 0, 0)`,
    )
    .run(expectedGeneration);
  database.exec(`PRAGMA user_version=${expectedGeneration}`);
}

function databaseOwnership(
  database: SqliteDatabasePort,
  schema: HandoffRoutingStatusStoreSchema,
): 'empty' | 'initialized' {
  const expectedGeneration = handoffRoutingStatusGeneration(schema);
  const storedGeneration = (database.prepare('PRAGMA user_version').get() as Readonly<{ user_version: number }>)
    .user_version;
  if (storedGeneration === 0) {
    const existing = database
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .get() as Readonly<{ count: number }>;
    if (existing.count !== 0) throw new HandoffRoutingStoreUnsupportedGenerationError();
    return 'empty';
  }
  if (storedGeneration !== expectedGeneration) {
    throw new HandoffRoutingStoreUnsupportedGenerationError();
  }
  const schemaMatches = databaseSchemaMatches(database, schema);
  if (!schemaMatches) {
    throw new HandoffRoutingStoreUnsupportedGenerationError();
  }
  try {
    const metadata = database.prepare('SELECT generation FROM handoff_routing_metadata WHERE singleton = 1').get() as
      | Readonly<{ generation: number }>
      | undefined;
    if (metadata?.generation !== expectedGeneration) throw new HandoffRoutingStoreUnreadableError();
  } catch (error) {
    if (error instanceof HandoffRoutingStoreUnreadableError) throw error;
    throw new HandoffRoutingStoreUnreadableError(errorNumber(error, SQLITE_CORRUPT));
  }
  return 'initialized';
}

const HANDOFF_ROUTING_STATUS_SCHEMA_SQL = `
    CREATE TABLE handoff_routing_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL CHECK (generation = __HANDOFF_ROUTING_STATUS_GENERATION__),
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
      generation INTEGER NOT NULL CHECK (generation = __HANDOFF_ROUTING_STATUS_GENERATION__),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND __MAXIMUM_IDENTIFIER_LENGTH__),
      invocation_id TEXT NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND __MAXIMUM_IDENTIFIER_LENGTH__),
      observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 1 AND __MAXIMUM_OBSERVED_AT_LENGTH__),
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
          encoded_bytes <= __MAXIMUM_ROUTING_SELECTED_BYTES__) OR
        (record_kind = 'terminal' AND json_extract(body_json, '$.phase') = 'terminal' AND
          ((event_kind = 'execution-failed' AND encoded_bytes <= __MAXIMUM_EXECUTION_FAILED_BYTES__) OR
           (event_kind = 'continuation-finalized' AND
            encoded_bytes <= __MAXIMUM_CONTINUATION_FINALIZED_BYTES__))) OR
        (record_kind = 'retirement' AND json_extract(body_json, '$.phase') = 'retirement' AND
          json_extract(body_json, '$.selectionSequence') = selection_sequence AND
          json_extract(body_json, '$.retirementCause') = retirement_cause AND
          json_extract(body_json, '$.terminalExisted') = terminal_existed AND
          encoded_bytes <= __MAXIMUM_RETIREMENT_TOMBSTONE_BYTES__)
      )
    ) STRICT;

    CREATE TABLE handoff_routing_closing_reserve (
      invocation_id TEXT PRIMARY KEY CHECK (length(invocation_id) BETWEEN 1 AND __MAXIMUM_IDENTIFIER_LENGTH__),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND __MAXIMUM_IDENTIFIER_LENGTH__),
      observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 1 AND __MAXIMUM_OBSERVED_AT_LENGTH__),
      allocation BLOB NOT NULL CHECK (length(allocation) = __CLOSING_RECORD_BYTES__)
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

function renderedSchemaSql(format: HandoffRoutingStatusStoreDurableFormat, generation: string): string {
  return HANDOFF_ROUTING_STATUS_SCHEMA_SQL.replaceAll('__HANDOFF_ROUTING_STATUS_GENERATION__', generation)
    .replaceAll('__MAXIMUM_IDENTIFIER_LENGTH__', String(format.maximumIdentifierLength))
    .replaceAll('__MAXIMUM_OBSERVED_AT_LENGTH__', String(format.maximumObservedAtLength))
    .replaceAll('__MAXIMUM_ROUTING_SELECTED_BYTES__', String(format.maximumRoutingSelectedBytes))
    .replaceAll('__MAXIMUM_EXECUTION_FAILED_BYTES__', String(format.maximumExecutionFailedBytes))
    .replaceAll('__MAXIMUM_CONTINUATION_FINALIZED_BYTES__', String(format.maximumContinuationFinalizedBytes))
    .replaceAll('__MAXIMUM_RETIREMENT_TOMBSTONE_BYTES__', String(format.maximumRetirementTombstoneBytes))
    .replaceAll('__CLOSING_RECORD_BYTES__', String(format.closingRecordBytes));
}

function assertCanonicalVocabulary(name: string, values: readonly string[]): void {
  for (const value of values) sqlVocabularyLiteral(value);
  const canonical = [...new Set(values)].sort();
  if (canonical.length !== values.length || canonical.some((value, index) => value !== values[index])) {
    throw new Error(`Routing-status ${name} vocabulary must be sorted and unique.`);
  }
}

function assertDurableFormat(format: HandoffRoutingStatusStoreDurableFormat): void {
  const vocabulary = format.bodyVocabulary;
  assertCanonicalVocabulary('disposition', vocabulary.dispositionKinds);
  assertCanonicalVocabulary('routing-basis', vocabulary.routingBasisKinds);
  const stability = vocabulary.completedPairStability;
  sqlVocabularyLiteral(stability.selectionDispositionKind);
  sqlVocabularyLiteral(stability.terminalDispositionKind);
  assertCanonicalVocabulary('completed-pair routing-basis', stability.selectionBasisKinds);
  if (!vocabulary.dispositionKinds.includes(stability.selectionDispositionKind)) {
    throw new Error('Routing-status completed-pair selection disposition is outside the durable vocabulary.');
  }
  if (!vocabulary.dispositionKinds.includes(stability.terminalDispositionKind)) {
    throw new Error('Routing-status completed-pair terminal disposition is outside the durable vocabulary.');
  }
  if (stability.selectionBasisKinds.some((kind) => !vocabulary.routingBasisKinds.includes(kind))) {
    throw new Error('Routing-status completed-pair basis is outside the durable vocabulary.');
  }
}

export function handoffRoutingStatusGeneration(schema: HandoffRoutingStatusStoreSchema): number {
  assertDurableFormat(schema.durableFormat);
  const fingerprint = createHash('sha256')
    .update(canonicalContractJson(schema.durableFormat), 'utf-8')
    .update('\0', 'utf-8')
    .update(renderedSchemaSql(schema.durableFormat, ''), 'utf-8')
    .update('\0', 'utf-8')
    .update(completedPairStableSql(schema.durableFormat.bodyVocabulary), 'utf-8')
    .digest();
  const { minimum, maximum } = HANDOFF_ROUTING_STATUS_GENERATION_BAND;
  const generationCount = maximum - minimum + 1;
  return (fingerprint.readUInt32BE(0) % generationCount) + minimum;
}

function schemaSql(schema: HandoffRoutingStatusStoreSchema): string {
  return renderedSchemaSql(schema.durableFormat, String(handoffRoutingStatusGeneration(schema)));
}

type HandoffRoutingSchemaObject = Readonly<{
  type: string;
  name: string;
  sql: string | null;
}>;

function canonicalSchemaSql(sql: string): string {
  return sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
}

function expectedSchemaObjects(schema: HandoffRoutingStatusStoreSchema): readonly HandoffRoutingSchemaObject[] {
  return schemaSql(schema)
    .split(';')
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0)
    .map((sql) => {
      const match = /^CREATE (?:UNIQUE )?(TABLE|INDEX) ([a-z0-9_]+)/iu.exec(sql);
      const type = match?.[1]?.toLowerCase();
      const name = match?.[2];
      if ((type !== 'table' && type !== 'index') || name === undefined) {
        throw new Error('Handoff routing schema contains an unaddressed object.');
      }
      return { type, name, sql };
    });
}

function databaseSchemaMatches(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema): boolean {
  const observed = database
    .prepare(
      `SELECT type, name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'`,
    )
    .all() as readonly HandoffRoutingSchemaObject[];
  const expected = expectedSchemaObjects(schema);
  if (observed.length !== expected.length) return false;
  const observedByName = new Map(observed.map((object) => [object.name, object]));
  return expected.every((object) => {
    const candidate = observedByName.get(object.name);
    return (
      candidate?.type === object.type &&
      candidate.sql !== null &&
      canonicalSchemaSql(candidate.sql) === canonicalSchemaSql(object.sql ?? '')
    );
  });
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

function errorNumber(error: unknown, fallback: number): number {
  if (typeof error !== 'object' || error === null) return fallback;
  const candidate = 'errcode' in error ? error.errcode : 'errno' in error ? error.errno : fallback;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : fallback;
}
