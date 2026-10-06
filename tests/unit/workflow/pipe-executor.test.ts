import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobTerminal } from '#src/jobs/records.js';
import type { WaitRequest, WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { parseExpression } from '#src/workflow/parser.js';
import { launchAtomWithRetry } from '#src/workflow/launch.js';
import { executePipeline } from '#src/workflow/executor.js';
import {
  WorkflowExecutionError,
  type LaunchedAtom,
  type WorkflowExecutionPort,
} from '#src/workflow/execution-contract.js';
import type { CompiledPlanSlot } from '#src/workflow/plan.js';
import { recoverStaleAtom } from '#src/workflow/stale-recovery.js';
import { waitForAtoms } from '#src/workflow/wait.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const ctx: InvocationContext = {
  projectRoot: fixtureCanonicalWorkDir('/tmp/coral-workflow-project'),
  pluginRoot: '/tmp/coral-workflow-plugin',
  coralEnv: {},
  principal: testProjectPrincipal('/tmp/coral-workflow-project'),
};
let workflowClock = new Date('2026-04-27T00:00:00.000Z').getTime();
let workflowMonotonicClock = 0n;
const workflowTime = {
  now: () => {
    workflowClock += 100;
    return workflowClock;
  },
  monotonicNow: () => {
    workflowMonotonicClock += 100n;
    return workflowMonotonicClock;
  },
  sleep: async (ms: number) => {
    workflowMonotonicClock += BigInt(ms);
  },
};
const workflowIds = { uuid: () => randomUUID() };
const waitTiming = {
  origin: 'queued',
  originAt: '2026-07-03T08:00:00.000Z',
  emittedAt: '2026-07-03T08:00:02.000Z',
  elapsedMs: 2_000,
} as const;

function running(jobId: string, sessionId: string) {
  return {
    kind: 'provider-session' as const,
    status: 'running' as const,
    jobId,
    sessionId,
  };
}

let terminalSeq = 0;

function terminal(
  jobId: string,
  _sessionId: string,
  result: Omit<JobTerminal, 'outcome' | 'durationMs'> & { outcome?: JobTerminal['outcome'] },
): WaitStreamEvent {
  const terminalResult: JobTerminal =
    result.outcome !== undefined
      ? ({ ...result, outcome: result.outcome, durationMs: 0 } as JobTerminal)
      : { ...result, outcome: { kind: 'completed' }, durationMs: 0 };
  return {
    type: 'terminal',
    jobId,
    seq: ++terminalSeq,
    remainingJobIds: [],
    resultPath: `/tmp/coral-exports/jobs/${jobId}/result.md`,
    availability: { kind: 'available', resultPath: `/tmp/coral-exports/jobs/${jobId}/result.md` },
    result: terminalResult,
    cursor: { jobs: [] },
    exitCode: 0,
  };
}

function stillWaiting(waitingJobIds: string[]): WaitStreamEvent {
  return {
    type: 'waiting',
    waitingJobIds,
    cursor: { jobs: [] },
    exitCode: 75,
  };
}

