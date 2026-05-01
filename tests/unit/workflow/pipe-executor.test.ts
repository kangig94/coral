import { describe, expect, it, vi } from 'vitest';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobTerminal } from '#src/jobs/records.js';
import type { WaitRequest, WaitStreamEvent } from '#src/jobs/wait.js';
import { parseExpression } from '#src/workflow/parser.js';
import { BOOTSTRAP_TIMEOUT_MS, launchAtomWithRetry } from '#src/workflow/launch.js';
import { executePipeline } from '#src/workflow/executor.js';
import {
  WorkflowExecutionError,
  type LaunchedAtom,
  type WorkflowExecutionPort,
} from '#src/workflow/execution-contract.js';
import { formatStepOutput, toSessionHandles } from '#src/workflow/command.js';
import type { CompiledPlanSlot } from '#src/workflow/plan.js';
import { recoverStaleAtom } from '#src/workflow/recover.js';
import { waitForAtoms } from '#src/workflow/wait.js';

const ctx: InvocationContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
  coralEnv: {},
};
const workflowTime = {
  now: () => Date.now(),
};
const workflowIds = { uuid: () => 'workflow-test-uuid' };

function running(job: string, session: string) {
  return {
    status: 'running' as const,
    job,
    session,
  };
}

function terminal(
  jobId: string,
  _sessionId: string,
  result: Omit<JobTerminal, 'outcome'> & { outcome?: JobTerminal['outcome'] },
): WaitStreamEvent {
  const terminalResult: JobTerminal =
    result.outcome !== undefined
      ? ({ ...result, outcome: result.outcome } as JobTerminal)
      : { ...result, outcome: { kind: 'completed' } };
  return {
    type: 'terminal',
    jobId,
    remainingJobIds: [],
    resultPath: `/tmp/coral-exports/jobs/${jobId}/result.md`,
    result: terminalResult,
  };
}

function stillWaiting(waitingJobIds: string[]): WaitStreamEvent {
  return {
    type: 'waiting',
    waitingJobIds,
  };
}

