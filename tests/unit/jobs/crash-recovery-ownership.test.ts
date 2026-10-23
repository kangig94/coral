import { expect, it } from 'vitest';
import { markJobsAsError } from '#src/coordinator/lifecycle.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { initTestJob, testConversationFacet } from '#tests/helpers/session.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { EXECUTION_JOB_ID as jobId } from '#tests/helpers/job-executions.js';

function fixture() {
  const f = createRetentionFixture();
  initTestJob(f.store, {
    jobId,
    conversation: testConversationFacet('codex'),
    projectRoot: '/workspace',
    backendNamespace: 'tests',
  });
  const owner = new ExecutionFinisher({
    time: f.runtime.time,
    commit: (cb) => f.store.commit(cb),
    read: (address) => readExecutionFinishingState(f.db, address, f.store),
    quiesce: async () => true,
    retentionAction: async () => ({ attempt: 1, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
  });
  const recover = () =>
    markJobsAsError(
      f.store,
      'wrapper lost',
      f.runtime.time.now(),
      new AbortController().signal,
      (cb) => f.store.commit(cb),
      owner,
      f.runtime,
    );
  return { ...f, owner, recover };
}

it('does not steal an outcome from its live producer while storage is unavailable', async () => {
  const f = fixture();
  const sleeping = createDeferred<void>();
  const entered = createDeferred<void>();
  const unavailable = Object.assign(new Error('storage unavailable'), { code: 'EIO' });
  const owner = new ExecutionFinisher({
    time: {
      sleep: () => {
        entered.resolve();
        return sleeping.promise;
      },
    },
    commit: () => {
      throw unavailable;
    },
    read: (address) => readExecutionFinishingState(f.db, address, f.store),
    quiesce: async () => true,
    retentionAction: async () => ({ attempt: 1, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
  });
  const producer = owner.accept({ jobId, execution: 1 }, () => undefined);
  const disposed = expect(producer).rejects.toBeDefined();
  try {
    await entered.promise;
    await markJobsAsError(
      f.store,
      'wrapper lost',
      f.runtime.time.now(),
      new AbortController().signal,
      (cb) => f.store.commit(cb),
      owner,
      f.runtime,
    );
    expect(readExecutionFinishingState(f.db, { jobId, execution: 1 }, f.store).kind).toBe('unaccepted');
    expect(owner.owns({ jobId, execution: 1 })).toBe(true);
  } finally {
    await owner.dispose();
    await disposed;
    await f.owner.dispose();
    f.close();
  }
});

it.each([false, true])(
  'recovers only durable failure evidence after producer loss (recorded fault: %s)',
  async (fault) => {
    const f = fixture();
    try {
      if (fault)
        f.store.commit((c) => {
          c.append({
            type: 'job.provider_failed',
            stream: { kind: 'job', id: jobId },
            body: { execution: 1, provider: 'codex', reason: 'request_failed', message: 'original failure' },
          });
          return undefined;
        });
      await f.recover();
      const state = readExecutionFinishingState(f.db, { jobId, execution: 1 }, f.store);
      expect(state.kind).toBe('finishing');
      if (state.kind !== 'finishing') throw new Error('Expected accepted recovery');
      expect(state.accepted.terminal.outcome.kind).toBe('failed');
      expect(state.accepted.terminal.content).toBe(
        fault ? '' : 'Original result unavailable after producer loss. wrapper lost',
      );
      const types = f.db
        .prepare<[], { type: string }>('SELECT type FROM events ORDER BY seq')
        .all()
        .map((row) => row.type);
      expect(types).toEqual([
        'job.opened',
        'job.execution.requested',
        fault ? 'job.provider_failed' : 'job.interrupted',
        'job.execution.outcome.accepted',
      ]);
    } finally {
      await f.owner.dispose();
      f.close();
    }
  },
);
