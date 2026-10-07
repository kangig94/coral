import { progressVisitFromEvents, progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { describe, expect, it, vi } from 'vitest';

import type { InvocationContext } from '../../../src/runtime/invocation-context.js';
import type { LaunchedAtom, WorkflowExecutionPort } from '../../../src/workflow/execution-contract.js';
import { admitted, savedCursor } from '#tests/helpers/wait-session.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { waitForAtoms } from '../../../src/workflow/wait.js';
import type { ProgressVisit, WaitStreamEvent, WaitStreamRequest } from '../../../src/jobs/wait/contract.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';

function atom(jobId: string, atomIndex: number): LaunchedAtom {
  return {
    slotId: `workflow:0:${atomIndex}`,
    jobId,
    sessionId: `session-${atomIndex}`,
    providerName: 'claude',
    agent: 'worker',
    tagName: 'worker',
    stepIndex: 0,
    atomIndex,
    atomKey: `0:${atomIndex}`,
    generation: 0,
  };
}

function terminal(jobId: string, seq: number, epochKey: string, remainingJobIds: string[]): WaitStreamEvent {
  return {
    type: 'terminal',
    jobId,
    seq,
    epochKey,
    remainingJobIds,
    resultPath: `/tmp/${jobId}.md`,
    availability: { kind: 'available', resultPath: `/tmp/${jobId}.md` },
    result: { content: `${jobId} done`, outcome: { kind: 'completed' }, durationMs: 1 },
    cursor: remainingJobIds.length > 0 ? savedCursor(3) : null,
    exitCode: 0,
  };
}

describe('workflow wait epoch cursor', () => {
  it('collects a workflow atom without an available artifact', async () => {
    const runtime = new SimulationRuntime();
    const job = admitted('job-1');
    const wait = new WaitCoordinator({
      visitProgress: progressVisitFromEvents(() => job.detail.events),
      time: runtime.time,
      eventBus: new TypedEventBus(),
      sessionManager: { get: () => null } as never,
      launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
      readJobLastSeq: () => null,
      loadJobWaitDetail: () => ({
        status: job.detail.status,
        runtime: null,
        exit: { ...job.detail.exit!, endTime: '' },
      }),

      aggregateWorkflowUsage: () => undefined,
      getCurrentJournalSeq: () => 1000,
      resultJobsRoot: '/results',
      observeResultAvailability: () => ({ kind: 'pending' }),
      subscribeJobEvents: async function* () {},
    });
    const result = waitForAtoms(
      [atom('job-1', 0)],
      { waitStream: (request) => wait.waitForOutcomes(request) } as WorkflowExecutionPort,
      {} as InvocationContext,
      {
        time: runtime.time,
        staleTimeoutMs: 0,
        staleCheckIntervalMs: 1000,
        staleAbortTimeoutMs: 30000,
        drainDeadlineMs: 30000,
        onProgress: () => {},
      },
    );
    await expect(result).resolves.toEqual(new Map([['0:0', 'job-1 result']]));
  });

  it('resumes the next cycle from the cursor the last final event named', async () => {
    const waitStream = vi
      .fn()
      .mockImplementationOnce(async function* () {
        yield terminal('newer', 6, 'lineage-new:8', ['old']);
      })
      .mockImplementationOnce(async function* () {
        yield terminal('old', 4, 'lineage-old:7', []);
      });
    const results = await waitForAtoms(
      [atom('old', 0), atom('newer', 1)],
      { waitStream } as unknown as WorkflowExecutionPort,
      {} as InvocationContext,
      {
        time: { now: () => 0, monotonicNow: () => 0n, sleep: async () => {} },
        staleTimeoutMs: 0,
        staleCheckIntervalMs: 1_000,
        staleAbortTimeoutMs: 30_000,
        drainDeadlineMs: 30_000,
        onProgress: () => {},
        initialState: { cursor: savedCursor(5) },
      },
    );
    expect(results).toEqual(
      new Map([
        ['0:1', 'newer done'],
        ['0:0', 'old done'],
      ]),
    );
    expect(waitStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        jobIds: ['old'],
        cursor: savedCursor(3),
      }),
    );
  });
});

import { ExecutionService } from '#src/coordinator/execution-service.js';
import type { ExecutionServiceDeps } from '#src/coordinator/contracts.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

