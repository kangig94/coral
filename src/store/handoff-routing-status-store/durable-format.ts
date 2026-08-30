import { createHash } from 'node:crypto';

import type { SqliteDatabasePort } from '../../infra/port-types.js';
import { canonicalContractJson, type CanonicalContractValue } from '../../infra/persisted-contract.js';
import type {
  HandoffRoutingRecordInput,
  HandoffRoutingRecordKind,
  HandoffRoutingRecordValidationResult,
} from './transaction.js';

const HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH = 10;
export const HANDOFF_ROUTING_STATUS_GENERATION_BAND = {
  minimum: 10 ** (HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH - 1),
  // `PRAGMA user_version` cannot store a value above the signed 32-bit maximum.
  maximum: Math.min(10 ** HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH - 1, 2 ** 31 - 1),
  decimalWidth: HANDOFF_ROUTING_STATUS_GENERATION_DECIMAL_WIDTH,
} as const;

export type HandoffRoutingStatusBodyVocabulary = Readonly<{
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
  recordContracts: Readonly<Record<HandoffRoutingRecordKind, CanonicalContractValue>>;
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

const DURABLE_VOCABULARY_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function sqlVocabularyLiteral(value: string): string {
  if (!DURABLE_VOCABULARY_IDENTIFIER_PATTERN.test(value)) {
    throw new Error('Routing-status durable vocabulary contains an unsafe identifier.');
  }
  return `'${value}'`;
}

export function completedPairStableSql(vocabulary: HandoffRoutingStatusBodyVocabulary): string {
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

const HANDOFF_ROUTING_STATUS_SCHEMA_SQL = `
    CREATE TABLE handoff_routing_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL CHECK (generation = __HANDOFF_ROUTING_STATUS_GENERATION__),
      fingerprint BLOB NOT NULL CHECK(typeof(fingerprint) = 'blob' AND length(fingerprint) = 32),
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

type PersistedContractNode = Readonly<{ [key: string]: CanonicalContractValue }>;

function persistedContractNode(value: CanonicalContractValue): PersistedContractNode | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as PersistedContractNode) : null;
}

function indexPersistedContractNodes(
  value: CanonicalContractValue,
  nodesById: Map<number, PersistedContractNode>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) indexPersistedContractNodes(item, nodesById);
    return;
  }
  const node = persistedContractNode(value);
  if (node === null) return;
  if (typeof node.$id === 'number') nodesById.set(node.$id, node);
  for (const child of Object.values(node)) indexPersistedContractNodes(child, nodesById);
}

function resolvePersistedContractNode(
  value: CanonicalContractValue,
  nodesById: ReadonlyMap<number, PersistedContractNode>,
): PersistedContractNode | null {
  const node = persistedContractNode(value);
  if (node === null) return null;
  return typeof node.$ref === 'number' ? (nodesById.get(node.$ref) ?? null) : node;
}

function persistedContractValuesAtFieldPath(
  value: CanonicalContractValue,
  fieldPath: readonly string[],
  nodesById: ReadonlyMap<number, PersistedContractNode>,
): readonly CanonicalContractValue[] {
  const node = resolvePersistedContractNode(value, nodesById);
  if (node === null) return [];
  if (fieldPath.length === 0) return [node];
  const [field, ...remainingPath] = fieldPath;
  if (field === undefined) return [node];
  if (node.type === 'ZodObject') {
    const fields = persistedContractNode(node.fields);
    const child = fields?.[field];
    return child === undefined ? [] : persistedContractValuesAtFieldPath(child, remainingPath, nodesById);
  }
  if ((node.type === 'ZodUnion' || node.type === 'ZodDiscriminatedUnion') && Array.isArray(node.options)) {
    return node.options.flatMap((option) => persistedContractValuesAtFieldPath(option, fieldPath, nodesById));
  }
  const wrapped =
    node.type === 'ZodEffects' || node.type === 'ZodPipeline'
      ? node.input
      : node.type === 'ZodLazy'
        ? node.value
        : node.inner;
  return wrapped === undefined ? [] : persistedContractValuesAtFieldPath(wrapped, fieldPath, nodesById);
}

function persistedContractValueAcceptsStringLiteral(
  value: CanonicalContractValue,
  expected: string,
  nodesById: ReadonlyMap<number, PersistedContractNode>,
  visitedIds: ReadonlySet<number> = new Set<number>(),
): boolean {
  const node = resolvePersistedContractNode(value, nodesById);
  if (node === null) return false;
  const id = typeof node.$id === 'number' ? node.$id : undefined;
  if (id !== undefined && visitedIds.has(id)) return false;
  const nextVisited = id === undefined ? visitedIds : new Set([...visitedIds, id]);
  if (node.type === 'ZodLiteral') return node.value === expected;
  if (node.type === 'ZodEnum') return Array.isArray(node.values) && node.values.some((item) => item === expected);
  if ((node.type === 'ZodUnion' || node.type === 'ZodDiscriminatedUnion') && Array.isArray(node.options)) {
    return node.options.some((option) =>
      persistedContractValueAcceptsStringLiteral(option, expected, nodesById, nextVisited),
    );
  }
  const wrapped =
    node.type === 'ZodEffects' || node.type === 'ZodPipeline'
      ? node.input
      : node.type === 'ZodLazy'
        ? node.value
        : node.inner;
  return wrapped !== undefined && persistedContractValueAcceptsStringLiteral(wrapped, expected, nodesById, nextVisited);
}

function persistedContractFieldAcceptsStringLiteral(
  contract: CanonicalContractValue,
  fieldPath: readonly string[],
  expected: string,
): boolean {
  const nodesById = new Map<number, PersistedContractNode>();
  indexPersistedContractNodes(contract, nodesById);
  return persistedContractValuesAtFieldPath(contract, fieldPath, nodesById).some((value) =>
    persistedContractValueAcceptsStringLiteral(value, expected, nodesById),
  );
}

function assertDurableFormat(format: HandoffRoutingStatusStoreDurableFormat): void {
  const stability = format.bodyVocabulary.completedPairStability;
  sqlVocabularyLiteral(stability.selectionDispositionKind);
  sqlVocabularyLiteral(stability.terminalDispositionKind);
  assertCanonicalVocabulary('completed-pair routing-basis', stability.selectionBasisKinds);
  if (
    !persistedContractFieldAcceptsStringLiteral(
      format.recordContracts.selection,
      ['disposition', 'kind'],
      stability.selectionDispositionKind,
    )
  ) {
    throw new Error('Routing-status completed-pair selection disposition is outside the durable vocabulary.');
  }
  if (
    !persistedContractFieldAcceptsStringLiteral(
      format.recordContracts.terminal,
      ['disposition', 'kind'],
      stability.terminalDispositionKind,
    )
  ) {
    throw new Error('Routing-status completed-pair terminal disposition is outside the durable vocabulary.');
  }
  if (
    stability.selectionBasisKinds.some(
      (kind) =>
        !persistedContractFieldAcceptsStringLiteral(
          format.recordContracts.selection,
          ['disposition', 'basis', 'kind'],
          kind,
        ),
    )
  ) {
    throw new Error('Routing-status completed-pair basis is outside the durable vocabulary.');
  }
}

export function handoffRoutingStatusFingerprint(schema: HandoffRoutingStatusStoreSchema): Buffer {
  assertDurableFormat(schema.durableFormat);
  return createHash('sha256')
    .update(canonicalContractJson(schema.durableFormat), 'utf-8')
    .update('\0', 'utf-8')
    .update(renderedSchemaSql(schema.durableFormat, ''), 'utf-8')
    .update('\0', 'utf-8')
    .update(completedPairStableSql(schema.durableFormat.bodyVocabulary), 'utf-8')
    .digest();
}

export function handoffRoutingStatusGeneration(schema: HandoffRoutingStatusStoreSchema): number {
  const fingerprint = handoffRoutingStatusFingerprint(schema);
  const { minimum, maximum } = HANDOFF_ROUTING_STATUS_GENERATION_BAND;
  const generationCount = maximum - minimum + 1;
  return (fingerprint.readUInt32BE(0) % generationCount) + minimum;
}

export function schemaSql(schema: HandoffRoutingStatusStoreSchema): string {
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

export function databaseSchemaMatches(database: SqliteDatabasePort, schema: HandoffRoutingStatusStoreSchema): boolean {
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
