import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { JobStore } from '#src/jobs/store.js';
import { PostCommitConsumerError } from '#src/store/append.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  executionHarness,
  openedJob,
  requestedExecution,
  EXECUTION_JOB_ID as jobId,
} from '#tests/helpers/job-executions.js';

it('publishes one completion for each ended execution with its ordinal', () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-execution-completed-'));
  const h = executionHarness();
  try {
    const eventBus = new TypedEventBus();
    const completed = vi.fn();
    const requested = vi.fn();
    eventBus.on('job:completed', completed);
    eventBus.on('job:requested', requested);
    const store = new JobStore('tests', createRealRuntime('prod', { baseDir: root }), h.ctx.bodyCodec, {
      db: h.db,
      providers: h.ctx.providers,
      reducers: h.ctx.reducers,
      eventBus,
    });
    store.commit((c) => {
      c.append(openedJob());
      c.append(requestedExecution());
      return undefined;
    });
    store.settleForeignCommit(h.complete(1));
    store.commit((c) => {
      c.append(requestedExecution(2));
      return undefined;
    });
    store.settleForeignCommit(h.complete(2));
    expect(completed.mock.calls.map(([payload]) => ({ jobId: payload.jobId, execution: payload.execution }))).toEqual([
      { jobId, execution: 1 },
      { jobId, execution: 2 },
    ]);
    expect(requested.mock.calls.map(([payload]) => payload.execution)).toEqual([1, 2]);
  } finally {
    h.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("announces a completion, runs its committer's consumers and reports it durable when an observer fails", async () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-execution-completed-'));
  const h = executionHarness();
  try {
    const eventBus = new TypedEventBus();
    const completed = vi.fn();
    eventBus.on('job:completed', completed);
    const store = new JobStore('tests', createRealRuntime('prod', { baseDir: root }), h.ctx.bodyCodec, {
      db: h.db,
      providers: h.ctx.providers,
      reducers: h.ctx.reducers,
      eventBus,
      observer: (appended) => {
        if (appended.some(({ type }) => type === 'job.execution.ended')) throw new Error('observer failure');
      },
    });
    store.commit((c) => {
      c.append(openedJob());
      c.append(requestedExecution());
      return undefined;
    });
    const woken = store.waitForChange(store.getChangeSeq());
    const ended = h.complete(1);
    const downstream = vi.fn();

    let failure: unknown;
    try {
      store.settleForeignCommit(ended, [
        () => {
          throw new Error('downstream failure');
        },
        downstream,
      ]);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PostCommitConsumerError);
    expect((failure as PostCommitConsumerError).appended).toEqual(ended);
    expect((failure as PostCommitConsumerError).errors.map((error: Error) => error.message)).toEqual([
      'observer failure',
      'downstream failure',
    ]);
    expect(completed).toHaveBeenCalledOnce();
    expect(downstream).toHaveBeenCalledWith(ended);
    await woken;
  } finally {
    h.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
