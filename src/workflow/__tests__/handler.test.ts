import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallerContext } from '../../execution/service.js';

const ctx: CallerContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
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
        init_prompt: 'hello',
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
        init_prompt: 'hello',
        provider: 'claude',
      }),
      ctx,
    );
  });

  it('returns a rejected LaunchDecision when a provider is unknown', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect@missing-provider',
        init_prompt: 'hello',
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

    await expect(handleWorkflow(
      { expression: 'architect' },
      executionSvc,
      ctx,
    )).rejects.toThrow();
  });

  it('rejected LaunchDecision has no job or session properties', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect@nonexistent-provider',
        init_prompt: 'test',
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

    await expect(handleWorkflow(
      {
        expression: '(architect, architect)',
        init_prompt: 'test',
        provider: 'claude',
      },
      executionSvc,
      ctx,
    )).rejects.toThrow('Duplicate atom');

    expect(executionSvc.executeWorkflow).not.toHaveBeenCalled();
  });

  it('throws when atoms keys reference agent names not present in the AST', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    await expect(handleWorkflow(
      {
        expression: 'architect',
        init_prompt: 'test',
        provider: 'claude',
        atoms: { 'ghost-agent': { instruction: 'focus' } },
      },
      executionSvc,
      ctx,
    )).rejects.toThrow('Unknown atoms keys: ghost-agent');

    expect(executionSvc.executeWorkflow).not.toHaveBeenCalled();
  });

  it('throws on missing expression field', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    await expect(handleWorkflow(
      { init_prompt: 'no expression' },
      executionSvc,
      ctx,
    )).rejects.toThrow();
  });

  it('rejected message names multiple unknown providers', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect@ghost1 -> resolver@ghost2',
        init_prompt: 'test',
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
