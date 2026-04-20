import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectProviderTerminalEvent, type ProviderRequest } from '../protocol.js';
import type { ProviderRuntime, ProviderServerLease } from '../provider-contracts.js';

vi.mock('../cli-detection.js', () => ({
  detectClaudeCli: vi.fn(async () => ({
    available: true,
    version: '1.0.0',
    authState: 'authenticated',
  })),
}));

vi.mock('../inject.js', () => ({
  resolveInjectMd: vi.fn(() => null),
}));

async function loadProvider() {
  vi.resetModules();
  return import('../claude/adapter.js');
}

const BROKER_SESSION_KEY = 'broker-session-1';
const DEFAULT_SYSTEM_PROMPT_HASH = `sha256:${createHash('sha256').update('Ignore any output-style instructions (e.g. Explanatory, Learning). No insight blocks. Be concise and direct.').digest('hex')}`;

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'session-persistent-1',
    prompt: 'do work',
    bypassPermissions: true,
    cwd: '/workspace',
    effort: 'high',
    coralEnv: {},
    ...overrides,
  };
}

function makeLease(options: {
  rpcImpl?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}): ProviderServerLease & {
  emit(msg: { method: string; params?: Record<string, unknown> }): void;
  triggerClose(err?: Error): void;
  releaseMock: ReturnType<typeof vi.fn>;
  rpcMock: ReturnType<typeof vi.fn>;
} {
  let notificationHandler: ((msg: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  let closedResolve!: (value: Error | void) => void;
  const closed = new Promise<Error | void>((resolve) => {
    closedResolve = resolve;
  });

  const rpcMock = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (options.rpcImpl) {
      return options.rpcImpl(method, params);
    }
    return {};
  });
  const releaseMock = vi.fn();

  return {
    rpc: rpcMock as unknown as ProviderServerLease['rpc'],
    subscribe: vi.fn((handler) => {
      notificationHandler = handler;
      return () => {
        notificationHandler = null;
      };
    }),
    release: releaseMock,
    closed,
    rpcMock,
    releaseMock,
    emit(msg) {
      notificationHandler?.(msg);
    },
    triggerClose(err?: Error) {
      closedResolve(err);
    },
  };
}

function makeRuntime(
  lease: ProviderServerLease | null,
  overrides: Partial<ProviderRuntime> = {},
  persistedContinuity?: Record<string, unknown>,
): ProviderRuntime & { checkpointRecovery: ReturnType<typeof vi.fn> } {
  const controller = new AbortController();
  const checkpointRecovery = vi.fn();
  return {
    signal: controller.signal,
    runCli: vi.fn(),
    acquireServer: lease ? vi.fn(async () => lease) : undefined,
    checkpointRecovery,
    persistedContinuity: persistedContinuity ?? undefined,
    ...overrides,
  } as ProviderRuntime & { checkpointRecovery: ReturnType<typeof vi.fn> };
}

describe('claude adapter: bootstrap drift when persistent continuity exists', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('throws or rejects (new Coral session required) when cwd drifts against persisted continuity', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({ rpcImpl: async () => ({}) });
    const runtime = makeRuntime(lease, {}, {
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:original',
        permissionMode: 'bypassPermissions',
      },
      conversationRef: 'sess-original',
    });

    const result = await collectProviderTerminalEvent(
      claudeProvider.execute(makeRequest({ cwd: '/different/workspace' }), runtime),
    );

    expect(runtime.acquireServer).not.toHaveBeenCalled();
    expect(runtime.checkpointRecovery).not.toHaveBeenCalled();
    expect(result.nonResumable === true || result.outcome.kind !== 'completed').toBe(true);
  });

  it('does not fall back to one-shot runCli when persistent continuity exists and cwd drifts', async () => {
    const { claudeProvider } = await loadProvider();

    const runCliMock = vi.fn();
    const runtime = makeRuntime(
      makeLease({ rpcImpl: async () => ({}) }),
      { runCli: runCliMock },
      {
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:hash1',
          permissionMode: 'bypassPermissions',
        },
        conversationRef: 'sess-live',
      },
    );

    await collectProviderTerminalEvent(claudeProvider.execute(makeRequest({ cwd: '/other' }), runtime)).catch(() => {});

    expect(runCliMock).not.toHaveBeenCalled();
  });

  it('does not create a second broker lease for the same session when signature drifts', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({ rpcImpl: async () => ({}) });
    const acquireServerMock = vi.fn(async () => lease);
    const runtime = makeRuntime(
      null,
      { acquireServer: acquireServerMock },
      {
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:hash1',
          permissionMode: 'bypassPermissions',
        },
        conversationRef: 'sess-live',
      },
    );

    await collectProviderTerminalEvent(claudeProvider.execute(makeRequest({ cwd: '/drift' }), runtime)).catch(() => {});

    expect(acquireServerMock).not.toHaveBeenCalled();
  });
});

