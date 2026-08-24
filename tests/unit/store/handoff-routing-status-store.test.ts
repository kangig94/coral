import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateStatusRecordBody } from '#src/coordinator/handoff-routing-status.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  HandoffRoutingStoreInvalidRecordError,
  HandoffRoutingStoreUnreadableError,
  publishHandoffRoutingStoreTransaction,
  type HandoffRoutingRecordInput,
  type HandoffRoutingStatusStoreSchema,
} from '#src/store/handoff-routing-status-store.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const temporaryDirectories: string[] = [];
const owner = { pid: 101, incarnation: testIncarnation(101) } as const;
const selectedDisposition = { kind: 'continue-current', basis: { kind: 'incumbent-absent' } } as const;

const schema: HandoffRoutingStatusStoreSchema = {
  generation: 1,
  maximumBytes: 1_048_576,
  maximumIdentifierLength: 58,
  maximumObservedAtLength: 24,
  maximumRoutingSelectedBytes: 4_096,
  maximumExecutionFailedBytes: 4_096,
  maximumContinuationFinalizedBytes: 4_096,
  maximumRetirementTombstoneBytes: 4_096,
  closingRecordBytes: 4_096,
  validateRecordBody: validateStatusRecordBody,
};

const selectionBody = {
  generation: 1,
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
  generation: 1,
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
  generation: 1,
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
    completedPairStable: false,
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
  return join(directory, 'handoff-routing.1.db');
}

function initializeStore(path: string): void {
  expect(
    publishHandoffRoutingStoreTransaction(
      createRealRuntime('prod', { baseDir: dirname(path) }).storage,
      path,
      schema,
      () => undefined,
    ),
  ).toEqual({
    kind: 'committed',
    value: undefined,
  });
}

function publishRecord(path: string, record: HandoffRoutingRecordInput) {
  const runtime = createRealRuntime('prod', { baseDir: dirname(path) });
  return publishHandoffRoutingStoreTransaction(runtime.storage, path, schema, (transaction) =>
    transaction.insertRecord(record),
  );
}

function expectInvalidRecord(path: string, record: HandoffRoutingRecordInput): void {
  initializeStore(path);
  const publication = publishRecord(path, record);

  expect(publication).toMatchObject({
    kind: 'failed',
    error: expect.any(HandoffRoutingStoreInvalidRecordError),
    commitStarted: false,
  });
  if (publication.kind !== 'failed') throw new Error('Expected invalid record publication to fail');
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
  it('rejects malformed JSON through the production validator before inserting a row', () => {
    expectInvalidRecord(databasePath(), { ...legalRecords[1].record, bodyJson: '{' });
  });

  it('rejects a schema-invalid record through the production validator before inserting a row', () => {
    expectInvalidRecord(databasePath(), {
      ...legalRecords[1].record,
      bodyJson: JSON.stringify({
        ...terminalBody,
        disposition: { kind: 'delegated-exit', version: '0.10.9', exitCode: 999 },
      }),
    });
  });

  it.each([
    ['selection', { ...legalRecords[0].record, selectionSequence: 1 }],
    ['terminal', { ...legalRecords[1].record, selectionSequence: 2 }],
    ['retirement', { ...legalRecords[2].record, terminalExisted: true }],
  ] as const)('rejects a %s envelope/body disagreement through the production validator', (_name, record) => {
    expectInvalidRecord(databasePath(), record);
  });

  it.each(legalRecords)('accepts a legal $name record through the production validator', ({ record }) => {
    const path = databasePath();
    expect(publishRecord(path, record)).toEqual({ kind: 'committed', value: 1 });
  });
});