it('resumes recovery through ExecutionService and the real WaitCoordinator using the durable epoch cursor', async () => {
  const f = createTerminalExportFixture();
  try {
    const seq = f.complete();
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'new-selected-epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      (_epochKey, jobIds) => ({
        kind: 'read',
        dispositions: new Map(jobIds.map((jobId) => [jobId, 'readable' as const])),
        locations: new Map(jobIds.map((jobId) => [jobId, f.index.read(jobId)!])),
      }),
      () => ({ kind: 'pending' }),
    );
    const ctx = { projectRoot: f.root } as InvocationContext;
    const service = new ExecutionService(ctx, {
      visitProgress: progressVisitFromEvents(f.store.readJobEvents.bind(f.store)),
      runtime: f.runtime,
      progressStore: f.store,
      backendNamespace: 'fixture',
      launchCoordinator: { reservationFor: () => null, getActiveJobIds: () => [] },
      eventBus: new TypedEventBus(),
      coordinatorCommit: f.store.commit.bind(f.store),
      loadJobProjectionDetail: f.store.loadJobProjectionDetail.bind(f.store),
      loadJobWaitDetail: f.store.loadJobWaitDetail.bind(f.store),
      readJobLastSeq: f.store.readJobLastSeq.bind(f.store),

      aggregateWorkflowUsage: () => undefined,
      subscribeJobEvents: async function* () {},
      getCurrentJournalSeq: () => seq,
      currentJobEpochKey: () => 'new-selected-epoch',
      internalWait: {
        admissions: (_ids: readonly string[], request: WaitStreamRequest) => addressing.admitWait(request),
        visitProgress: addressing.visitProgress,
      },
      observeResultAvailability: () => ({ kind: 'pending' }),
    } as unknown as ExecutionServiceDeps);
    const progress: string[] = [];
    const results = await waitForAtoms(
      [atom(f.jobId, 0)],
      { waitStream: (req) => service.waitStream(req), abort: (ids) => service.abort(ids) } as WorkflowExecutionPort,
      ctx,
      {
        time: f.runtime.time,
        staleTimeoutMs: 0,
        staleCheckIntervalMs: 1000,
        staleAbortTimeoutMs: 1000,
        drainDeadlineMs: 1000,
        onProgress: (text) => progress.push(text),
        initialState: { cursor: savedCursor(seq - 1, 'new-selected-epoch') },
      },
    );
    expect(results.get('0:0')).toBe('canonical result');
    expect(progress.some((text) => text.includes('membership changed'))).toBe(false);
  } finally {
    f.close();
  }
});

it('a workflow child missing from the real reader fails its atom instead of waiting', async () => {
  const runtime = new SimulationRuntime();
  const load = vi.fn(() => {
    if (load.mock.calls.length > 1000) throw new Error('reader did not yield a disposition');
    return { status: null, runtime: null, exit: null };
  });
  const wait = new WaitCoordinator({
    visitProgress: progressVisitFromEvents(() => []),
    time: runtime.time,
    eventBus: new TypedEventBus(),
    sessionManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    readJobLastSeq: () => null,
    loadJobWaitDetail: load,

    observeJobAbsence: () => true,
    aggregateWorkflowUsage: () => undefined,
    getCurrentJournalSeq: () => 0,
    currentJobEpochKey: () => 'real-epoch',
    observeResultAvailability: () => ({
      kind: 'failed',
      reason: 'the retained terminal does not match its source journal',
    }),
    resultJobsRoot: '/tmp/no-workflow-artifacts',
    subscribeJobEvents: async function* () {},
  });
  await expect(
    waitForAtoms(
      [atom('missing-child', 0)],
      {
        waitStream: (request: Parameters<WorkflowExecutionPort['waitStream']>[0]) => wait.waitForOutcomes(request),
        abort: vi.fn(() => ({ aborted: [], notFound: ['missing-child'] })),
      } as unknown as WorkflowExecutionPort,
      {} as InvocationContext,
      {
        time: runtime.time,
        staleTimeoutMs: 0,
        staleCheckIntervalMs: 1000,
        staleAbortTimeoutMs: 1000,
        drainDeadlineMs: 1000,
        onProgress: () => {},
      },
    ),
  ).rejects.toThrow('could not be read');
});