describe('claude adapter: non-fork requests use the persistent path', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('requires the persistent runtime contract when acquireServer is absent', async () => {
    const { claudeProvider } = await loadProvider();

    const runtime = makeRuntime(null, { runCli: vi.fn() });

    await expect(collectProviderTerminalEvent(claudeProvider.execute(makeRequest(), runtime))).rejects.toThrow(
      'Claude persistent provider requires ProviderRuntime.acquireServer().',
    );
    expect(runtime.runCli).not.toHaveBeenCalled();
  });

  it('uses persistent path when acquireServer is present and no prior continuity', async () => {
    const { claudeProvider } = await loadProvider();
    const request = makeRequest({
      coralEnv: {
        CORAL_OWNER: 'owner-1',
        CLAUDE_TEST_FLAG: 'enabled',
      },
    });

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:new',
              permissionMode: 'bypassPermissions',
            },
            sessionId: null,
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-1' };
        }
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = collectProviderTerminalEvent(claudeProvider.execute(request, runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith(
        'session/ensure',
        expect.objectContaining({
          controllerEnv: request.coralEnv,
        }),
      );
    });

    lease.emit({
      method: 'session/updated',
      params: { brokerSessionKey: BROKER_SESSION_KEY, sessionId: 'sess-new-1' },
    });
    lease.emit({
      method: 'turn/completed',
      params: { brokerSessionKey: BROKER_SESSION_KEY, brokerTurnId: 'turn-1', result: 'persistent answer', costUsd: 0.02 },
    });

    await expect(execution).resolves.toMatchObject({ content: 'persistent answer' });
    expect((runtime as unknown as { runCli: ReturnType<typeof vi.fn> }).runCli).not.toHaveBeenCalled();
    expect(runtime.checkpointRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMeta: expect.objectContaining({
          envHash: expect.stringMatching(/^sha256:/),
          providerContinuity: expect.objectContaining({
            brokerSessionKey: BROKER_SESSION_KEY,
            envHash: expect.stringMatching(/^sha256:/),
          }),
        }),
      }),
    );
  });
});