async function* emit(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

type MockExecutionService = WorkflowExecutionPort & {
  coralDispatch: ReturnType<typeof vi.fn<WorkflowExecutionPort['coralDispatch']>>;
  resume: ReturnType<typeof vi.fn>;
  recordContinuationLease: ReturnType<typeof vi.fn>;
  clearContinuationLease: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  awaitLaunch: ReturnType<typeof vi.fn>;
  waitStream: ReturnType<typeof vi.fn>;
  waitForJobTerminal: ReturnType<typeof vi.fn>;
};

function createExecutionService(overrides: Partial<MockExecutionService> = {}): MockExecutionService {
  return {
    coralDispatch: vi.fn(async () => running('job-1', 'session-1')),
    resume: vi.fn(async () => running('job-resumed', 'session-1')),
    recordContinuationLease: vi.fn(async () => {}),
    clearContinuationLease: vi.fn(async () => true),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    awaitLaunch: vi.fn(async () => 'ready'),
    waitStream: vi.fn((_req: WaitRequest) => emit([])),
    waitForJobTerminal: vi.fn(async () => {}),
    ...overrides,
  } as MockExecutionService;
}

function launchedAtom(overrides: Partial<LaunchedAtom> = {}): LaunchedAtom {
  return {
    slotId: 'workflow-1:0:0',
    jobId: 'job-1',
    sessionId: 'session-1',
    providerName: 'codex',
    agent: 'architect',
    tagName: 'architect',
    stepIndex: 0,
    atomIndex: 0,
    atomKey: '0:0',
    generation: 0,
    ...overrides,
  };
}

function planSlot(overrides: Partial<CompiledPlanSlot> = {}): CompiledPlanSlot {
  return {
    slotId: 'workflow-1:0:0',
    dependencies: [],
    jobId: 'planned-job-1',
    stepIndex: 0,
    tagName: 'architect',
    atomKey: '0:0',
    label: 'architect',
    kind: 'agent',
    provider: 'codex',
    instruction: 'architect',
    agent: 'architect',
    ...overrides,
  };
}

describe('workflow pipe executor', () => {
  it('passes each step output as the next step prompt and returns ordered step details', async () => {
    const prompts: string[] = [];
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName, input) => {
        prompts.push(String(input.prompt));
        return coralName === 'architect' ? running('job-1', 'session-1') : running('job-2', 'session-2');
      }),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds[0] === 'job-1') {
          return emit([terminal('job-1', 'session-1', { content: 'ARCH' })]);
        }
        return emit([terminal('job-2', 'session-2', { content: 'FINAL' })]);
      }),
    });

    const result = await executePipeline(parseExpression('architect -> resolver'), 'seed', 'codex', executionSvc, ctx, {
      workflowJobId: 'workflow-test-uuid',
      ids: workflowIds,
      time: workflowTime,
    });

    expect(result.finalOutput).toBe('FINAL');
    expect(result.stepDetails).toEqual([
      {
        stepIndex: 0,
        atomIndex: 0,
        label: 'architect',
        output: 'ARCH',
      },
      {
        stepIndex: 1,
        atomIndex: 0,
        label: 'resolver',
        output: 'FINAL',
      },
    ]);
    expect(prompts).toEqual(['seed', 'ARCH']);
  });

  it('does not charge a late wait tick as unobserved atom inactivity', async () => {
    const monotonicReadings = [0n, 60_000n, 60_000n, 60_500n, 60_500n];
    const time = {
      ...workflowTime,
      monotonicNow: () => monotonicReadings.shift() ?? 60_500n,
    };
    let firstCycle = true;
    const executionSvc = createExecutionService({
      waitStream: vi.fn((req: WaitRequest) => {
        if (firstCycle) {
          firstCycle = false;
          return emit([stillWaiting([...req.jobIds])]);
        }
        return emit([terminal('job-1', 'session-1', { content: 'DONE' })]);
      }),
    });

    const results = await waitForAtoms([launchedAtom()], executionSvc, ctx, {
      staleTimeoutMs: 2_000,
      staleCheckIntervalMs: 1_000,
      staleAbortTimeoutMs: 30_000,
      drainDeadlineMs: 15_000,
      workflowJobId: 'workflow-1',
      onProgress: vi.fn(),
      recoverStaleAtom,
      time,
    });

    expect([...results.values()]).toEqual(['DONE']);
    expect(executionSvc.abort).not.toHaveBeenCalled();
    expect(executionSvc.resume).not.toHaveBeenCalled();
  });

  it('fails stale recovery when the aborted job never releases its session claim', async () => {
    let mockNow = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockNow += 10;
      return mockNow;
    });

    const executionSvc = createExecutionService({
      waitForJobTerminal: vi.fn(async () => {
        throw new Error('Timed out waiting for job job-1 to reach a terminal state and release its session');
      }),
      waitStream: vi.fn((req: WaitRequest) => emit([stillWaiting([...req.jobIds])])),
    });

    try {
      await expect(
        waitForAtoms([launchedAtom()], executionSvc, ctx, {
          staleTimeoutMs: 1,
          staleCheckIntervalMs: 1,
          staleAbortTimeoutMs: 30_000,
          drainDeadlineMs: 15_000,
          workflowJobId: 'workflow-1',
          onProgress: vi.fn(),
          recoverStaleAtom,
          time: workflowTime,
        }),
      ).rejects.toMatchObject({
        message:
          "Step 0, atom 'architect' stale recovery abort failed: Timed out waiting for job job-1 to reach a terminal state and release its session",
        aborted: false,
        stepDetails: [],
      });

      expect(executionSvc.abort).toHaveBeenCalledWith(['job-1']);
      expect(executionSvc.waitForJobTerminal).toHaveBeenCalledOnce();
      expect(executionSvc.resume).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not abort stale jobs when continuation lease recording fails', async () => {
    const executionSvc = createExecutionService({
      recordContinuationLease: vi.fn(async () => {
        throw new Error('journal append failed');
      }),
      waitStream: vi.fn((req: WaitRequest) => emit([stillWaiting([...req.jobIds])])),
    });

    await expect(
      waitForAtoms([launchedAtom()], executionSvc, ctx, {
        staleTimeoutMs: 1,
        staleCheckIntervalMs: 1,
        staleAbortTimeoutMs: 30_000,
        drainDeadlineMs: 15_000,
        workflowJobId: 'workflow-1',
        onProgress: vi.fn(),
        recoverStaleAtom,
        time: workflowTime,
      }),
    ).rejects.toMatchObject({
      message: "Step 0, atom 'architect' stale recovery lease failed: journal append failed",
      aborted: false,
      stepDetails: [],
    });

    expect(executionSvc.recordContinuationLease).toHaveBeenCalledOnce();
    expect(executionSvc.abort).not.toHaveBeenCalled();
    expect(executionSvc.resume).not.toHaveBeenCalled();
  });

  it('preserves launched sibling output when a parallel launch fails', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName) => {
        if (coralName === 'architect') return running('job-a', 'session-a');
        return {
          status: 'refused' as const,
          code: 'busy',
          message: 'launch blocked',
        };
      }),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds.includes('job-a')) {
          return emit([terminal('job-a', 'session-a', { content: 'ARCH' })]);
        }
        return emit([]);
      }),
    });

    await expect(
      executePipeline(parseExpression('(architect, critic)'), 'seed', 'codex', executionSvc, ctx, {
        workflowJobId: 'workflow-test-uuid',
        ids: workflowIds,
        time: workflowTime,
      }),
    ).rejects.toMatchObject({
      message: "Step 0, atom 'critic' launch failed: launch blocked",
      aborted: false,
      stepDetails: [
        {
          stepIndex: 0,
          atomIndex: 0,
          label: 'architect',
          output: 'ARCH',
        },
      ],
    });

    expect(executionSvc.abort).toHaveBeenCalledWith(['job-a']);
  });

  it('surfaces aborted=true and preserves prior step details on user abort', async () => {
    const controller = new AbortController();
    let secondStepWait = 0;
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName) => {
        if (coralName === 'architect') return running('job-1', 'session-1');
        return running('job-2', 'session-2');
      }),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds.includes('job-1')) {
          return emit([terminal('job-1', 'session-1', { content: 'ARCH' })]);
        }
        secondStepWait += 1;
        if (secondStepWait === 1) {
          controller.abort();
          return emit([stillWaiting(['job-2'])]);
        }
        return emit([
          terminal('job-2', 'session-2', { content: '', outcome: { kind: 'aborted', reason: 'signal_abort' } }),
        ]);
      }),
    });

    await expect(
      executePipeline(parseExpression('architect -> resolver'), 'seed', 'codex', executionSvc, ctx, {
        signal: controller.signal,
        workflowJobId: 'workflow-test-uuid',
        ids: workflowIds,
        time: workflowTime,
      }),
    ).rejects.toMatchObject({
      message: 'Pipeline aborted (launched atoms may continue)',
      aborted: true,
      stepDetails: [
        {
          stepIndex: 0,
          atomIndex: 0,
          label: 'architect',
          output: 'ARCH',
        },
      ],
    });

    expect(executionSvc.abort).toHaveBeenCalledWith(['job-2']);
  });
});