it('yields a macrotask after a wait cycle that observed nothing', async () => {
  let cycles = 0;
  let macrotaskRan = false;
  setImmediate(() => {
    macrotaskRan = true;
  });
  await waitForAtoms(
    [atom('job-1', 0)],
    {
      waitStream: async function* () {
        cycles++;
        if (macrotaskRan || cycles > 1000) throw new Error('stop');
      },
    } as unknown as WorkflowExecutionPort,
    {} as InvocationContext,
    {
      time: new VirtualTime(),
      staleTimeoutMs: 0,
      staleCheckIntervalMs: 1000,
      staleAbortTimeoutMs: 30_000,
      drainDeadlineMs: 15_000,
      onProgress: () => {},
    },
  ).catch(() => undefined);
  expect(cycles).toBe(2);
});

describe('a child the wait cannot read stays in the failure drain (F4)', () => {
  const refused: WaitStreamEvent = {
    type: 'disposition',
    jobId: 'child',
    disposition: 'unreadable',
    message: 'Job location cannot be decoded by this build',
  };
  const run = (notFound: string[]) => {
    let mono = 0n;
    const sleeps: number[] = [];
    const abort = vi.fn((jobIds: string[]) => ({ aborted: jobIds.filter((id) => !notFound.includes(id)), notFound }));
    const waitStream = vi.fn(async function* (_request: WaitStreamRequest) {
      yield refused;
      yield { type: 'waiting', waitingJobIds: [], cursor: null, exitCode: 1 } satisfies WaitStreamEvent;
    });
    const result = waitForAtoms(
      [atom('child', 0)],
      { abort, waitStream } as unknown as WorkflowExecutionPort,
      {} as InvocationContext,
      {
        time: {
          now: () => Number(mono),
          monotonicNow: () => mono,
          sleep: async (ms) => {
            sleeps.push(ms);
            mono += BigInt(ms);
          },
        },
        staleTimeoutMs: 0,
        staleCheckIntervalMs: 1_000,
        staleAbortTimeoutMs: 30_000,
        drainDeadlineMs: 5_000,
        onProgress: () => {},
      },
    );
    return { result, abort, waitStream, sleeps };
  };

  it('aborts the unreadable child and holds its drain until the bounded deadline, pacing each refused cycle', async () => {
    const { result, abort, waitStream, sleeps } = run([]);
    await expect(result).rejects.toThrow("Step 0, atom 'worker' could not be read: unreadable");
    expect(abort).toHaveBeenCalledExactlyOnceWith(['child']);
    expect(waitStream.mock.calls.every(([request]) => request.jobIds.includes('child'))).toBe(true);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5_000);
    expect(waitStream.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

it('ends the abort drain at its deadline while a refused live child keeps replenishing its backlog', async () => {
  let now = 0;
  let polls = 0;
  let closed = 0;
  const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
  const time = {
    monotonicNow: () => BigInt(now),
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const child = admitted('child', [], false);
  // Each poll finds 600 more rows than the last, so the internal reader always has backlog left to drain.
  const visit: ProgressVisit = (_epoch, read) => {
    if (++polls > 100) throw new Error('drain outlived its deadline by 100 polls');
    const frontier = polls * 600;
    now += 100;
    return {
      kind: 'read',
      value: read({
        frontier: () => frontier,
        after: (_id, after, count) =>
          Array.from({ length: Math.max(0, Math.min(count, frontier - after)) }, (_, i) => ({
            seq: after + i + 1,
            message: 'p',
            timing,
          })),
        newest: () => {
          throw new Error('an internal reader positions at origin');
        },
      }),
    };
  };
  const abort = vi.fn(() => ({
    notFound: [],
    refused: [{ jobId: 'child', reason: 'Abort refused by the live owner; job continues', nextStep: 'Retry abort' }],
    aborted: [],
  }));
  const waitStream = vi.fn(async function* (request: WaitStreamRequest) {
    try {
      yield* readWaitSession({
        request,
        activeEpochKey: 'epoch-E',
        time: time as never,
        visit,
        read: () => [child],
        internal: true,
      });
    } finally {
      closed++;
    }
  });
  const result = waitForAtoms(
    [atom('child', 0)],
    { abort, waitStream } as unknown as WorkflowExecutionPort,
    {} as InvocationContext,
    {
      signal: AbortSignal.abort(),
      time,
      staleTimeoutMs: 0,
      staleCheckIntervalMs: 1000,
      staleAbortTimeoutMs: 1000,
      drainDeadlineMs: 1000,
      onProgress: () => {},
    },
  );
  await expect(result).rejects.toThrow('Pipeline aborted');
  expect(abort).toHaveBeenCalledOnce();
  expect(waitStream).toHaveBeenCalledOnce();
  expect(closed).toBe(1);
  expect(polls).toBeLessThanOrEqual(12);
});