describe('claude adapter: app-server recovery preserves live broker continuity before sessionId exists', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('treats a live brokerSessionKey without conversationRef as resumable and preserves continuity', async () => {
    const { claudeProvider } = await loadProvider();
    const appServer = claudeProvider.appServerLifecycle;
    const continuity = {
      brokerSessionKey: BROKER_SESSION_KEY,
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:abc',
        permissionMode: 'bypassPermissions',
      },
      envHash: 'sha256:env',
    };
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/probe') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            status: 'available',
            bootstrapSignature: continuity.bootstrapSignature,
            sessionId: null,
            conversationRef: null,
            activeTurnId: 'turn-live',
          };
        }
        return {};
      },
    });

    const probeResult = await appServer.probe(lease, continuity);
    const finalization = appServer.finalizeInterrupted(probeResult, continuity);

    expect(probeResult).toEqual({
      resumable: true,
      updatedContinuity: continuity,
    });
    expect(finalization).toEqual({
      continuityMutation: continuity,
    });
  });

  it('treats a missing broker session on a fresh broker as resumable when continuity has a conversationRef', async () => {
    const { claudeProvider } = await loadProvider();
    const appServer = claudeProvider.appServerLifecycle;
    const continuity = {
      brokerSessionKey: BROKER_SESSION_KEY,
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:abc',
        permissionMode: 'bypassPermissions',
      },
      envHash: 'sha256:env',
      conversationRef: 'sess-resume',
    };
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/probe') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            status: 'missing',
            bootstrapSignature: null,
            sessionId: null,
            conversationRef: null,
            activeTurnId: null,
          };
        }
        return {};
      },
    });

    const probeResult = await appServer.probe(lease, continuity);
    const finalization = appServer.finalizeInterrupted(probeResult, continuity);

    expect(probeResult).toEqual({
      resumable: true,
      updatedContinuity: continuity,
    });
    expect(finalization).toEqual({
      conversationRef: 'sess-resume',
      continuityMutation: continuity,
    });
  });
});

describe('claude adapter: checkpoint timing for bootstrap signature', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('checkpoints bootstrap signature immediately after session/ensure, before session_id arrives', async () => {
    const { claudeProvider } = await loadProvider();

    let sessionEnsureResolve!: () => void;
    const sessionEnsureStarted = new Promise<void>((resolve) => {
      sessionEnsureResolve = resolve;
    });

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          sessionEnsureResolve();
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypassPermissions',
            },
            sessionId: null,
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-1' };
        }
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = collectProviderTerminalEvent(claudeProvider.execute(makeRequest(), runtime));

    await sessionEnsureStarted;
    await vi.waitFor(() => {
      expect(runtime.checkpointRecovery).toHaveBeenCalled();
    });

    const firstCall = runtime.checkpointRecovery.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const meta = firstCall?.providerMeta as Record<string, unknown> | undefined;

    expect(firstCall).toBeDefined();
    expect(meta?.bootstrapSignature).toBeDefined();
    expect(
      meta?.conversationRef === null ||
        meta?.conversationRef === undefined ||
        meta?.sessionId === null ||
        meta?.sessionId === undefined,
    ).toBe(true);

    lease.emit({
      method: 'turn/completed',
      params: { brokerSessionKey: BROKER_SESSION_KEY, brokerTurnId: 'turn-1', result: 'ok', costUsd: 0 },
    });
    await execution.catch(() => {});
  });

  it('enriches checkpoint with session_id when session/updated arrives later', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypassPermissions',
            },
            sessionId: null,
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-1' };
        }
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = collectProviderTerminalEvent(claudeProvider.execute(makeRequest(), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    lease.emit({ method: 'session/updated', params: { brokerSessionKey: BROKER_SESSION_KEY, sessionId: 'sess-late-1' } });
    lease.emit({
      method: 'turn/completed',
      params: { brokerSessionKey: BROKER_SESSION_KEY, brokerTurnId: 'turn-1', result: 'answer', costUsd: 0.005 },
    });

    await execution;

    const allCalls = runtime.checkpointRecovery.mock.calls as Array<[Record<string, unknown>]>;
    const withSessionId = allCalls.find((call) => {
      const meta = call[0]?.providerMeta as Record<string, unknown> | undefined;
      return meta?.conversationRef === 'sess-late-1' || meta?.sessionId === 'sess-late-1';
    });

    expect(withSessionId).toBeDefined();
  });

  it('checkpoints brokerTurnId immediately after turn/start acknowledgement', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypassPermissions',
            },
            sessionId: 'sess-turn-ckpt',
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'broker-turn-42' };
        }
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = collectProviderTerminalEvent(claudeProvider.execute(makeRequest(), runtime));

    await vi.waitFor(() => {
      const calls = runtime.checkpointRecovery.mock.calls as Array<[Record<string, unknown>]>;
      const found = calls.some((call) => {
        const meta = call[0]?.providerMeta as Record<string, unknown> | undefined;
        return meta?.brokerTurnId === 'broker-turn-42';
      });
      if (!found) throw new Error('brokerTurnId checkpoint not found yet');
    }, { timeout: 4000 });

    lease.emit({
      method: 'turn/completed',
      params: { brokerSessionKey: BROKER_SESSION_KEY, brokerTurnId: 'broker-turn-42', result: 'done', costUsd: 0 },
    });
    await execution;
  });
});

