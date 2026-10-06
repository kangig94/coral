import { progressVisitFromEvents, progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { describe, expect, it, vi } from 'vitest';

import type { InvocationContext } from '../../../src/runtime/invocation-context.js';
import type { LaunchedAtom, WorkflowExecutionPort } from '../../../src/workflow/execution-contract.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { waitForAtoms } from '../../../src/workflow/wait.js';
import type { WaitStreamEvent, WaitStreamRequest } from '../../../src/jobs/wait/contract.js';

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

const entry = (jobId: string, seq: number, epochKey: string) => ({
  hash: waitJobHash(jobId),
  epoch: waitEpochToken(epochKey),
  seq,
  lineOffset: 0,
  flags: 0,
});

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
    cursor: { jobs: remainingJobIds.includes('old') ? [entry('old', 3, 'lineage-old:7')] : [] },
    exitCode: 0,
  };
}

describe('workflow wait epoch cursor', () => {
  it('collects a workflow atom without an available artifact', async () => {
    const runtime = new SimulationRuntime();
    const job = admitted('job-1');
    const wait = new WaitCoordinator({
      visitProgress: progressVisitFromEvents(
        () => job.detail.events,
        () => 1000,
      ),
      time: runtime.time,
      eventBus: new TypedEventBus(),
      sessionManager: { get: () => null } as never,
      launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
      loadJobProjectionDetail: () => ({
        status: job.detail.status,
        launch: null,
        runtime: null,
        exit: { ...job.detail.exit!, endTime: '' },
      }),

      aggregateWorkflowUsage: () => undefined,
      getCurrentJournalSeq: () => 1000,
      resultJobsRoot: '/results',
      observeResultAvailability: () => ({ kind: 'repair-pending', ageUncertain: false }),
      subscribeJobEvents: async function* () {},
    });
    const result = waitForAtoms(
      [atom('job-1', 0)],
      { waitStream: (request) => wait.waitForJobs(request) } as WorkflowExecutionPort,
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

  it('persists the remaining job epoch and resumes its local position after another epoch terminates', async () => {
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
        time: { now: () => 0, monotonicNow: () => 0n },
        staleTimeoutMs: 0,
        staleCheckIntervalMs: 1_000,
        staleAbortTimeoutMs: 30_000,
        drainDeadlineMs: 30_000,
        onProgress: () => {},
        initialState: {
          cursor: { jobs: [entry('old', 3, 'lineage-old:7'), entry('newer', 5, 'lineage-new:8')] },
        },
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
        cursor: { jobs: [entry('old', 3, 'lineage-old:7')] },
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
      () => ({ kind: 'failed', cause: 'repair-failed', retryScheduled: true }),
    );
    const ctx = { projectRoot: f.root } as InvocationContext;
    const service = new ExecutionService(ctx, {
      visitProgress: progressVisitFromEvents(f.store.readJobEvents.bind(f.store), () => seq),
      runtime: f.runtime,
      progressStore: f.store,
      backendNamespace: 'fixture',
      launchCoordinator: { reservationFor: () => null, getActiveJobIds: () => [] },
      eventBus: new TypedEventBus(),
      coordinatorCommit: f.store.commit.bind(f.store),
      loadJobProjectionDetail: f.store.loadJobProjectionDetail.bind(f.store),

      aggregateWorkflowUsage: () => undefined,
      subscribeJobEvents: async function* () {},
      getCurrentJournalSeq: () => seq,
      currentJobEpochKey: () => 'new-selected-epoch',
      internalWait: {
        admissions: (_ids: readonly string[], request: WaitStreamRequest) => addressing.admitWait(request),
        visitProgress: addressing.visitProgress,
      },
      observeResultAvailability: () => ({ kind: 'failed', cause: 'repair-failed', retryScheduled: true }),
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
        initialState: {
          cursor: { jobs: [entry(f.jobId, seq - 1, f.epochKey)] },
        },
      },
    );
    expect(results.get('0:0')).toBe('canonical result');
    expect(progress.some((text) => text.includes('membership changed'))).toBe(false);
  } finally {
    f.close();
  }
});

it('a workflow child missing from the real reader fails its atom after one projection read', async () => {
  const runtime = new SimulationRuntime();
  const load = vi.fn(() => {
    if (load.mock.calls.length > 1000) throw new Error('reader did not yield a disposition');
    return { status: null, launch: null, runtime: null, exit: null };
  });
  const wait = new WaitCoordinator({
    visitProgress: progressVisitFromEvents(
      () => [],
      () => 0,
    ),
    time: runtime.time,
    eventBus: new TypedEventBus(),
    sessionManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    loadJobProjectionDetail: load,

    observeJobAbsence: () => true,
    aggregateWorkflowUsage: () => undefined,
    getCurrentJournalSeq: () => 0,
    currentJobEpochKey: () => 'real-epoch',
    observeResultAvailability: () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    resultJobsRoot: '/tmp/no-workflow-artifacts',
    subscribeJobEvents: async function* () {},
  });
  await expect(
    waitForAtoms(
      [atom('missing-child', 0)],
      {
        waitStream: (request: Parameters<WorkflowExecutionPort['waitStream']>[0]) => wait.waitForOutcomes(request),
        abort: vi.fn(),
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
  expect(load).toHaveBeenCalledTimes(1);
});

it('drains aborted atoms through the wait after a pipeline abort without starving timers', async () => {
  const time = new VirtualTime();
  const job = admitted('job-1', [], false);
  let terminalNow = false;
  const wait = new WaitCoordinator({
    visitProgress: progressVisitFromEvents(() => job.detail.events),
    time,
    eventBus: new TypedEventBus(),
    sessionManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    loadJobProjectionDetail: () =>
      terminalNow
        ? ({
            status: { ...job.detail.status, phase: 'aborted' },
            launch: null,
            runtime: null,
            exit: {
              content: '',
              outcome: { kind: 'aborted', reason: 'user_abort' },
              durationMs: 1,
              diagnostics: { progressFaults: [] },
              endTime: '',
            },
          } as never)
        : ({ status: job.detail.status, launch: null, runtime: null, exit: null } as never),
    aggregateWorkflowUsage: () => undefined,
    getCurrentJournalSeq: () => (terminalNow ? 1001 : 1000),
    resultJobsRoot: '/results',
    observeResultAvailability: () => ({ kind: 'available', resultPath: '/r' }),
    subscribeJobEvents: async function* () {},
  });
  const controller = new AbortController();
  let cycles = 0;
  let timerFired = false;
  time.setTimeout(() => {
    timerFired = true;
  }, 300);
  const outcome = waitForAtoms(
    [atom('job-1', 0)],
    {
      waitStream: (request: WaitStreamRequest) => {
        if (++cycles > 50) throw new Error('wait cycles spun without yielding');
        return wait.waitForOutcomes(request);
      },
      abort: () => {
        terminalNow = true;
        return { aborted: ['job-1'], notFound: [] };
      },
    } as unknown as WorkflowExecutionPort,
    {} as InvocationContext,
    {
      time,
      signal: controller.signal,
      staleTimeoutMs: 0,
      staleCheckIntervalMs: 1000,
      staleAbortTimeoutMs: 30_000,
      drainDeadlineMs: 15_000,
      onProgress: () => {},
    },
  ).catch((error: Error) => error);
  await flushMicrotasks(20);
  controller.abort();
  for (let step = 0; step < 8; step++) {
    time.tick(250);
    await flushMicrotasks(20);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const error = await outcome;
  expect(timerFired).toBe(true);
  expect(cycles).toBeLessThanOrEqual(5);
  expect(error).toMatchObject({ message: expect.stringContaining('aborted') });
  expect((error as { stepDetails?: unknown[] }).stepDetails).toBeDefined();
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

it('reads an internal child’s progress from the epoch it was admitted in', async () => {
  const time = new VirtualTime();
  const child = admitted('child', [[3, 'historical line']], true, 'historical');
  const progress: string[] = [];
  const wait = new WaitCoordinator({
    visitProgress: progressVisitFromEvents(() => []),
    internalWait: {
      admissions: () => [child],
      visitProgress: progressVisitFromEvents(() => child.detail.events),
    },
    time,
    eventBus: new TypedEventBus(),
    sessionManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    loadJobProjectionDetail: () => ({ status: null, launch: null, runtime: null, exit: null }),
    aggregateWorkflowUsage: () => undefined,
    getCurrentJournalSeq: () => 0,
    currentJobEpochKey: () => 'active',
    resultJobsRoot: '/results',
    observeResultAvailability: () => ({ kind: 'available', resultPath: '/r' }),
    subscribeJobEvents: async function* () {},
  });
  await waitForAtoms(
    [atom('child', 0)],
    { waitStream: (request: WaitStreamRequest) => wait.waitForOutcomes(request) } as unknown as WorkflowExecutionPort,
    {} as InvocationContext,
    {
      time,
      staleTimeoutMs: 0,
      staleCheckIntervalMs: 1000,
      staleAbortTimeoutMs: 30_000,
      drainDeadlineMs: 30_000,
      onProgress: (message) => progress.push(message),
    },
  );
  expect(progress).toContain('0-wor historical line');
});
