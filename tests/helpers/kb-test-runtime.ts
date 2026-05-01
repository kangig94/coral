import type { Database } from 'better-sqlite3';

import type { CorpusConsumerApplyContext } from '#src/store/consumer-contract.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { asReadonlyDatabase, type ReadonlyDatabase } from '#src/store/read-port.js';
import { normalizeCorpusCursor, readCorpusState } from '#src/kb/state/corpus-state.js';
import { createTestKbRuntime, type CreateTestKbRuntimeOptions } from '#tests/fixtures/test-runtime.js';

export type KbTestRuntime = {
  kb: KbRuntime;
  readDb: ReadonlyDatabase;
};

export function createKbTestRuntime(options: CreateTestKbRuntimeOptions): KbTestRuntime {
  return {
    kb: createTestKbRuntime(options),
    readDb: asReadonlyDatabase(options.db),
  };
}

export function createCorpusApplyContext(
  kb: KbRuntime,
  db: Database,
  snapshot = kb.captureCorpusSnapshot(),
): CorpusConsumerApplyContext {
  return {
    snapshot,
    journalReader: {
      readCursor: (consumerId) =>
        (
          db.prepare('SELECT cursor FROM consumer_cursors WHERE consumer_id = ?').get(consumerId) as
            | { cursor: number | null }
            | undefined
        )?.cursor ?? 0,
    },
    corpusStateReader: {
      readConsumerCursor: (consumerId) =>
        normalizeCorpusCursor(
          db
            .prepare(
              `
                SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
                  FROM consumer_cursors
                 WHERE consumer_id = ?
              `,
            )
            .get(consumerId) as Parameters<typeof normalizeCorpusCursor>[0],
        ),
      readCurrentSnapshot: () => readCorpusState(db),
    },
    projectionInput: createKbProjectionInput(kb),
    signal: new AbortController().signal,
  };
}

export async function applyBoundCorpusConsumerForTest(kb: KbRuntime, db: Database): Promise<void> {
  const consumer = kb.fts.read().consumer;
  const controller = new AbortController();
  if ('apply' in consumer && typeof consumer.apply === 'function') {
    await consumer.apply({
      ...createCorpusApplyContext(kb, db),
      projectionInput: await kb.corpusProjectionReader.prepareCurrentProjectionInput({ signal: controller.signal }),
      signal: controller.signal,
    });
  }
  if ('projectionSync' in consumer && consumer.projectionSync === 'text-index') {
    kb.recordIndexSyncSuccess();
  }
}