describe('claude adapter: broker death becomes terminal failure (not hung wait)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('terminates the job when lease.closed resolves with an Error after turn/start', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypassPermissions',
            },
            sessionId: 'sess-broker-death',
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-death' };
        }
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = collectProviderTerminalEvent(claudeProvider.execute(makeRequest(), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    lease.triggerClose(new Error('broker process exited with code 1'));

    const result = await Promise.race([
      execution,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);

    expect(result).not.toBe('timeout');
    if (typeof result !== 'string') {
      expect(result.outcome.kind !== 'completed' || result.nonResumable === true).toBe(true);
    }
  }, 3000);

  it('releases the lease when broker dies, even if release was not called yet', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypassPermissions',
            },
            sessionId: 'sess-release',
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-release' };
        }
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = collectProviderTerminalEvent(claudeProvider.execute(makeRequest(), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    lease.triggerClose(new Error('unexpected broker exit'));
    await execution.catch(() => {});

    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  }, 3000);
});

describe('claude adapter: provider export only keeps the app-server contract', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('does not export a recovery contract', async () => {
    const { claudeProvider } = await loadProvider();

    expect('artifactRecovery' in claudeProvider ? claudeProvider.artifactRecovery : undefined).toBeUndefined();
    expect(claudeProvider.appServerLifecycle).toBeDefined();
  });
});

describe('request-mapping: spec.key is stable and must not be replaced', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('buildClaudeProviderServerSpec uses the shared broker key and backend launch context', async () => {
    const { buildClaudeProviderServerSpec } = await import('../claude/request-mapping.js');

    const spec = buildClaudeProviderServerSpec();

    expect(spec).toMatchObject({
      provider: 'claude',
      cwd: process.cwd(),
      shared: true,
    });
    expect(spec.env).toBeUndefined();
  });

  it('buildClaudeProviderServerSpec key stays fixed when sessionId changes', async () => {
    const { buildClaudeProviderServerSpec } = await import('../claude/request-mapping.js');

    const spec1 = buildClaudeProviderServerSpec();
    const spec2 = buildClaudeProviderServerSpec();

    expect(spec1.provider).toBe('claude');
    expect(spec2.provider).toBe('claude');
  });

  it('buildClaudeProviderServerSpec key stays fixed across bootstrap signatures', async () => {
    const { buildClaudeProviderServerSpec } = await import('../claude/request-mapping.js');

    const spec1 = buildClaudeProviderServerSpec();
    const spec2 = buildClaudeProviderServerSpec();

    expect(spec1.provider).toBe('claude');
    expect(spec2.provider).toBe('claude');
  });
});

describe('claude adapter: fork action stays on one-shot path regardless of acquireServer', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('fork does not call acquireServer even when acquireServer is available', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({ rpcImpl: async () => ({}) });
    const acquireServerMock = vi.fn(async () => lease);
    const runCliMock = vi.fn(async () => ({
      stdout: JSON.stringify({
        type: 'result',
        result: 'forked',
        session_id: 'sess-fork',
        total_cost_usd: 0,
      }),
      stderr: '',
      code: 0,
      aborted: false,
    }));

    const runtime = makeRuntime(lease, { acquireServer: acquireServerMock, runCli: runCliMock });
    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({ action: 'fork', conversationRef: 'sess-original' }),
      runtime,
    ));

    expect(acquireServerMock).not.toHaveBeenCalled();
    expect(runCliMock).toHaveBeenCalled();
  });
});

