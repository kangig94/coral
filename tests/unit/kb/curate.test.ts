import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type * as CorpusScanMod from '#src/kb/corpus/rescan/scan.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import { createCurateScheduler, type CurateHandle } from '#src/kb/curate/scheduler.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { INVARIANT, readCurateState, writeCurateState } from '#src/kb/curate/state/index.js';
import { curateDb } from '#src/kb/curate/db-access.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { KbIndex } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { bindOramaFtsForTest } from '#tests/unit/kb/expansion-test-helpers.js';
import { createDeferred } from '#tools/testing/deferred.js';

vi.mock('#src/kb/corpus/rescan/scan-worker.js', async () => {
  const actual = await vi.importActual<typeof CorpusScanMod>('#src/kb/corpus/rescan/scan.js');
  return {
    CORPUS_SCAN_WORKER_TIMEOUT_MS: 120_000,
    buildCorpusScanViewInWorker: vi.fn(async (...args: Parameters<typeof actual.buildCorpusScanView>) =>
      actual.buildCorpusScanView(...args),
    ),
  };
});

let root: string;
let kb: KbRuntime;
let runtime: ReturnType<typeof createRealRuntime>;
let db: ReturnType<typeof openKbTestStoreDb>;
let scheduler: CurateHandle | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coral-kb-curate-'));
  runtime = createRealRuntime('prod', { baseDir: root });
  db = openKbTestStoreDb(':memory:');
  ({ kb } = createKbTestRuntime({ markdownRoot: root, runtimeDir: root, db, runtime }));
  bindOramaFtsForTest(kb);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
  scheduler = undefined;
});

afterEach(async () => {
  await scheduler?.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function createScheduler(assistant: CurateAssistantPort) {
  scheduler = createCurateScheduler({
    kb,
    curateAssistant: assistant,
    processPort: runtime.process,
    storagePort: runtime.storage,
    envPort: runtime.env,
    usageBudget: { isExhausted: async () => false },
    scheduleDebounceMs: 1000,
  });
  return scheduler;
}

it('stop aborts active classification and clears the claim without recording a retry', async () => {
  mkdirSync(kb.notesDir(), { recursive: true });
  const entries: KbIndex['entries'] = {};
  for (let i = 1; i <= 10; i += 1) {
    const slug = `stop-${i}`;
    const body = 'Body.';
    writeFileSync(
      kb.notePath(slug),
      `---\ntags: [coral]\nprinciples: []\nsource: [kangig94/coral]\ncreatedAt: 2026-03-20T00:00:00.000Z\nupdatedAt: 2026-03-20T00:00:00.000Z\nentrySeq: ${i}\n---\n# ${slug}\n\n${body}\n`,
    );
    entries[`note:${slug}`] = buildNoteIndexEntry({
      slug,
      title: slug,
      body,
      tags: ['coral'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:00.000Z',
      entrySeq: i,
    });
  }
  kb.writeIndex({ entries, principles: {}, entityMeta: {}, relationships: [] });
  kb.writeIndexState({ contentSeq: 10, metadataSeq: 10 });
  writeCurateState(curateDb(kb), { ...readCurateState(curateDb(kb)), initialized: true });
  const entered = createDeferred<AbortSignal>();
  const complete = vi.fn<CurateAssistantPort['complete']>(async ({ signal }) => {
    if (!signal) throw new Error('Expected classification signal');
    entered.resolve(signal);
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('classification aborted')), { once: true });
    });
  });
  const handle = createScheduler({ complete });
  await handle.start();
  vi.advanceTimersByTime(1000);
  const signal = await entered.promise;
  expect(readCurateState(curateDb(kb)).activeClaim).not.toBeNull();

  await handle.stop();

  expect(signal.aborted).toBe(true);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(readCurateState(curateDb(kb))).toMatchObject({
    activeClaim: null,
    retryNotBefore: null,
    consecutiveClaimFailures: 0,
  });
  expect(handle.isRunning()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('retries an uncommitted topology batch after a mutation-lock failure', async () => {
  await kb.writeEntityGraph({
    entityMeta: {
      graph: { type: 'concept', description: 'Graph retrieval.' },
      retrieval: { type: 'operation', description: 'Retrieval workflows.' },
    },
    relationships: [
      { source: 'graph', target: 'retrieval', type: 'enables', description: 'Graph retrieval.', evidence: [] },
    ],
  });
  writeCurateState(curateDb(kb), {
    ...readCurateState(curateDb(kb)),
    initialized: true,
    consecutiveClaimFailures: INVARIANT.MAX_CONSECUTIVE_FAILURES,
    claimLaneDisabledAt: '2026-03-25T00:00:00.000Z',
  });
  const handle = createScheduler({ complete: async () => '[]' });
  await handle.start();
  vi.spyOn(kb, 'withMutationLock').mockRejectedValueOnce(new Error('topology failed'));

  await vi.advanceTimersByTimeAsync(1000);

  expect(readCurateState(curateDb(kb))).toMatchObject({ consecutiveCommunityBatchFailures: 1 });
  expect(kb.generatedCommunityProjectionStore.readActiveGeneration().records).toEqual([]);

  await vi.advanceTimersByTimeAsync(10_000);

  expect(kb.generatedCommunityProjectionStore.readActiveGeneration().records.length).toBeGreaterThan(0);
  expect(readCurateState(curateDb(kb)).consecutiveCommunityBatchFailures).toBe(0);
});
