import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../../providers/registry.js';
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

function createProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const name of ['claude', 'codex']) {
    registry.register({
      name,
      execute: async () => ({ content: `${name} response`, outcome: { kind: 'completed' } }),
    });
  }
  return registry;
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
    const providerRegistry = createProviderRegistry();

    const decision = await handleWorkflow(
      {
        expression: 'architect -> resolver',
        startPrompt: 'hello',
      },
      executionSvc,
      ctx,
      providerRegistry,
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
        startPrompt: 'hello',
        provider: 'claude',
      }),
      ctx,
      undefined,
    );
  });

  it('passes workDir separately without mutating projectRoot', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();
    const providerRegistry = createProviderRegistry();

    await handleWorkflow(
      {
        expression: 'architect',
        startPrompt: 'hello',
        workDir: '/tmp/coral-workflow-cwd',
      },
      executionSvc,
      ctx,
      providerRegistry,
    );

    expect(executionSvc.executeWorkflow).toHaveBeenCalledWith(
      'claude',
      [[{ kind: 'agent', namespace: 'coral', agent: 'architect', provider: 'claude' }]],
      expect.objectContaining({
        expression: 'architect',
        startPrompt: 'hello',
        workDir: '/tmp/coral-workflow-cwd',
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
    const providerRegistry = createProviderRegistry();

    const decision = await handleWorkflow(
      {
        expression: 'architect@missing-provider',
        startPrompt: 'hello',
        provider: 'codex',
      },
      executionSvc,
      ctx,
      providerRegistry,
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
    const providerRegistry = createProviderRegistry();

    await expect(handleWorkflow({ expression: 'architect' }, executionSvc, ctx, providerRegistry)).rejects.toThrow();
  });

  it('rejected LaunchDecision has no job or session properties', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();
    const providerRegistry = createProviderRegistry();

    const decision = await handleWorkflow(
      {
        expression: 'architect@nonexistent-provider',
        startPrompt: 'test',
        provider: 'codex',
      },
      executionSvc,
      ctx,
      providerRegistry,
    );

    expect(decision.status).toBe('rejected');
    expect(decision).not.toHaveProperty('job');
    expect(decision).not.toHaveProperty('session');
    expect(executionSvc.executeWorkflow).not.toHaveBeenCalled();
  });

  it('throws when duplicate agent names appear in the same parallel step', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();
    const providerRegistry = createProviderRegistry();

    await expect(
      handleWorkflow(
        {
          expression: '(architect, architect)',
          startPrompt: 'test',
          provider: 'claude',
        },
        executionSvc,
        ctx,
        providerRegistry,
      ),
    ).rejects.toThrow('Duplicate atom');

    expect(executionSvc.executeWorkflow).not.toHaveBeenCalled();
  });

  it('throws on missing expression field', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();
    const providerRegistry = createProviderRegistry();

    await expect(handleWorkflow({ startPrompt: 'no expression' }, executionSvc, ctx, providerRegistry)).rejects.toThrow();
  });

  it('rejected message names multiple unknown providers', async () => {
    const { handleWorkflow } = await loadWorkflowHandler();
    const executionSvc = createExecutionService();
    const providerRegistry = createProviderRegistry();

    const decision = await handleWorkflow(
      {
        expression: 'architect@ghost1 -> resolver@ghost2',
        startPrompt: 'test',
        provider: 'codex',
      },
      executionSvc,
      ctx,
      providerRegistry,
    );

    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') throw new Error('expected rejected');
    expect(decision.message).toContain('ghost1');
    expect(decision.message).toContain('ghost2');
  });
});