async function* emit(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

type MockExecutionService = WorkflowExecutionPort & {
  coralDispatch: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  awaitLaunch: ReturnType<typeof vi.fn>;
  waitStream: ReturnType<typeof vi.fn>;
  cleanupWorkflowSessions: ReturnType<typeof vi.fn>;
  waitForJobTerminal: ReturnType<typeof vi.fn>;
};

function createExecutionService(overrides: Partial<MockExecutionService> = {}): MockExecutionService {
  return {
    coralDispatch: vi.fn(async () => running('job-1', 'session-1')),
    resume: vi.fn(async () => running('job-resumed', 'session-1')),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    awaitLaunch: vi.fn(async () => 'ready'),
    waitStream: vi.fn((_req: WaitRequest) => emit([])),
    cleanupWorkflowSessions: vi.fn(),
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

describe('toSessionHandles', () => {
  it('deduplicates atoms by (providerName, sessionId)', () => {
    const handles = toSessionHandles([
      { providerName: 'claude', sessionId: 'sess-a' },
      { providerName: 'claude', sessionId: 'sess-b' },
      { providerName: 'claude', sessionId: 'sess-a' },
      { providerName: 'codex', sessionId: 'sess-a' },
    ]);

    expect(handles).toEqual([
      { providerName: 'claude', sessionId: 'sess-a' },
      { providerName: 'claude', sessionId: 'sess-b' },
      { providerName: 'codex', sessionId: 'sess-a' },
    ]);
  });

  it('treats same sessionId across providers as distinct handles', () => {
    const handles = toSessionHandles([
      { providerName: 'claude', sessionId: 'sess-1' },
      { providerName: 'codex', sessionId: 'sess-1' },
    ]);

    expect(handles).toHaveLength(2);
  });

  it('returns an empty array for no atoms', () => {
    expect(toSessionHandles([])).toEqual([]);
  });
});

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

  it('prepends shared context to every atom prompt across a two-step pipeline', async () => {
    const dispatched: Array<{ coralName: string; prompt: string }> = [];
    let callCount = 0;
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName, input) => {
        callCount += 1;
        dispatched.push({ coralName, prompt: String(input.prompt) });
        return running(`job-${callCount}`, `session-${callCount}`);
      }),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds.includes('job-1') && req.jobIds.includes('job-2')) {
          return emit([
            terminal('job-1', 'session-1', { content: 'ARCH' }),
            terminal('job-2', 'session-2', { content: 'LIT A' }),
          ]);
        }
        return emit([
          terminal('job-3', 'session-3', { content: 'FINAL' }),
          terminal('job-4', 'session-4', { content: 'LIT B' }),
        ]);
      }),
    });

    await executePipeline(
      parseExpression('(architect, "Use A") -> (resolver, "Use B")'),
      'seed',
      'codex',
      executionSvc,
      ctx,
      { context: 'SHARED', ids: workflowIds, time: workflowTime },
    );

    expect(dispatched).toEqual([
      { coralName: 'architect', prompt: 'SHARED\n\nseed' },
      { coralName: 'workflow-literal', prompt: 'SHARED\n\nUse A' },
      {
        coralName: 'resolver',
        prompt: 'SHARED\n\n<architect>\nARCH\n</architect>\n\n<step-result>\nLIT A\n</step-result>',
      },
      {
        coralName: 'workflow-literal',
        prompt: 'SHARED\n\nUse B\n\n<architect>\nARCH\n</architect>\n\n<step-result>\nLIT A\n</step-result>',
      },
    ]);
  });

  it('formats parallel prompt literals into tagged output and preserves prompt step details', async () => {
    const prompts: string[] = [];
    let callCount = 0;
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, _coralName, input) => {
        prompts.push(String(input.prompt));
        callCount += 1;
        return running(`job-${callCount}`, `session-${callCount}`);
      }),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds.includes('job-1') && req.jobIds.includes('job-2')) {
          return emit([
            terminal('job-1', 'session-1', { content: 'OUT A' }),
            terminal('job-2', 'session-2', { content: 'OUT B' }),
          ]);
        }
        return emit([]);
      }),
    });

    const result = await executePipeline(
      parseExpression('("Use A", "Use B")'),
      'ignored seed',
      'codex',
      executionSvc,
      ctx,
      { ids: workflowIds, time: workflowTime },
    );

    expect(prompts).toEqual(['Use A', 'Use B']);
    expect(result.finalOutput).toBe('<step-result>\nOUT A\n</step-result>\n\n<step-result>\nOUT B\n</step-result>');
    expect(result.stepDetails).toEqual([
      {
        stepIndex: 0,
        atomIndex: 0,
        label: 'prompt#0(Use A)',
        output: 'OUT A',
      },
      {
        stepIndex: 0,
        atomIndex: 1,
        label: 'prompt#1(Use B)',
        output: 'OUT B',
      },
    ]);
  });

  it('keeps same-agent different-provider outputs separate across stale recovery', async () => {
    // Mock Date.now to guarantee time advances between lastActivityAt set and stale check.
    // Without this, real Date.now() may not advance 1ms between sync mock calls → stale
    // detection never triggers → infinite loop → OOM.
    let mockNow = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockNow += 10;
      return mockNow;
    });

    let firstCycle = true;
    const executionSvc = createExecutionService({
      resume: vi.fn(async () => running('job-codex-resumed', 'session-codex')),
      waitStream: vi.fn((req: WaitRequest) => {
        if (firstCycle) {
          firstCycle = false;
          return emit([stillWaiting([...req.jobIds])]);
        }
        return emit([
          terminal('job-codex-resumed', 'session-codex', { content: 'CODEX DONE' }),
          terminal('job-claude', 'session-claude', { content: 'CLAUDE DONE' }),
        ]);
      }),
    });

    try {
      const results = await waitForAtoms(
        [
          launchedAtom({
            jobId: 'job-codex',
            sessionId: 'session-codex',
            providerName: 'codex',
            agent: 'architect',
            atomKey: '0:0',
          }),
          launchedAtom({
            jobId: 'job-claude',
            sessionId: 'session-claude',
            providerName: 'claude',
            agent: 'architect',
            atomIndex: 1,
            atomKey: '0:1',
          }),
        ],
        executionSvc,
        ctx,
        {
          staleTimeoutMs: 1,
          staleCheckIntervalMs: 1,
          staleAbortTimeoutMs: 30_000,
          drainDeadlineMs: 15_000,
          workDir: '/tmp/coral-workflow-cwd',
          onProgress: vi.fn(),
          recoverStaleAtom,
          time: workflowTime,
        },
      );

      expect(executionSvc.abort).toHaveBeenCalledWith(['job-codex']);
      expect(executionSvc.waitForJobTerminal).toHaveBeenCalledWith('job-codex', 30_000);
      expect(executionSvc.resume).toHaveBeenCalledTimes(1);
      expect(executionSvc.abort.mock.invocationCallOrder[0]).toBeLessThan(
        executionSvc.waitForJobTerminal.mock.invocationCallOrder[0],
      );
      expect(executionSvc.waitForJobTerminal.mock.invocationCallOrder[0]).toBeLessThan(
        executionSvc.resume.mock.invocationCallOrder[0],
      );
      expect(executionSvc.resume).toHaveBeenCalledWith(
        'codex',
        {
          sessionId: 'session-codex',
          prompt: 'Your previous execution timed out due to inactivity. Continue where you left off.',
          cwd: '/tmp/coral-workflow-cwd',
        },
        ctx,
      );
      expect([...results.entries()]).toEqual([
        ['0:0', 'CODEX DONE'],
        ['0:1', 'CLAUDE DONE'],
      ]);
    } finally {
      vi.restoreAllMocks();
    }
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
      expect(executionSvc.waitForJobTerminal).toHaveBeenCalledWith('job-1', 30_000);
      expect(executionSvc.resume).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('success path passes all launched sessions to cleanup port', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName) => {
        if (coralName === 'architect') {
          return running('job-1', 'session-1');
        }
        return running('job-2', 'session-2');
      }),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds.includes('job-1') && req.jobIds.includes('job-2')) {
          return emit([
            terminal('job-1', 'session-1', { content: 'ARCH' }),
            terminal('job-2', 'session-2', { content: 'CRIT' }),
          ]);
        }
        return emit([]);
      }),
    });

    const result = await executePipeline(parseExpression('(architect, critic)'), 'seed', 'claude', executionSvc, ctx, {
      ids: workflowIds,
      time: workflowTime,
    });

    expect(result.finalOutput).toBe('<architect>\nARCH\n</architect>\n\n<critic>\nCRIT\n</critic>');
    expect(executionSvc.coralDispatch).toHaveBeenNthCalledWith(
      1,
      'claude',
      'architect',
      expect.objectContaining({ prompt: 'seed', cwd: ctx.projectRoot }),
      ctx,
    );
    expect(executionSvc.coralDispatch).toHaveBeenNthCalledWith(
      2,
      'claude',
      'critic',
      expect.objectContaining({ prompt: 'seed', cwd: ctx.projectRoot }),
      ctx,
    );
    expect(executionSvc.cleanupWorkflowSessions).toHaveBeenCalledWith([
      { providerName: 'claude', sessionId: 'session-1' },
      { providerName: 'claude', sessionId: 'session-2' },
    ]);
  });

  it('abort path still invokes cleanup with launched sessions', async () => {
    const controller = new AbortController();
    let waitCalls = 0;
    const executionSvc = createExecutionService({
      waitStream: vi.fn((_req: WaitRequest) => {
        waitCalls += 1;
        if (waitCalls === 1) {
          controller.abort();
          return emit([stillWaiting(['job-1'])]);
        }
        return emit([
          terminal('job-1', 'session-1', { content: '', outcome: { kind: 'aborted', reason: 'signal_abort' } }),
        ]);
      }),
    });

    await expect(
      executePipeline(parseExpression('architect'), 'seed', 'claude', executionSvc, ctx, {
        signal: controller.signal,
        ids: workflowIds,

        time: workflowTime,
      }),
    ).rejects.toMatchObject({
      message: 'Pipeline aborted (launched atoms may continue)',
      aborted: true,
    });

    expect(executionSvc.cleanupWorkflowSessions).toHaveBeenCalledTimes(1);
    expect(executionSvc.cleanupWorkflowSessions).toHaveBeenCalledWith([
      { providerName: 'claude', sessionId: 'session-1' },
    ]);
  });

  it('error path still invokes cleanup with launched sessions', async () => {
    const executionSvc = createExecutionService({
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds[0] === 'job-1') {
          return emit([
            terminal('job-1', 'session-1', {
              content: '',
              outcome: {
                kind: 'failed',
                causeRef: {
                  stream: {
                    kind: 'session',
                    id: 'session-1',
                  },
                  seq: 1,
                },
              },
            }),
          ]);
        }
        return emit([]);
      }),
    });

    await expect(
      executePipeline(parseExpression('architect'), 'seed', 'claude', executionSvc, ctx, {
        ids: workflowIds,
        time: workflowTime,
      }),
    ).rejects.toMatchObject({
      message: "Step 0, atom 'architect' failed: Failed: session/session-1#1",
      aborted: false,
    });

    expect(executionSvc.cleanupWorkflowSessions).toHaveBeenCalledWith([
      { providerName: 'claude', sessionId: 'session-1' },
    ]);
  });

  it('very-early-abort invokes cleanup with an empty session list', async () => {
    const controller = new AbortController();
    controller.abort();

    const executionSvc = createExecutionService();

    await expect(
      executePipeline(parseExpression('architect'), 'seed', 'claude', executionSvc, ctx, {
        signal: controller.signal,
        ids: workflowIds,

        time: workflowTime,
      }),
    ).rejects.toMatchObject({ aborted: true });

    expect(executionSvc.cleanupWorkflowSessions).toHaveBeenCalledWith([]);
    expect(executionSvc.coralDispatch).not.toHaveBeenCalled();
  });

  it('codex-only pipeline delegates cleanup routing to the port', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async () => running('job-1', 'session-1')),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds[0] === 'job-1') {
          return emit([terminal('job-1', 'session-1', { content: 'DONE' })]);
        }
        return emit([]);
      }),
    });

    const result = await executePipeline(parseExpression('architect'), 'seed', 'codex', executionSvc, ctx, {
      ids: workflowIds,
      time: workflowTime,
    });

    expect(result.finalOutput).toBe('DONE');
    expect(executionSvc.cleanupWorkflowSessions).toHaveBeenCalledWith([
      { providerName: 'codex', sessionId: 'session-1' },
    ]);
  });

  it('invokes cleanup with the (providerName, sessionId) pair after stale recovery', async () => {
    // Mock Date.now to guarantee time advances between lastActivityAt set and stale check.
    let mockNow = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockNow += 10;
      return mockNow;
    });

    let firstCycle = true;
    const executionSvc = createExecutionService({
      resume: vi.fn(async () => running('job-resumed', 'session-1')),
      waitStream: vi.fn((_req: WaitRequest) => {
        if (firstCycle) {
          firstCycle = false;
          return emit([stillWaiting(['job-1'])]);
        }
        return emit([terminal('job-resumed', 'session-1', { content: 'DONE' })]);
      }),
    });

    try {
      const result = await executePipeline(parseExpression('architect'), 'seed', 'claude', executionSvc, ctx, {
        staleTimeoutMs: 1,
        staleCheckIntervalMs: 1,
        workflowJobId: 'workflow-1',
        ids: workflowIds,

        time: workflowTime,
      });

      expect(result.finalOutput).toBe('DONE');
      expect(executionSvc.resume).toHaveBeenCalledWith(
        'claude',
        {
          sessionId: 'session-1',
          prompt: 'Your previous execution timed out due to inactivity. Continue where you left off.',
          cwd: ctx.projectRoot,
          parentWorkflowJobId: 'workflow-1',
          workflowSlotId: 'workflow-1:0:0',
        },
        ctx,
      );
      expect(executionSvc.cleanupWorkflowSessions).toHaveBeenCalledTimes(1);
      expect(executionSvc.cleanupWorkflowSessions).toHaveBeenCalledWith([
        { providerName: 'claude', sessionId: 'session-1' },
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('preserves launched sibling output when a parallel launch fails', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName) => {
        if (coralName === 'architect') return running('job-a', 'session-a');
        return {
          status: 'rejected' as const,
          phase: 'preflight' as const,
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

  it('preserves completed sibling output when a parallel atom fails after partial completion', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName) => {
        if (coralName === 'architect') return running('job-a', 'session-a');
        return running('job-b', 'session-b');
      }),
      waitStream: vi.fn(() =>
        emit([
          terminal('job-a', 'session-a', { content: 'ARCH' }),
          terminal('job-b', 'session-b', {
            content: '',
            outcome: {
              kind: 'failed',
              causeRef: {
                stream: {
                  kind: 'session',
                  id: 'session-b',
                },
                seq: 1,
              },
            },
          }),
        ]),
      ),
    });

    await expect(
      executePipeline(parseExpression('(architect, critic)'), 'seed', 'codex', executionSvc, ctx, {
        ids: workflowIds,
        time: workflowTime,
      }),
    ).rejects.toMatchObject({
      message: "Step 0, atom 'critic' failed: Failed: session/session-b#1",
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

  it('later-step literal prepends literal text before prior step output', async () => {
    const capturedPrompts: string[] = [];
    let callCount = 0;
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, _coralName, input) => {
        callCount += 1;
        capturedPrompts.push(String(input.prompt));
        return running(`job-${callCount}`, `session-${callCount}`);
      }),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds[0] === 'job-1') {
          return emit([terminal('job-1', 'session-1', { content: 'PREV OUTPUT' })]);
        }
        return emit([terminal('job-2', 'session-2', { content: 'DONE' })]);
      }),
    });

    await executePipeline(parseExpression('architect -> "Apply this fixup"'), 'seed', 'codex', executionSvc, ctx, {
      ids: workflowIds,
      time: workflowTime,
    });

    const step2 = capturedPrompts[1];
    expect(step2).toContain('Apply this fixup');
    expect(step2).toContain('PREV OUTPUT');
    expect(step2.indexOf('Apply this fixup')).toBeLessThan(step2.indexOf('PREV OUTPUT'));
  });
});

