import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetNewProvidersForTests } from '../../providers/registry.js';
import { _resetProviderBootstrapForTests } from '../../providers/bootstrap.js';
import type { ExecutionService, CallerContext } from '../../execution/service.js';
import { handleWorkflow } from '../handler.js';

const ctx: CallerContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
};

function createExecutionService(result = { status: 'running', job: 'job-1', session: 'session-1' } as const) {
  return {
    executeWorkflow: vi.fn(async () => result),
  } as unknown as ExecutionService;
}

describe('workflow handler', () => {
  beforeEach(() => {
    _resetNewProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  afterEach(() => {
    _resetNewProvidersForTests();
    _resetProviderBootstrapForTests();
    vi.restoreAllMocks();
  });

  it('validates schema and returns a LaunchDecision', async () => {
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect -> resolver',
        prompt: 'hello',
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
        prompt: 'hello',
        provider: 'claude',
      }),
      ctx,
    );
  });

  it('returns a rejected LaunchDecision when a provider is unknown', async () => {
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect@missing-provider',
        prompt: 'hello',
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
    const executionSvc = createExecutionService();

    await expect(handleWorkflow(
      { expression: 'architect' },
      executionSvc,
      ctx,
    )).rejects.toThrow();
  });

  it('rejected LaunchDecision has no job or session properties', async () => {
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect@nonexistent-provider',
        prompt: 'test',
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
    const executionSvc = createExecutionService();

    await expect(handleWorkflow(
      {
        expression: '(architect, architect)',
        prompt: 'test',
        provider: 'claude',
      },
      executionSvc,
      ctx,
    )).rejects.toThrow('Duplicate atom');

    expect(executionSvc.executeWorkflow).not.toHaveBeenCalled();
  });

  it('throws when atoms keys reference agent names not present in the AST', async () => {
    const executionSvc = createExecutionService();

    await expect(handleWorkflow(
      {
        expression: 'architect',
        prompt: 'test',
        provider: 'claude',
        atoms: { 'ghost-agent': { effort: 'low' } },
      },
      executionSvc,
      ctx,
    )).rejects.toThrow('Unknown atoms keys: ghost-agent');

    expect(executionSvc.executeWorkflow).not.toHaveBeenCalled();
  });

  it('throws on missing expression field', async () => {
    const executionSvc = createExecutionService();

    await expect(handleWorkflow(
      { prompt: 'no expression' },
      executionSvc,
      ctx,
    )).rejects.toThrow();
  });

  it('rejected message names multiple unknown providers', async () => {
    const executionSvc = createExecutionService();

    const decision = await handleWorkflow(
      {
        expression: 'architect@ghost1 -> resolver@ghost2',
        prompt: 'test',
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
