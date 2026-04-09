import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallerContext } from '../../shared/request-context.js';

const ctx: CallerContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
  coralEnv: {},
};

function createExecutionService(result = { status: 'running', job: 'job-1', session: 'session-1' } as const) {
  return {
    executeWorkflow: vi.fn(async () => result),
  };
}

async function loadWorkflowHandler() {
  vi.resetModules();
  return import('../handler.js');
}

describe('workflow handler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('validates schema and returns a LaunchDecision', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect -> resolver',
        start_prompt: 'hello',
      },
      executionSvc,
      ctx,
    );

    expect(decision).toEqual({ status: 'running', job: 'job-1', session: 'session-1' });
    expect(executionSvc.executeWorkflow).toHaveBeenCalledWith(
      'claude',
      [
        [{ kind: 'agent', namespace: 'coral', agent: 'architect', provider: 'claude' }],
        [{ kind: 'agent', namespace: 'coral', agent: 'resolver', provider: 'claude' }],
      ],
      expect.objectContaining({
        expression: 'architect -> resolver',
        start_prompt: 'hello',
        provider: 'claude',
      }),
      ctx,
      undefined,
    );
  });

  it('passes work_dir separately without mutating projectRoot', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    await handleWorkflow(
      {
        expression: 'architect',
        start_prompt: 'hello',
        work_dir: '/tmp/coral-workflow-cwd',
      },
      executionSvc,
      ctx,
    );

    expect(executionSvc.executeWorkflow).toHaveBeenCalledWith(
      'claude',
      [[{ kind: 'agent', namespace: 'coral', agent: 'architect', provider: 'claude' }]],
      expect.objectContaining({
        expression: 'architect',
        start_prompt: 'hello',
        work_dir: '/tmp/coral-workflow-cwd',
        provider: 'claude',
      }),
      ctx,
      '/tmp/coral-workflow-cwd',
    );
    expect(ctx.projectRoot).toBe('/tmp/coral-workflow-project');
  });

  it('returns a rejected LaunchDecision when a provider is unknown', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect@missing-provider',
        start_prompt: 'hello',
        provider: 'codex',
      },
      executionSvc,
      ctx,
    );

    expect(decision).toEqual({
      status: 'rejected',
      phase: 'preflight',
      code: 'unknown_provider',
      message: 'Unknown provider: missing-provider',
    });
    expect(executionSvc.executeWorkflow).not.toHaveBeenCalled();
  });

  it('throws on schema validation failures', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    await expect(handleWorkflow({ expression: 'architect' }, executionSvc, ctx)).rejects.toThrow();
  });

  it('rejected LaunchDecision has no job or session properties', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect@nonexistent-provider',
        start_prompt: 'test',
        provider: 'codex',
      },
      executionSvc,
      ctx,
    );

    expect(decision.status).toBe('rejected');
    expect(decision).not.toHaveProperty('job');
    expect(decision).not.toHaveProperty('session');
    expect(executionSvc.executeWorkflow).not.toHaveBeenCalled();
  });

  it('throws when duplicate agent names appear in the same parallel step', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    await expect(
      handleWorkflow(
        {
          expression: '(architect, architect)',
          start_prompt: 'test',
          provider: 'claude',
        },
        executionSvc,
        ctx,
      ),
    ).rejects.toThrow('Duplicate atom');

    expect(executionSvc.executeWorkflow).not.toHaveBeenCalled();
  });

  it('throws on missing expression field', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    await expect(handleWorkflow({ start_prompt: 'no expression' }, executionSvc, ctx)).rejects.toThrow();
  });

  it('rejected message names multiple unknown providers', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect@ghost1 -> resolver@ghost2',
        start_prompt: 'test',
        provider: 'codex',
      },
      executionSvc,
      ctx,
    );

    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') throw new Error('expected rejected');
    expect(decision.message).toContain('ghost1');
    expect(decision.message).toContain('ghost2');
  });
});
