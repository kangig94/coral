import { describe, expect, it, vi } from 'vitest';
import type { CallerContext } from '../../execution/service.js';
import type { TerminalResult, WaitRequest, WaitStreamEvent } from '../../types.js';
import { parseExpression } from '../pipe-parser.js';
import {
  MAX_LAUNCH_ATTEMPTS,
  executePipeline,
  formatStepOutput,
  launchAtomWithRetry,
  waitForAtoms,
  type WorkflowExecutionService,
} from '../pipe-executor.js';

const ctx: CallerContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
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
};

function createExecutionService(overrides: Partial<MockExecutionService> = {}): MockExecutionService {
  return {
    coralDispatch: vi.fn(async () => running('job-1', 'session-1')),
    resume: vi.fn(async () => running('job-resumed', 'session-1')),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    awaitLaunch: vi.fn(async () => 'ready'),
    waitStream: vi.fn((_req: WaitRequest) => emit([])),
    ...overrides,
  } as MockExecutionService;
}

describe('workflow pipe executor', () => {
  it('passes each step output as the next step prompt', async () => {
    const prompts: string[] = [];
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName, input) => {
        prompts.push(String(input.prompt));
        return coralName === 'architect' ? running('job-1', 'session-1') : running('job-2', 'session-2');
      }),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds[0] === 'job-1') {
          return emit([terminal('job-1', 'session-1', { text: 'ARCH' })]);
        }
        return emit([terminal('job-2', 'session-2', { text: 'FINAL' })]);
      }),
    });

    const output = await executePipeline(
      parseExpression('architect -> resolver'),
      'seed',
      'codex',
      executionSvc,
      ctx,
    );

    expect(output).toBe('FINAL');
    expect(prompts).toEqual(['seed', 'ARCH']);
  });

  it('formats multiple atoms in a parallel step into tagged output', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName) => {
        if (coralName === 'architect') return running('job-a', 'session-a');
        return running('job-b', 'session-b');
      }),
      waitStream: vi.fn((_req: WaitRequest) => emit([
        terminal('job-a', 'session-a', { text: 'ARCH' }),
        terminal('job-b', 'session-b', { text: 'CRIT' }),
      ])),
    });

    const output = await executePipeline(
      parseExpression('(architect, critic)'),
      'seed',
      'codex',
      executionSvc,
      ctx,
    );

    expect(output).toBe('<architect>\nARCH\n</architect>\n\n<critic>\nCRIT\n</critic>');
  });

  it('retries busy launches up to MAX_LAUNCH_ATTEMPTS', async () => {
    let attempt = 0;
    const progress: string[] = [];
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async () => {
        attempt += 1;
        return running(`job-${attempt}`, `session-${attempt}`);
      }),
      awaitLaunch: vi.fn(async (): Promise<'busy'> => 'busy'),
    });

    await expect(executePipeline(
      parseExpression('architect'),
      'seed',
      'codex',
      executionSvc,
      ctx,
      { onProgress: (message) => progress.push(message) },
    )).rejects.toThrow(`capacity busy after ${MAX_LAUNCH_ATTEMPTS} attempts`);

    expect(executionSvc.coralDispatch).toHaveBeenCalledTimes(MAX_LAUNCH_ATTEMPTS);
    expect(executionSvc.awaitLaunch).toHaveBeenCalledTimes(MAX_LAUNCH_ATTEMPTS);
    expect(progress.some((message) => message.includes('busy (attempt 1), retrying'))).toBe(true);
  });

  it('aborts and resumes stale atoms', async () => {
    const progress: string[] = [];
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async () => running('job-stale', 'session-1')),
      resume: vi.fn(async () => running('job-resumed', 'session-1')),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds[0] === 'job-stale') {
          return emit([timeout(['job-stale'])]);
        }
        return emit([terminal('job-resumed', 'session-1', { text: 'DONE' })]);
      }),
    });

    const output = await executePipeline(
      parseExpression('architect'),
      'seed',
      'codex',
      executionSvc,
      ctx,
      {
        staleTimeoutMs: 1,
        onProgress: (message) => progress.push(message),
      },
    );

    expect(output).toBe('DONE');
    expect(executionSvc.abort).toHaveBeenCalledWith(['job-stale']);
    expect(executionSvc.resume).toHaveBeenCalledWith(
      'codex',
      {
        sessionId: 'session-1',
        prompt: 'Your previous execution timed out due to inactivity. Continue where you left off.',
        cwd: ctx.projectRoot,
      },
      ctx,
    );
    expect(progress).toContain('atom architect stale, aborting');
    expect(progress).toContain('atom architect resumed');
  });

  it('aborts sibling atoms after the first failure', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName) => {
        if (coralName === 'architect') return running('job-a', 'session-a');
        return running('job-b', 'session-b');
      }),
      waitStream: vi.fn((req: WaitRequest) => {
        if (req.jobIds.includes('job-a') && req.jobIds.includes('job-b')) {
          return emit([terminal('job-a', 'session-a', { text: '', notice: 'primary failure' })]);
        }
        return emit([terminal('job-b', 'session-b', { text: '', aborted: true })]);
      }),
    });

    await expect(executePipeline(
      parseExpression('(architect, critic)'),
      'seed',
      'codex',
      executionSvc,
      ctx,
    )).rejects.toThrow("Step 1, atom 'architect' failed: primary failure");

    expect(executionSvc.abort).toHaveBeenCalledWith(['job-b']);
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

