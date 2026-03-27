import { describe, expect, it, vi } from 'vitest';
import type { CallerContext } from '../../execution/service.js';
import type { TerminalResult, WaitRequest, WaitStreamEvent } from '../../shared/types.js';
import { parseExpression } from '../pipe-parser.js';
import {
  BOOTSTRAP_TIMEOUT_MS,
  WorkflowExecutionError,
  executePipeline,
  formatStepOutput,
  launchAtomWithRetry,
  waitForAtoms,
  type LaunchedAtom,
  type WorkflowExecutionService,
} from '../pipe-executor.js';

const ctx: CallerContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
  coralEnv: {},
};

function running(job: string, session: string) {
  return {
    status: 'running' as const,
    job,
    session,
  };
}

function terminal(
  jobId: string,
  sessionId: string,
  result: TerminalResult,
): WaitStreamEvent {
  return {
    type: 'terminal',
    completedJobId: jobId,
    sessionId,
    remainingJobIds: [],
    resultPath: `/tmp/coral-jobs/${jobId}/result.md`,
    result,
  };
}

function timeout(runningJobIds: string[]): WaitStreamEvent {
  return {
    type: 'timeout',
    runningJobIds,
  };
}

async function* emit(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

type MockExecutionService = WorkflowExecutionService & {
  coralDispatch: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  awaitLaunch: ReturnType<typeof vi.fn>;
  waitStream: ReturnType<typeof vi.fn>;
  getConversationRef: ReturnType<typeof vi.fn>;
};

function createExecutionService(overrides: Partial<MockExecutionService> = {}): MockExecutionService {
  return {
    coralDispatch: vi.fn(async () => running('job-1', 'session-1')),
    resume: vi.fn(async () => running('job-resumed', 'session-1')),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    awaitLaunch: vi.fn(async () => 'ready'),
    waitStream: vi.fn((_req: WaitRequest) => emit([])),
    getConversationRef: vi.fn(() => undefined),
    ...overrides,
  } as MockExecutionService;
}

function launchedAtom(overrides: Partial<LaunchedAtom> = {}): LaunchedAtom {
  return {
    jobId: 'job-1',
    sessionId: 'session-1',
    providerName: 'codex',
    coralOp: 'coral:architect',
    agent: 'architect',
    tagName: 'architect',
    stepIndex: 0,
    atomIndex: 0,
    atomKey: '0:0',
    kind: 'agent',
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

    const result = await executePipeline(
      parseExpression('architect -> resolver'),
      'seed',
      'codex',
      executionSvc,
      ctx,
    );

    expect(result.finalOutput).toBe('FINAL');
    expect(result.stepDetails).toEqual([
      {
        stepIndex: 0,
        atomIndex: 0,
        kind: 'agent',
        label: 'architect',
        provider: 'codex',
        tagName: 'architect',
        output: 'ARCH',
      },
      {
        stepIndex: 1,
        atomIndex: 0,
        kind: 'agent',
        label: 'resolver',
        provider: 'codex',
        tagName: 'resolver',
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
      { context: 'SHARED' },
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
    );

    expect(prompts).toEqual(['Use A', 'Use B']);
    expect(result.finalOutput).toBe('<step-result>\nOUT A\n</step-result>\n\n<step-result>\nOUT B\n</step-result>');
    expect(result.stepDetails).toEqual([
      {
        stepIndex: 0,
        atomIndex: 0,
        kind: 'prompt',
        label: 'prompt#0(Use A)',
        provider: 'codex',
        tagName: 'step-result',
        output: 'OUT A',
      },
      {
        stepIndex: 0,
        atomIndex: 1,
        kind: 'prompt',
        label: 'prompt#1(Use B)',
        provider: 'codex',
        tagName: 'step-result',
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
          return emit([timeout([...req.jobIds])]);
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
          pollIntervalMs: 1,
          workDir: '/tmp/coral-workflow-cwd',
          onProgress: vi.fn(),
        },
      );

      expect(executionSvc.abort).toHaveBeenCalledWith(['job-codex']);
      expect(executionSvc.resume).toHaveBeenCalledTimes(1);
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

  it('success path calls cleanup with resolved refs, undefined refs skipped', async () => {
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
      getConversationRef: vi.fn((_provider, sessionId) => (
        sessionId === 'session-1' ? 'conv-ref-1' : undefined
      )),
    });

    const result = await executePipeline(
      parseExpression('(architect, critic)'),
      'seed',
      'claude',
      executionSvc,
      ctx,
    );

    expect(result.finalOutput).toBe(
      '<architect>\nARCH\n</architect>\n\n<critic>\nCRIT\n</critic>',
    );
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
    expect(executionSvc.getConversationRef).toHaveBeenCalledWith('claude', 'session-1');
    expect(executionSvc.getConversationRef).toHaveBeenCalledWith('claude', 'session-2');
  });

  it('abort path calls cleanup', async () => {
    const controller = new AbortController();
    let waitCalls = 0;
    const executionSvc = createExecutionService({
      getConversationRef: vi.fn(() => 'conv-ref-aborted'),
      waitStream: vi.fn((_req: WaitRequest) => {
        waitCalls += 1;
        if (waitCalls === 1) {
          controller.abort();
          return emit([timeout(['job-1'])]);
        }
        return emit([terminal('job-1', 'session-1', { content: '', aborted: true })]);
      }),
    });

    await expect(executePipeline(
      parseExpression('architect'),
      'seed',
      'claude',
      executionSvc,
      ctx,
      { signal: controller.signal },
    )).rejects.toMatchObject({
      message: 'Pipeline aborted (launched atoms may continue)',
      aborted: true,
    });

    expect(executionSvc.getConversationRef).toHaveBeenCalledWith('claude', 'session-1');
    expect(executionSvc.getConversationRef).toHaveBeenCalledTimes(1);
  });

  it('error path calls cleanup', async () => {
    const executionSvc = createExecutionService({
      getConversationRef: vi.fn(() => 'conv-ref-error'),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds[0] === 'job-1') {
          return emit([terminal('job-1', 'session-1', { content: '', notice: 'error msg' })]);
        }
        return emit([]);
      }),
    });

    await expect(executePipeline(
      parseExpression('architect'),
      'seed',
      'claude',
      executionSvc,
      ctx,
    )).rejects.toMatchObject({
      message: "Step 0, atom 'architect' failed: error msg",
      aborted: false,
    });

    expect(executionSvc.getConversationRef).toHaveBeenCalledWith('claude', 'session-1');
  });

  it('very-early-abort skips cleanup with no launched atoms', async () => {
    const controller = new AbortController();
    controller.abort();

    const executionSvc = createExecutionService({
      getConversationRef: vi.fn(() => 'conv-ref-skipped'),
    });

    await expect(executePipeline(
      parseExpression('architect'),
      'seed',
      'claude',
      executionSvc,
      ctx,
      { signal: controller.signal },
    )).rejects.toMatchObject({ aborted: true });

    expect(executionSvc.getConversationRef).not.toHaveBeenCalled();
    expect(executionSvc.coralDispatch).not.toHaveBeenCalled();
  });

  it('codex-only pipeline skips ref resolution', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async () => running('job-1', 'session-1')),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds[0] === 'job-1') {
          return emit([terminal('job-1', 'session-1', { content: 'DONE' })]);
        }
        return emit([]);
      }),
      getConversationRef: vi.fn(() => 'conv-ref-codex'),
    });

    const result = await executePipeline(
      parseExpression('architect'),
      'seed',
      'codex',
      executionSvc,
      ctx,
    );

    expect(result.finalOutput).toBe('DONE');
    expect(executionSvc.getConversationRef).not.toHaveBeenCalled();
  });

  it('deduplicates stale-recovered claude sessions by sessionId', async () => {
    // Mock Date.now to guarantee time advances between lastActivityAt set and stale check.
    let mockNow = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      mockNow += 10;
      return mockNow;
    });

    let firstCycle = true;
    const executionSvc = createExecutionService({
      getConversationRef: vi.fn(() => 'conv-ref-1'),
      resume: vi.fn(async () => running('job-resumed', 'session-1')),
      waitStream: vi.fn((_req: WaitRequest) => {
        if (firstCycle) {
          firstCycle = false;
          return emit([timeout(['job-1'])]);
        }
        return emit([
          terminal('job-resumed', 'session-1', { content: 'DONE' }),
        ]);
      }),
    });

    try {
      const result = await executePipeline(
        parseExpression('architect'),
        'seed',
        'claude',
        executionSvc,
        ctx,
        { staleTimeoutMs: 1, pollIntervalMs: 1 },
      );

      expect(result.finalOutput).toBe('DONE');
      expect(executionSvc.resume).toHaveBeenCalledWith(
        'claude',
        {
          sessionId: 'session-1',
          prompt: 'Your previous execution timed out due to inactivity. Continue where you left off.',
          cwd: ctx.projectRoot,
        },
        ctx,
      );
      expect(executionSvc.getConversationRef).toHaveBeenCalledTimes(1);
      expect(executionSvc.getConversationRef).toHaveBeenCalledWith('claude', 'session-1');
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

    await expect(executePipeline(
      parseExpression('(architect, critic)'),
      'seed',
      'codex',
      executionSvc,
      ctx,
    )).rejects.toMatchObject({
      message: "Step 0, atom 'critic' launch failed: launch blocked",
      aborted: false,
      stepDetails: [
        {
          stepIndex: 0,
          atomIndex: 0,
          kind: 'agent',
          label: 'architect',
          provider: 'codex',
          tagName: 'architect',
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
      waitStream: vi.fn(() => emit([
        terminal('job-a', 'session-a', { content: 'ARCH' }),
        terminal('job-b', 'session-b', { content: '', notice: 'primary failure' }),
      ])),
    });

    await expect(executePipeline(
      parseExpression('(architect, critic)'),
      'seed',
      'codex',
      executionSvc,
      ctx,
    )).rejects.toMatchObject({
      message: "Step 0, atom 'critic' failed: primary failure",
      aborted: false,
      stepDetails: [
        {
          stepIndex: 0,
          atomIndex: 0,
          kind: 'agent',
          label: 'architect',
          provider: 'codex',
          tagName: 'architect',
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
          return emit([timeout(['job-2'])]);
        }
        return emit([terminal('job-2', 'session-2', { content: '', aborted: true })]);
      }),
    });

    await expect(executePipeline(
      parseExpression('architect -> resolver'),
      'seed',
      'codex',
      executionSvc,
      ctx,
      { signal: controller.signal },
    )).rejects.toMatchObject({
      message: 'Pipeline aborted (launched atoms may continue)',
      aborted: true,
      stepDetails: [
        {
          stepIndex: 0,
          atomIndex: 0,
          kind: 'agent',
          label: 'architect',
          provider: 'codex',
          tagName: 'architect',
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

    await executePipeline(
      parseExpression('architect -> "Apply this fixup"'),
      'seed',
      'codex',
      executionSvc,
      ctx,
    );

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

    const [atom] = parseExpression('architect')[0];
    const launched = await launchAtomWithRetry({
      atom,
      atomIndex: 0,
      stepIndex: 0,
      stepPrompt: 'do work',
      defaultProviderName: 'codex',
      executionSvc,
      ctx,
      atoms: { architect: { instruction: 'focus on security' } },
      completedStepDetails: [],
    });

    expect(launched).toEqual({
      jobId: 'job-queued',
      sessionId: 'session-queued',
      providerName: 'codex',
      coralOp: 'coral:architect',
      agent: 'architect',
      tagName: 'architect',
      stepIndex: 0,
      atomIndex: 0,
      atomKey: '0:0',
      kind: 'agent',
    });
    expect(executionSvc.coralDispatch).toHaveBeenCalledTimes(1);
    expect(executionSvc.coralDispatch).toHaveBeenCalledWith(
      'codex',
      'architect',
      expect.objectContaining({
        prompt: expect.stringContaining('focus on security'),
        cwd: ctx.projectRoot,
      }),
      ctx,
    );
    expect(executionSvc.awaitLaunch).toHaveBeenCalledWith('job-queued', BOOTSTRAP_TIMEOUT_MS);
  });

  it('uses an explicit workDir for atom launches', async () => {
    const executionSvc = createExecutionService();
    const [atom] = parseExpression('architect')[0];

    await launchAtomWithRetry({
      atom,
      atomIndex: 0,
      stepIndex: 0,
      stepPrompt: 'do work',
      workDir: '/tmp/coral-workflow-cwd',
      defaultProviderName: 'codex',
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

    const [atom] = parseExpression('architect')[0];

    await expect(launchAtomWithRetry({
      atom,
      atomIndex: 0,
      stepIndex: 0,
      stepPrompt: 'do work',
      defaultProviderName: 'codex',
      executionSvc,
      ctx,
      completedStepDetails: [],
    })).rejects.toThrow("Step 0, atom 'architect' launch failed: Unknown provider: ghost");
  });

  it('throws with unsupported namespace error immediately without calling coralDispatch', async () => {
    const executionSvc = createExecutionService();
    const badAtom = { kind: 'agent' as const, agent: 'architect', namespace: 'custom-ns', provider: 'codex' };

    await expect(launchAtomWithRetry({
      atom: badAtom,
      atomIndex: 0,
      stepIndex: 2,
      stepPrompt: 'test',
      defaultProviderName: 'codex',
      executionSvc,
      ctx,
      completedStepDetails: [],
    })).rejects.toThrow('unsupported namespace "custom-ns"');

    expect(executionSvc.coralDispatch).not.toHaveBeenCalled();
  });
});

describe('waitForAtoms', () => {
  it('treats queued wait events as progress and keeps waiting for completion', async () => {
    const progress = vi.fn();
    const executionSvc = createExecutionService({
      waitStream: vi.fn(() => emit([
        {
          type: 'queued',
          jobId: 'job-1',
          sessionId: 'session-1',
          queuePosition: 2,
          runningJobIds: ['job-a'],
        },
        terminal('job-1', 'session-1', { content: 'ARCH' }),
      ])),
    });

    const results = await waitForAtoms(
      [launchedAtom()],
      executionSvc,
      ctx,
      {
        staleTimeoutMs: 0,
        pollIntervalMs: 500,
        onProgress: progress,
      },
    );

    expect(results.get('0:0')).toBe('ARCH');
    expect(progress).toHaveBeenCalledWith('0-arc queued (position 2)');
    expect(progress).toHaveBeenCalledWith('0-arc done');
  });

  it('treats notice on terminal result as a failure and preserves completed details', async () => {
    const executionSvc = createExecutionService({
      waitStream: vi.fn(() => emit([
        terminal('job-1', 'session-1', { content: 'ARCH' }),
        terminal('job-2', 'session-2', { content: '', notice: 'process killed' }),
      ])),
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
          pollIntervalMs: 500,
          onProgress: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      message: "Step 0, atom 'critic' failed: process killed",
      aborted: false,
      stepDetails: [
        {
          stepIndex: 0,
          atomIndex: 0,
          kind: 'agent',
          label: 'architect',
          provider: 'codex',
          tagName: 'architect',
          output: 'ARCH',
        },
      ],
    });
  });

  it('throws WorkflowExecutionError on aborted terminal results', async () => {
    const executionSvc = createExecutionService({
      waitStream: vi.fn(() => emit([
        terminal('job-1', 'session-1', { content: '', aborted: true }),
      ])),
    });

    await expect(
      waitForAtoms(
        [launchedAtom()],
        executionSvc,
        ctx,
        {
          staleTimeoutMs: 0,
          pollIntervalMs: 500,
          onProgress: vi.fn(),
        },
      ),
    ).rejects.toBeInstanceOf(WorkflowExecutionError);
  });
});
