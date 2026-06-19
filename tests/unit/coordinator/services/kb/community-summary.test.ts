import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunCommunitySummaryJob } from '#src/coordinator/services/kb/community-summary.js';
import { KbJobRecorder } from '#src/coordinator/services/kb/recorder.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import * as summaryAgent from '#src/kb/curate/community/summary-agent.js';
import { AbortError } from '#src/runtime/abort.js';

function createHarness(): { recorder: KbJobRecorder; progressStore: JobStore } {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  const runtime = new SimulationRuntime();
  const progressStore = new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), {
    db,
    providers: permissiveProviderLookupPort,
  });
  const recorder = new KbJobRecorder({
    runtime,
    progressStore,
    backendNamespace: 'test-ns',
    bundleHash: 'bundle-a',
    abortRegistry: new AbortRegistry(runtime.ids),
  });
  return { recorder, progressStore };
}

const fakeKb = {} as KbRuntime;
const noopAssistant: CurateAssistantPort = { complete: async () => '' };

const liveSignal = (): AbortSignal => new AbortController().signal;

describe('createRunCommunitySummaryJob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a kb.community_summary job reaching a completed terminal', async () => {
    const { recorder, progressStore } = createHarness();
    vi.spyOn(summaryAgent, 'runCommunitySummaryAgent').mockResolvedValue(true);

    const run = createRunCommunitySummaryJob({
      kb: fakeKb,
      curateAssistant: noopAssistant,
      recorder,
      projectRoot: '/workspace/coral',
    });

    await expect(run(liveSignal())).resolves.toBe(true);

    const projections = progressStore.listJobProjections();
    expect(projections.length).toBe(1);
    const jobId = projections[0].jobId;
    const detail = progressStore.loadJobProjectionDetail(jobId);
    expect(detail.launch?.jobKind).toBe('kb');
    expect(detail.launch?.operation).toBe('kb.community_summary');
    expect(progressStore.readStatus(jobId)?.phase).toBe('completed');
  });

  it('records completed (empty work-list) without spawning, returning false', async () => {
    const { recorder, progressStore } = createHarness();
    vi.spyOn(summaryAgent, 'runCommunitySummaryAgent').mockResolvedValue(false);

    const run = createRunCommunitySummaryJob({
      kb: fakeKb,
      curateAssistant: noopAssistant,
      recorder,
      projectRoot: '/workspace/coral',
    });

    await expect(run(liveSignal())).resolves.toBe(false);

    const jobId = progressStore.listJobProjections()[0].jobId;
    expect(progressStore.readStatus(jobId)?.phase).toBe('completed');
  });

  it('records an error terminal and rethrows when the agent turn fails', async () => {
    const { recorder, progressStore } = createHarness();
    vi.spyOn(summaryAgent, 'runCommunitySummaryAgent').mockRejectedValue(new Error('turn failed'));

    const run = createRunCommunitySummaryJob({
      kb: fakeKb,
      curateAssistant: noopAssistant,
      recorder,
      projectRoot: '/workspace/coral',
    });

    await expect(run(liveSignal())).rejects.toThrow('turn failed');

    const jobId = progressStore.listJobProjections()[0].jobId;
    expect(progressStore.readStatus(jobId)?.phase).toBe('error');
  });

  it('records an aborted terminal on user abort and returns false', async () => {
    const { recorder, progressStore } = createHarness();
    const abortError = new AbortError({ stage: 'community-summary', reason: 'user_abort' });
    vi.spyOn(summaryAgent, 'runCommunitySummaryAgent').mockRejectedValue(abortError);

    const run = createRunCommunitySummaryJob({
      kb: fakeKb,
      curateAssistant: noopAssistant,
      recorder,
      projectRoot: '/workspace/coral',
    });

    await expect(run(liveSignal())).resolves.toBe(false);

    const jobId = progressStore.listJobProjections()[0].jobId;
    expect(progressStore.readStatus(jobId)?.phase).toBe('aborted');
  });

  it('records a queue_shutdown aborted terminal (no failure) when the scheduler run signal aborts', async () => {
    const { recorder, progressStore } = createHarness();
    const runController = new AbortController();
    const abortError = new AbortError({ stage: 'community-summary' });
    vi.spyOn(summaryAgent, 'runCommunitySummaryAgent').mockImplementation(async () => {
      runController.abort();
      throw abortError;
    });

    const run = createRunCommunitySummaryJob({
      kb: fakeKb,
      curateAssistant: noopAssistant,
      recorder,
      projectRoot: '/workspace/coral',
    });

    await expect(run(runController.signal)).resolves.toBe(false);

    const jobId = progressStore.listJobProjections()[0].jobId;
    // A scheduler stop is an abort, not a failure — it must not trip backoff.
    expect(progressStore.readStatus(jobId)?.phase).toBe('aborted');
  });
});
