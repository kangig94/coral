import { describe, expect, it, vi } from 'vitest';

import type { InvocationContext } from '../../../src/runtime/invocation-context.js';
import type { LaunchedAtom, WorkflowExecutionPort } from '../../../src/workflow/execution-contract.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { waitForAtoms } from '../../../src/workflow/wait.js';
import type { WaitStreamEvent } from '../../../src/jobs/wait/contract.js';

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
    version: 'jobs.wait.v2',
    jobId,
    seq,
    epochKey,
    remainingJobIds,
    resultPath: `/tmp/${jobId}.md`,
    result: { content: `${jobId} done`, outcome: { kind: 'completed' }, durationMs: 1 },
    cursor: {
      version: 'jobs.wait.v2',
      locations: { old: 'lineage-old:7', newer: 'lineage-new:8' },
      positions: { 'lineage-old:7': jobId === 'old' ? seq : 3, 'lineage-new:8': jobId === 'newer' ? seq : 5 },
      deliveredJobIds: [jobId],
    },
  };
}

describe('workflow wait epoch cursor', () => {
  it('collects a workflow atom without an available artifact', async () => {
    const runtime = new SimulationRuntime();
    const job = admitted('job-1');
    const wait = new WaitCoordinator({
      time: runtime.time,
      eventBus: new TypedEventBus(),
      sessionManager: { get: () => null } as never,
      launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
      loadJobProjectionDetail: () => ({
        status: job.detail!.status,
        launch: null,
        runtime: null,
        exit: { ...job.detail!.exit!, endTime: '' },
      }),
      readJobEvents: () => job.detail!.events,
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
          cursor: {
            version: 'jobs.wait.v2',
            locations: { old: 'lineage-old:7', newer: 'lineage-new:8' },
            positions: { 'lineage-old:7': 3, 'lineage-new:8': 5 },
          },
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
        cursor: {
          version: 'jobs.wait.v2',
          locations: { old: 'lineage-old:7' },
          positions: { 'lineage-old:7': 3 },
          deliveredJobIds: [],
        },
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
    const ctx = { projectRoot: f.root } as InvocationContext;
    const service = new ExecutionService(ctx, {
      runtime: f.runtime,
      progressStore: f.store,
      backendNamespace: 'fixture',
      launchCoordinator: { reservationFor: () => null, getActiveJobIds: () => [] },
      eventBus: new TypedEventBus(),
      coordinatorCommit: f.store.commit.bind(f.store),
      loadJobProjectionDetail: f.store.loadJobProjectionDetail.bind(f.store),
      readJobEvents: f.store.readJobEvents.bind(f.store),
      aggregateWorkflowUsage: () => undefined,
      subscribeJobEvents: async function* () {},
      getCurrentJournalSeq: () => seq,
      currentJobEpochKey: () => f.epochKey,
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
          cursor: {
            version: 'jobs.wait.v2',
            locations: { [f.jobId]: f.epochKey },
            positions: { [f.epochKey]: seq - 1 },
          },
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
    time: runtime.time,
    eventBus: new TypedEventBus(),
    sessionManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    loadJobProjectionDetail: load,
    readJobEvents: () => [],
    aggregateWorkflowUsage: () => undefined,
    getCurrentJournalSeq: () => 0,
    currentJobEpochKey: () => 'real-epoch',
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