describe('launchAtomWithRetry', () => {
  it('accepts queued launches as valid bootstrap outcomes', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async () => ({
        kind: 'provider-session' as const,
        status: 'queued' as const,
        jobId: 'job-queued',
        sessionId: 'session-queued',
      })),
      awaitLaunch: vi.fn(async (): Promise<'queued'> => 'queued'),
    });

    const launched = await launchAtomWithRetry({
      slot: planSlot(),
      atomIndex: 0,
      stepPrompt: 'do work',
      executionSvc,
      ctx,
      completedStepDetails: [],
      workflowJobId: 'workflow-1',
    });

    expect(launched).toEqual({
      slotId: 'workflow-1:0:0',
      jobId: 'job-queued',
      sessionId: 'session-queued',
      providerName: 'codex',
      agent: 'architect',
      tagName: 'architect',
      stepIndex: 0,
      atomIndex: 0,
      atomKey: '0:0',
      generation: 0,
    });
    expect(executionSvc.coralDispatch).toHaveBeenCalledTimes(1);
  });

  it('reports when the launch check established nothing', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async () => ({
        status: 'undetermined' as const,
        code: 'provider_preflight_undetermined',
        message: 'Provider preflight could not inspect credentials',
      })),
    });

    await expect(
      launchAtomWithRetry({
        slot: planSlot(),
        atomIndex: 0,
        stepPrompt: 'do work',
        executionSvc,
        ctx,
        completedStepDetails: [],
        workflowJobId: 'workflow-1',
      }),
    ).rejects.toThrow(
      "Step 0, atom 'architect' launch check established nothing: Provider preflight could not inspect credentials",
    );
    expect(executionSvc.awaitLaunch).not.toHaveBeenCalled();
  });
});

