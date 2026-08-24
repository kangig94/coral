import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { terminalEventSchema } from '#src/coordinator/handoff-routing-status.js';
import type { SqliteDatabasePort } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  HandoffRoutingStoreUnreadableError,
  publishHandoffRoutingStoreTransaction,
  type HandoffRoutingStatusStoreSchema,
} from '#src/store/handoff-routing-status-store.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('HandoffRoutingStatusTransaction', () => {
  it('refuses an undecodable record body before inserting a row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-store-'));
    temporaryDirectories.push(directory);
    const runtime = createRealRuntime('prod', { baseDir: directory });
    const path = join(directory, 'handoff-routing.1.db');
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
      validateRecordBody: (record) => {
        try {
          return terminalEventSchema.safeParse(JSON.parse(record.bodyJson)).success;
        } catch {
          return false;
        }
      },
    };
    expect(publishHandoffRoutingStoreTransaction(runtime.storage, path, schema, () => undefined)).toEqual({
      kind: 'committed',
      value: undefined,
    });

    const bodyJson = JSON.stringify({
      generation: 1,
      sequence: 1,
      eventId: 'event-1',
      invocationId: 'invocation-1',
      observedAt: '2026-08-03T00:00:00.000Z',
      eventKind: 'continuation-finalized',
      phase: 'terminal',
      selection: { kind: 'with-selection-sequence', selectionSequence: 1 },
      disposition: { kind: 'delegated-exit', version: '0.10.9', exitCode: 999 },
    });
    const publication = publishHandoffRoutingStoreTransaction(runtime.storage, path, schema, (transaction) =>
      transaction.insertRecord({
        generation: 1,
        sequence: 1,
        eventId: 'event-1',
        invocationId: 'invocation-1',
        observedAt: '2026-08-03T00:00:00.000Z',
        recordKind: 'terminal',
        eventKind: 'continuation-finalized',
        selectionSequence: 1,
        retirementCause: null,
        terminalExisted: null,
        completedPairStable: false,
        bodyJson,
      }),
    );

    expect(publication).toMatchObject({
      kind: 'failed',
      error: expect.any(HandoffRoutingStoreUnreadableError),
      commitStarted: false,
    });
    const database = new DatabaseSync(path) as unknown as SqliteDatabasePort;
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM handoff_routing_records').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
