import { afterEach, describe, expect, it, vi } from 'vitest';

import { streamProviderTerminal } from '#src/providers/stream.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { toProviderSpec } from '#tests/helpers/scripted-provider.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { WorkflowCommand } from '#src/workflow/input.js';
import { workflowCompiler } from '#src/workflow/compile.js';
import { workflowCommands } from '#src/workflow/dispatch.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

const ctx: InvocationContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
  coralEnv: {},
  principal: testProjectPrincipal('/tmp/coral-workflow-project'),
};

function createExecutionService(result = { status: 'running', job: 'job-1', session: 'session-1' } as const) {
  return {
    executeWorkflow: vi.fn(async () => result),
  };
}

function createProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const name of ['claude', 'codex']) {
    registry.register(
      toProviderSpec({
        name,
        execute: () => streamProviderTerminal({ content: `${name} response`, outcome: { kind: 'completed' } }),
      })!,
    );
  }
  return registry;
}

function compileOrThrow(command: WorkflowCommand, providerRegistry: ProviderRegistry) {
  const compiled = workflowCompiler.compile(command, providerRegistry);
  if ('status' in compiled) {
    throw new Error(`expected compiled workflow, got ${compiled.status}`);
  }
  return compiled;
}

describe('workflow api', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compiles schema-valid input and dispatches it through workflowCommands.execute', async () => {
    const executionSvc = createExecutionService();
    const providerRegistry = createProviderRegistry();

    const compiled = compileOrThrow(
      {
        expression: 'architect -> resolver',
        startPrompt: 'hello',
        provider: 'claude',
      },
      providerRegistry,
    );

    const decision = await workflowCommands.execute(executionSvc, compiled, ctx);

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
    const executionSvc = createExecutionService();
    const providerRegistry = createProviderRegistry();
    const compiled = compileOrThrow(
      {
        expression: 'architect',
        startPrompt: 'hello',
        workDir: '/tmp/coral-workflow-cwd',
        provider: 'claude',
      },
      providerRegistry,
    );

    await workflowCommands.execute(executionSvc, compiled, ctx);

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
    const providerRegistry = createProviderRegistry();

    const decision = workflowCompiler.compile(
      {
        expression: 'architect@missing-provider',
        startPrompt: 'hello',
        provider: 'codex',
      },
      providerRegistry,
    );

    expect(decision).toEqual({
      status: 'rejected',
      phase: 'preflight',
      code: 'unknown_provider',
      message: 'Unknown provider: missing-provider',
    });
  });

  it('throws when duplicate agent names appear in the same parallel step', async () => {
    const providerRegistry = createProviderRegistry();

    expect(() =>
      workflowCompiler.compile(
        {
          expression: '(architect, architect)',
          startPrompt: 'test',
          provider: 'claude',
        },
        providerRegistry,
      ),
    ).toThrow('Duplicate atom');
  });

  it('applies owner into the execution context when provided', async () => {
    const executionSvc = createExecutionService();
    const providerRegistry = createProviderRegistry();
    const compiled = compileOrThrow(
      {
        expression: 'architect',
        startPrompt: 'hello',
        provider: 'claude',
        owner: 'team-owner',
      },
      providerRegistry,
    );

    await workflowCommands.execute(executionSvc, compiled, ctx);

    expect(executionSvc.executeWorkflow).toHaveBeenCalledWith(
      'claude',
      [[{ kind: 'agent', namespace: 'coral', agent: 'architect', provider: 'claude' }]],
      expect.objectContaining({ owner: 'team-owner' }),
      {
        ...ctx,
        coralEnv: { ...ctx.coralEnv, CORAL_OWNER: 'team-owner' },
      },
      undefined,
    );
  });
});