describe('formatStepOutput', () => {
  it('returns empty string for an empty results array', () => {
    expect(formatStepOutput([])).toBe('');
  });

  it('returns bare output without XML tags for a single result', () => {
    const output = formatStepOutput([{ tagName: 'architect', output: 'result text' }]);
    expect(output).toBe('result text');
    expect(output).not.toContain('<architect>');
  });

  it('wraps multiple results in XML tags with two-newline separator', () => {
    const output = formatStepOutput([
      { tagName: 'architect', output: 'ARCH' },
      { tagName: 'critic', output: 'CRIT' },
    ]);
    expect(output).toContain('<architect>\nARCH\n</architect>');
    expect(output).toContain('<critic>\nCRIT\n</critic>');
  });
});

describe('launchAtomWithRetry', () => {
  it('accepts queued launches as valid bootstrap outcomes', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async () => ({
        status: 'queued' as const,
        job: 'job-queued',
        session: 'session-queued',
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
    });
    expect(executionSvc.coralDispatch).toHaveBeenCalledTimes(1);
    expect(executionSvc.coralDispatch).toHaveBeenCalledWith(
      'codex',
      'architect',
      expect.objectContaining({
        prompt: 'do work',
        jobId: 'planned-job-1',
        workflowSlotId: 'workflow-1:0:0',
        cwd: ctx.projectRoot,
      }),
      ctx,
    );
    expect(executionSvc.awaitLaunch).toHaveBeenCalledWith('job-queued', BOOTSTRAP_TIMEOUT_MS);
  });

  it('uses an explicit workDir for atom launches', async () => {
    const executionSvc = createExecutionService();

    await launchAtomWithRetry({
      slot: planSlot(),
      atomIndex: 0,
      stepPrompt: 'do work',
      workDir: '/tmp/coral-workflow-cwd',
      executionSvc,
      ctx,
      completedStepDetails: [],
    });

    expect(executionSvc.coralDispatch).toHaveBeenCalledWith(
      'codex',
      'architect',
      expect.objectContaining({
        cwd: '/tmp/coral-workflow-cwd',
      }),
      ctx,
    );
  });

  it('throws with step/atom context when coralDispatch returns rejected status', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async () => ({
        status: 'rejected' as const,
        phase: 'preflight' as const,
        code: 'unknown_provider',
        message: 'Unknown provider: ghost',
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
      }),
    ).rejects.toThrow("Step 0, atom 'architect' launch failed: Unknown provider: ghost");
  });

  it('passes the planned workflow identifiers through to coralDispatch', async () => {
    const executionSvc = createExecutionService();
    await launchAtomWithRetry({
      slot: planSlot({ slotId: 'workflow-9:2:4', jobId: 'planned-job-9', stepIndex: 2, atomKey: '2:4' }),
      atomIndex: 4,
      stepPrompt: 'test',
      executionSvc,
      ctx,
      completedStepDetails: [],
      workflowJobId: 'workflow-9',
    });

    expect(executionSvc.coralDispatch).toHaveBeenCalledWith(
      'codex',
      'architect',
      expect.objectContaining({
        prompt: 'test',
        jobId: 'planned-job-9',
        workflowSlotId: 'workflow-9:2:4',
        parentWorkflowJobId: 'workflow-9',
      }),
      ctx,
    );
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
            jobId: 'job-1',
            sessionId: 'session-1',
            queuePosition: 2,
            runningJobIds: ['job-a'],
          },
          terminal('job-1', 'session-1', { content: 'ARCH' }),
        ]),
      ),
    });

    const results = await waitForAtoms([launchedAtom()], executionSvc, ctx, {
      staleTimeoutMs: 0,
      staleCheckIntervalMs: 500,
      drainDeadlineMs: 15_000,
      onProgress: progress,
      time: workflowTime,
    });

    expect(results.get('0:0')).toBe('ARCH');
    expect(progress).toHaveBeenCalledWith('0-arc queued (position 2)');
    expect(progress).toHaveBeenCalledWith('0-arc done');
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
            coralOp: 'coral:critic',
            atomIndex: 1,
            atomKey: '0:1',
          }),
        ],
        executionSvc,
        ctx,
        {
          staleTimeoutMs: 0,
          staleCheckIntervalMs: 500,
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
        drainDeadlineMs: 15_000,
        onProgress: vi.fn(),
        time: workflowTime,
      }),
    ).rejects.toBeInstanceOf(WorkflowExecutionError);
  });
});