describe('launchAtomWithRetry: launch rejection', () => {
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
      onProgress: vi.fn(),
    })).rejects.toThrow("Step 1, atom 'architect' launch failed: Unknown provider: ghost");
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
      onProgress: vi.fn(),
    })).rejects.toThrow('unsupported namespace "custom-ns"');

    expect(executionSvc.coralDispatch).not.toHaveBeenCalled();
  });
});

describe('waitForAtoms: terminal event with notice field', () => {
  it('treats notice on terminal result as a failure (not a success)', async () => {
    const executionSvc = createExecutionService({
      waitStream: vi.fn((_req: WaitRequest) => emit([
        terminal('job-1', 'session-1', { text: '', notice: 'process killed' }),
      ])),
    });

    const atoms = [
      {
        jobId: 'job-1', sessionId: 'session-1', providerName: 'codex',
        coralOp: 'coral:architect', agent: 'architect', tagName: 'architect', stepIndex: 0,
      },
    ];

    await expect(
      waitForAtoms(atoms, executionSvc, ctx, {
        staleTimeoutMs: 0,
        pollIntervalMs: 500,
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow("Step 1, atom 'architect' failed: process killed");
  });
});

describe('executePipeline: stale recovery resets sibling activity clocks', () => {
  it('sibling atoms are not re-detected as stale immediately after recovery', async () => {
    let abortCalled = false;

    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, coralName) => {
        if (coralName === 'architect') return running('job-a', 'session-a');
        return running('job-b', 'session-b');
      }),
      abort: vi.fn((jobIds: string[]) => {
        abortCalled = true;
        return { aborted: jobIds, notFound: [] };
      }),
      resume: vi.fn(async () => running('job-a-resumed', 'session-a')),
      waitStream: vi.fn((req: WaitRequest) => {
        if (!abortCalled && (req.jobIds.includes('job-a') || req.jobIds.includes('job-b'))) {
          return emit([timeout([...req.jobIds])]);
        }
        const events: WaitStreamEvent[] = [];
        if (req.jobIds.includes('job-a-resumed')) {
          events.push(terminal('job-a-resumed', 'session-a', { text: 'ARCH DONE' }));
        }
        if (req.jobIds.includes('job-b')) {
          events.push(terminal('job-b', 'session-b', { text: 'CRIT DONE' }));
        }
        return emit(events.length > 0 ? events : []);
      }),
    });

    const results = await waitForAtoms(
      [
        {
          jobId: 'job-a', sessionId: 'session-a', providerName: 'codex',
          coralOp: 'coral:architect', agent: 'architect', tagName: 'architect', stepIndex: 0,
        },
        {
          jobId: 'job-b', sessionId: 'session-b', providerName: 'codex',
          coralOp: 'coral:critic', agent: 'critic', tagName: 'critic', stepIndex: 0,
        },
      ],
      executionSvc,
      ctx,
      { staleTimeoutMs: 1, pollIntervalMs: 1, onProgress: vi.fn() },
    );

    expect(executionSvc.abort).toHaveBeenCalled();
    expect(executionSvc.resume).toHaveBeenCalledTimes(1);
    expect(results.size).toBeGreaterThan(0);
  });
});

describe('executePipeline: literal prompt atoms', () => {
  it('first-step literal uses only the literal text as prompt (ignores seed)', async () => {
    const capturedPrompts: string[] = [];
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async (_provider, _coralName, input) => {
        capturedPrompts.push(String(input.prompt));
        return running('job-1', 'session-1');
      }),
      waitStream: vi.fn(() => emit([terminal('job-1', 'session-1', { text: 'OUT' })])),
    });

    await executePipeline(
      parseExpression('"Use this exact instruction"'),
      'ignored seed',
      'codex',
      executionSvc,
      ctx,
    );

    expect(capturedPrompts[0]).toBe('Use this exact instruction');
    expect(capturedPrompts[0]).not.toContain('ignored seed');
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
          return emit([terminal('job-1', 'session-1', { text: 'PREV OUTPUT' })]);
        }
        return emit([terminal('job-2', 'session-2', { text: 'DONE' })]);
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

describe('executePipeline: error propagation', () => {
  it('throws step/atom context when atom completes with aborted result', async () => {
    const executionSvc = createExecutionService({
      coralDispatch: vi.fn(async () => running('job-1', 'session-1')),
      waitStream: vi.fn(() => emit([
        terminal('job-1', 'session-1', { text: '', aborted: true }),
      ])),
    });

    await expect(executePipeline(
      parseExpression('architect'),
      'seed',
      'codex',
      executionSvc,
      ctx,
    )).rejects.toThrow("Step 1, atom 'architect' failed: aborted");
  });
});