describe('waitForAtoms', () => {
  it('treats queued wait events as progress and keeps waiting for completion', async () => {
    const progress = vi.fn();
    const executionSvc = createExecutionService({
      waitStream: vi.fn(() =>
        emit([
          {
            type: 'queued',
            jobKind: 'provider',
            jobId: 'job-1',
            sessionId: 'session-1',
            queuePosition: 2,
            runningJobIds: ['job-a'],
            timing: waitTiming,
          },
          terminal('job-1', 'session-1', { content: 'ARCH' }),
        ]),
      ),
    });

    const results = await waitForAtoms([launchedAtom()], executionSvc, ctx, {
      staleTimeoutMs: 0,
      staleCheckIntervalMs: 500,
      staleAbortTimeoutMs: 30_000,
      drainDeadlineMs: 15_000,
      workflowJobId: 'workflow-1',
      onProgress: progress,
      time: workflowTime,
    });

    expect(results.get('0:0')).toBe('ARCH');
  });

  it('records a completed terminal even when a stale abort marker exists', async () => {
    const executionSvc = createExecutionService({
      waitStream: vi.fn(() => emit([terminal('job-1', 'session-1', { content: 'ARCH' })])),
    });

    const results = await waitForAtoms([launchedAtom()], executionSvc, ctx, {
      staleTimeoutMs: 0,
      staleCheckIntervalMs: 500,
      staleAbortTimeoutMs: 30_000,
      drainDeadlineMs: 15_000,
      initialState: {
        expectedStaleAborts: new Set(['job-1']),
      },
      onProgress: vi.fn(),
      time: workflowTime,
    });

    expect([...results.entries()]).toEqual([['0:0', 'ARCH']]);
  });

  it('does not resume a duplicate atom when stale abort was a no-op and the original completes', async () => {
    const executionSvc = createExecutionService({
      abort: vi.fn(() => ({ aborted: [], notFound: [] })),
      waitForJobTerminal: vi.fn(async () => {}),
      waitStream: vi.fn(() => emit([stillWaiting(['job-1']), terminal('job-1', 'session-1', { content: 'ARCH' })])),
    });

    const results = await waitForAtoms([launchedAtom()], executionSvc, ctx, {
      staleTimeoutMs: 1,
      staleCheckIntervalMs: 1,
      staleAbortTimeoutMs: 30_000,
      drainDeadlineMs: 15_000,
      workflowJobId: 'workflow-1',
      onProgress: vi.fn(),
      recoverStaleAtom,
      time: workflowTime,
    });

    expect(executionSvc.abort).toHaveBeenCalledWith(['job-1']);
    expect(executionSvc.waitForJobTerminal).toHaveBeenCalledOnce();
    expect(executionSvc.resume).not.toHaveBeenCalled();
    expect(executionSvc.awaitLaunch).not.toHaveBeenCalled();
    expect([...results.entries()]).toEqual([['0:0', 'ARCH']]);
  });

  it('treats notice on terminal result as a failure and preserves completed details', async () => {
    const executionSvc = createExecutionService({
      waitStream: vi.fn(() =>
        emit([
          terminal('job-1', 'session-1', { content: 'ARCH' }),
          terminal('job-2', 'session-2', {
            content: '',
            outcome: {
              kind: 'failed',
              causeRef: {
                stream: {
                  kind: 'session',
                  id: 'session-2',
                },
                seq: 1,
              },
            },
          }),
        ]),
      ),
    });

    await expect(
      waitForAtoms(
        [
          launchedAtom({ jobId: 'job-1', sessionId: 'session-1', atomKey: '0:0' }),
          launchedAtom({
            jobId: 'job-2',
            sessionId: 'session-2',
            agent: 'critic',
            tagName: 'critic',
            atomIndex: 1,
            atomKey: '0:1',
          }),
        ],
        executionSvc,
        ctx,
        {
          staleTimeoutMs: 0,
          staleCheckIntervalMs: 500,
          staleAbortTimeoutMs: 30_000,
          drainDeadlineMs: 15_000,
          onProgress: vi.fn(),
          time: workflowTime,
        },
      ),
    ).rejects.toMatchObject({
      message: "Step 0, atom 'critic' failed: Failed: session/session-2#1",
      aborted: false,
      stepDetails: [
        {
          stepIndex: 0,
          atomIndex: 0,
          label: 'architect',
          output: 'ARCH',
        },
      ],
    });
  });

  it('throws WorkflowExecutionError on aborted terminal results', async () => {
    const executionSvc = createExecutionService({
      waitStream: vi.fn(() =>
        emit([terminal('job-1', 'session-1', { content: '', outcome: { kind: 'aborted', reason: 'signal_abort' } })]),
      ),
    });

    await expect(
      waitForAtoms([launchedAtom()], executionSvc, ctx, {
        staleTimeoutMs: 0,
        staleCheckIntervalMs: 500,
        staleAbortTimeoutMs: 30_000,
        drainDeadlineMs: 15_000,
        onProgress: vi.fn(),
        time: workflowTime,
      }),
    ).rejects.toBeInstanceOf(WorkflowExecutionError);
  });
});
