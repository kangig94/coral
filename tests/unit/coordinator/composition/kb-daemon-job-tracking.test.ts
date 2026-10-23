import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKbDaemonJobTracking } from '#src/coordinator/composition/kb-daemon-job-tracking.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/store.js';
import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { SuccessionWriterParkedError } from '#src/store/db.js';
import {
  executionHarness,
  EXECUTION_JOB_ID,
  EXECUTION_NOW,
  requestedExecution,
} from '#tests/helpers/job-executions.js';
import { createMockKbDaemonSupervisor, createOnlineKbDaemonHealth } from '#tools/testing/kb-daemon-supervisor.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const fixtures: ReturnType<typeof executionHarness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of fixtures.splice(0)) journal.db.close();
});

function fixture() {
  const runtime = new SimulationRuntime();
  const journal = executionHarness();
  fixtures.push(journal);
  const stream = { kind: 'job', id: EXECUTION_JOB_ID } as const;
  journal.append(
    {
      type: 'job.opened',
      stream,
      body: {
        jobKind: 'kb',
        owner: { kind: 'system-task', id: 'kb-daemon' },
        projectRoot: '/workspace',
        createdAt: EXECUTION_NOW,
      },
    },
    requestedExecution(1, { input: { operation: 'kb.reindex', request: {} } }),
    {
      type: 'job.execution.started',
      stream,
      body: {
        execution: 1,
        transport: 'internal',
        operation: 'kb.reindex',
        owner: 'kb-daemon',
        startedAt: EXECUTION_NOW,
      },
    },
  );
  const store = new JobStore('tests', runtime, journal.ctx.bodyCodec, {
    db: journal.db,
    reducers: journal.ctx.reducers,
    providers: journal.ctx.providers,
  });
  const abortRegistry = new AbortRegistry();
  let quiescent = false;
  const quiesce = vi.fn(async () => quiescent);
  const finisher = new ExecutionFinisher({
    time: runtime.time,
    commit: (write) => store.commit(write),
    read: (address) => readExecutionFinishingState(journal.db, address, store),
    quiesce,
    retentionAction: async () => ({ attempt: 0, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
  });
  let exitCallback: Parameters<NonNullable<ReturnType<typeof createMockKbDaemonSupervisor>['onExit']>>[0] | undefined;
  const unsubscribe = vi.fn();
  const tracking = createKbDaemonJobTracking({
    runtime,
    world: { log: vi.fn(), eventBus: new TypedEventBus() },
    getProgressStore: () => store,
    internalJobAbortRegistry: abortRegistry,
    executionFinisher: finisher,
    kbDaemonSupervisor: createMockKbDaemonSupervisor({
      onExit: (callback) => {
        exitCallback = callback;
        return unsubscribe;
      },
    }),
  });
  return {
    runtime,
    journal,
    store,
    finisher,
    abortRegistry,
    tracking,
    quiesce,
    unsubscribe,
    exit: () => {
      if (exitCallback === undefined) throw new Error('Expected a daemon exit listener');
      exitCallback(createOnlineKbDaemonHealth({ phase: 'stopped', lastError: 'daemon exited' }));
    },
    settle: async () => {
      quiescent = true;
      const finishing = finisher.finish({ jobId: EXECUTION_JOB_ID, execution: 1 });
      await Promise.resolve();
      await Promise.resolve();
      runtime.time.tick(500);
      await finishing;
    },
  };
}

describe('KB daemon exit settlement across succession', () => {
  it('records the exit only after the parked writer settles', async () => {
    const f = fixture();
    let unpark!: () => void;
    const unparked = new Promise<void>((resolve) => {
      unpark = resolve;
    });
    const listJobIds = f.store.listJobIds.bind(f.store);
    let parked = true;
    vi.spyOn(f.store, 'listJobIds').mockImplementation(() => {
      if (parked) throw new SuccessionWriterParkedError(unparked);
      return listJobIds();
    });
    f.exit();
    expect(f.journal.events().filter((event) => event.type === 'job.execution.outcome.accepted')).toEqual([]);
    parked = false;
    unpark();
    await unparked;
    expect(f.journal.events().filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
    expect(readExecutionFinishingState(f.journal.db, { jobId: EXECUTION_JOB_ID, execution: 1 }, f.store)).toMatchObject(
      {
        kind: 'finishing',
        accepted: { terminal: { outcome: { kind: 'job_fault', fault: { kind: 'wrapper_crashed' } } } },
      },
    );
    f.tracking.disposeKbDaemonExitListener();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it('resumes finishing after a lost outcome notification without replacing the accepted result on daemon exit', async () => {
    const f = fixture();
    f.tracking.registerDaemonJobAbortProxy(EXECUTION_JOB_ID);
    const original = { content: 'reindex complete', durationMs: 42, outcome: { kind: 'completed' } } as const;
    f.store.commit((commit) => {
      appendJobExecutionOutcomeAccepted(commit, { jobId: EXECUTION_JOB_ID, execution: 1, terminal: original });
      return undefined;
    });
    const finish = vi.spyOn(f.finisher, 'finish');
    expect(f.abortRegistry.has(EXECUTION_JOB_ID, 1)).toBe(true);
    expect(f.finisher.owns({ jobId: EXECUTION_JOB_ID, execution: 1 })).toBe(false);

    f.exit();
    await Promise.resolve();
    expect(f.abortRegistry.has(EXECUTION_JOB_ID, 1)).toBe(false);
    expect(finish).toHaveBeenCalledWith({ jobId: EXECUTION_JOB_ID, execution: 1 });
    expect(f.quiesce).toHaveBeenCalledOnce();
    expect(f.journal.events().filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
    expect(f.journal.events().filter((event) => event.type === 'job.execution.ended')).toEqual([]);
    expect(readExecutionFinishingState(f.journal.db, { jobId: EXECUTION_JOB_ID, execution: 1 }, f.store)).toMatchObject(
      {
        kind: 'finishing',
        accepted: { terminal: original },
      },
    );

    await f.settle();
    expect(f.store.readTerminalProjection(EXECUTION_JOB_ID)).toEqual(original);
    expect(f.journal.events().filter((event) => event.type === 'job.execution.ended')).toHaveLength(1);
    await f.finisher.finish({ jobId: EXECUTION_JOB_ID, execution: 1 });
    expect(f.journal.events().filter((event) => event.type === 'job.execution.ended')).toHaveLength(1);
    f.tracking.disposeKbDaemonExitListener();
  });
});