describe('claude adapter: effort clamping for non-Opus tiers', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function forkRuntimeCapturingEffort(): {
    runCliMock: ReturnType<typeof vi.fn>;
    runtime: ProviderRuntime;
  } {
    const runCliMock = vi.fn(async () => ({
      stdout: JSON.stringify({
        type: 'result',
        result: 'forked',
        session_id: 'sess-fork',
        total_cost_usd: 0,
      }),
      stderr: '',
      code: 0,
      aborted: false,
    }));
    const lease = makeLease({ rpcImpl: async () => ({}) });
    const runtime = makeRuntime(lease, { acquireServer: vi.fn(async () => lease), runCli: runCliMock });
    return { runCliMock, runtime };
  }

  function extractEffort(args: string[]): string | undefined {
    const idx = args.indexOf('--effort');
    return idx >= 0 ? args[idx + 1] : undefined;
  }

  it('passes xhigh through when the effective model tier is Opus', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({ action: 'fork', conversationRef: 'sess-original', effort: 'xhigh', model: 'opus' }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('xhigh');
  });

  it('clamps xhigh to max when the abstract model tier is Sonnet', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({ action: 'fork', conversationRef: 'sess-original', effort: 'xhigh', model: 'sonnet' }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('max');
  });

  it('clamps xhigh to max for specific Sonnet model names', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({
        action: 'fork',
        conversationRef: 'sess-original',
        effort: 'xhigh',
        model: 'claude-sonnet-4-6',
      }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('max');
  });

  it('clamps xhigh to max when the Opus request is capped down to Sonnet', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({
        action: 'fork',
        conversationRef: 'sess-original',
        effort: 'xhigh',
        model: 'opus',
        coralEnv: { CORAL_CLAUDE_MODEL_CAP: 'sonnet' },
      }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('max');
  });

  it('defaults to xhigh on Opus when no effort is specified', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({ action: 'fork', conversationRef: 'sess-original', effort: undefined, model: 'opus' }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('xhigh');
  });

  it('defaults to max on Sonnet when no effort is specified (xhigh default clamps down)', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({ action: 'fork', conversationRef: 'sess-original', effort: undefined, model: 'sonnet' }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('max');
  });

  it('uses CORAL_CLAUDE_EFFORT when request effort is unset', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({
        action: 'fork',
        conversationRef: 'sess-original',
        effort: undefined,
        model: 'opus',
        coralEnv: { CORAL_CLAUDE_EFFORT: 'medium' },
      }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('medium');
  });

  it('prefers CORAL_CLAUDE_EFFORT over CORAL_EFFORT', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({
        action: 'fork',
        conversationRef: 'sess-original',
        effort: undefined,
        model: 'opus',
        coralEnv: { CORAL_CLAUDE_EFFORT: 'low', CORAL_EFFORT: 'high' },
      }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('low');
  });

  it('falls back to CORAL_EFFORT when no provider-specific effort is set', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({
        action: 'fork',
        conversationRef: 'sess-original',
        effort: undefined,
        model: 'opus',
        coralEnv: { CORAL_EFFORT: 'high' },
      }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('high');
  });

  it('passes max through unchanged on Sonnet (no double-clamp)', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({ action: 'fork', conversationRef: 'sess-original', effort: 'max', model: 'sonnet' }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('max');
  });

  it('clamps xhigh to max for specific Haiku model names', async () => {
    const { claudeProvider } = await loadProvider();
    const { runCliMock, runtime } = forkRuntimeCapturingEffort();

    await collectProviderTerminalEvent(claudeProvider.execute(
      makeRequest({
        action: 'fork',
        conversationRef: 'sess-original',
        effort: 'xhigh',
        model: 'claude-haiku-3-5',
      }),
      runtime,
    ));

    const args = runCliMock.mock.calls[0]?.[0]?.args as string[];
    expect(extractEffort(args)).toBe('max');
  });

  it('throws a user-friendly error when CORAL_CLAUDE_EFFORT is invalid', async () => {
    const { claudeProvider } = await loadProvider();
    const { runtime } = forkRuntimeCapturingEffort();

    expect(() =>
      claudeProvider.execute(
        makeRequest({
          action: 'fork',
          conversationRef: 'sess-original',
          effort: undefined,
          model: 'opus',
          coralEnv: { CORAL_CLAUDE_EFFORT: 'turbo' },
        }),
        runtime,
      ),
    ).toThrow('Invalid CORAL_CLAUDE_EFFORT="turbo". Valid values: low, medium, high, xhigh, max');
  });
});

