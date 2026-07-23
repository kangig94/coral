import { afterEach, describe, expect, it } from 'vitest';

import { adoptOrphanedCrossNamespaceJobs } from '#src/jobs/reconcile/cross-namespace-adoption.js';

import { createHandoffCoresHarness, type HandoffCoresHarness } from './handoff-cores-harness.js';

const harnesses: HandoffCoresHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
});

describe('cross-namespace coordinator handoff', () => {
  it('finalizes an incumbent live job from durable state during replacement startup', async () => {
    const harness = createHandoffCoresHarness();
    harnesses.push(harness);

    const incumbent = await harness.bootCore({ instanceId: 'incumbent', backendNamespace: 'namespace-a' });
    const progressStore = incumbent.core.storeServicesRef.get().progressStore;
    const jobId = 'foreign-kb-job';
    const projectRoot = '/handoff/cross-namespace';
    const createdAt = new Date(harness.runtime.time.now()).toISOString();

    progressStore.appendLaunchRequested(jobId, {
      jobId,
      owner: { kind: 'system-task', id: 'kb.reindex:foreign-kb-job' },
      sessionId: null,
      provider: null,
      projectRoot,
      backendNamespace: 'namespace-a',
      jobKind: 'kb',
      pool: 'curate',
      enqueueSequence: progressStore.nextEnqueueSequence(),
      operation: 'kb.reindex',
      request: {},
      createdAt,
    });
    progressStore.commit((commit) => {
      commit.append({
        type: 'job.runtime.started',
        stream: { kind: 'job', id: jobId },
        namespace: 'namespace-a',
        project: projectRoot,
        refs: { jobId },
        body: {
          transport: 'internal',
          operation: 'kb.reindex',
          owner: 'kb-daemon',
          startedAt: createdAt,
        },
      });
      return undefined;
    });
    expect(progressStore.readStatus(jobId)?.phase).toBe('running');

    await incumbent.shutdown('replaced');

    const replacement = await harness.bootCore({
      instanceId: 'replacement',
      backendNamespace: 'namespace-b',
      runStartupRecoveryFn: async ({ identity, progressStore: replacementStore, runtime }) => {
        adoptOrphanedCrossNamespaceJobs(identity.namespace, replacementStore, runtime.time.now(), identity.log);
        return [];
      },
    });

    const adopted = replacement.core.storeServicesRef.get().progressStore.readStatus(jobId);
    expect(adopted).toMatchObject({
      phase: 'error',
      backendNamespace: 'namespace-a',
      result: {
        outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
      },
    });
  });
});
