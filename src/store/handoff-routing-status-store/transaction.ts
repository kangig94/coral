import type { SqliteDatabasePort } from '../../infra/port-types.js';

import { completedPairStableSql, type HandoffRoutingStatusStoreSchema } from './durable-format.js';

export const SQLITE_BUSY = 5;
export const SQLITE_FULL = 13;
export const SQLITE_NOTADB = 26;
export const SQLITE_CORRUPT = 11;
export const SQLITE_ERROR = 1;

export type HandoffRoutingRecordKind = 'selection' | 'terminal' | 'retirement';

export type HandoffRoutingRecordValidationResult =
  | Readonly<{ kind: 'valid' }>
  | Readonly<{ kind: 'malformed-json' }>
  | Readonly<{ kind: 'schema-violation' }>
  | Readonly<{ kind: 'envelope-body-disagreement' }>;

export type HandoffRoutingRecordValidationFailure = Exclude<
  HandoffRoutingRecordValidationResult,
  Readonly<{ kind: 'valid' }>
>;

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

export function readRetirementHistory(database: SqliteDatabasePort): HandoffRoutingRetirementHistoryRow | undefined {
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