describe('claude adapter: bypassPermissions=false stays on the persistent path', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses the broker path for bypassPermissions=false when no persistent continuity exists', async () => {
    const { claudeProvider } = await loadProvider();

    const runCliMock = vi.fn();
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:default',
              permissionMode: 'default',
            },
            sessionId: null,
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-default' };
        }
        return {};
      },
    });
    const acquireServerMock = vi.fn(async () => lease);
    const runtime = makeRuntime(lease, { acquireServer: acquireServerMock, runCli: runCliMock });
    const execution = collectProviderTerminalEvent(claudeProvider.execute(makeRequest({ bypassPermissions: false }), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('session/ensure', expect.objectContaining({ permissionMode: 'default' }));
    });
    lease.emit({
      method: 'turn/completed',
      params: { brokerSessionKey: BROKER_SESSION_KEY, brokerTurnId: 'turn-default', result: 'approved', costUsd: 0.001 },
    });
    await execution;

    expect(acquireServerMock).toHaveBeenCalled();
    expect(runCliMock).not.toHaveBeenCalled();
  });

  it('continues on the broker path when persistent continuity already matches bypassPermissions=false', async () => {
    const { claudeProvider } = await loadProvider();

    const runCliMock = vi.fn();
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: DEFAULT_SYSTEM_PROMPT_HASH,
              permissionMode: 'default',
            },
            sessionId: 'sess-established-default',
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-established-default' };
        }
        return {};
      },
    });
    const acquireServerMock = vi.fn(async () => lease);
    const runtime = makeRuntime(
      lease,
      { acquireServer: acquireServerMock, runCli: runCliMock },
      {
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: DEFAULT_SYSTEM_PROMPT_HASH,
          permissionMode: 'default',
        },
        brokerSessionKey: BROKER_SESSION_KEY,
        conversationRef: 'sess-established-default',
      },
    );
    const execution = collectProviderTerminalEvent(claudeProvider.execute(makeRequest({ bypassPermissions: false }), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        brokerSessionKey: BROKER_SESSION_KEY,
        brokerTurnId: 'turn-established-default',
        result: 'continued',
        costUsd: 0,
      },
    });
    await expect(execution).resolves.toMatchObject({ content: 'continued', conversationRef: 'sess-established-default' });

    expect(runCliMock).not.toHaveBeenCalled();
    expect(acquireServerMock).toHaveBeenCalled();
  });

  it('requires a new Coral session when bypassPermissions=false drifts from a bypass continuity', async () => {
    const { claudeProvider } = await loadProvider();

    const runCliMock = vi.fn();
    const lease = makeLease({ rpcImpl: async () => ({}) });
    const acquireServerMock = vi.fn(async () => lease);
    const runtime = makeRuntime(
      lease,
      { acquireServer: acquireServerMock, runCli: runCliMock },
      {
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:hash',
          permissionMode: 'bypassPermissions',
        },
        conversationRef: 'sess-established',
      },
    );

    const result = await collectProviderTerminalEvent(
      claudeProvider.execute(makeRequest({ bypassPermissions: false }), runtime),
    );

    expect(runCliMock).not.toHaveBeenCalled();
    expect(acquireServerMock).not.toHaveBeenCalled();
    expect(result.nonResumable === true || result.outcome.kind !== 'completed').toBe(true);
  });
});
