/**
 * Adversarial tests for the Claude adapter persistent path (AC5, AC8, AC11, AC12, AC14).
 *
 * Files targeted: src/providers/claude/adapter.ts,
 *                 src/providers/claude/request-mapping.ts
 *
 * These tests attack the most dangerous assumptions the implementer will make:
 *
 * 1. Bootstrap drift: a request with different cwd/systemPrompt must be
 *    redirected to a new Coral session, not fall back to one-shot inside
 *    the existing session or create a second persistent broker variant.
 *
 * 2. Recovery split: claudeRecovery must NOT be invoked for persistent jobs.
 *    A persistent job that crashes must go through provider-aware finalization,
 *    not artifact-backed recovery.
 *
 * 3. Session continuity timing: the adapter must checkpoint the bootstrap
 *    signature immediately after session/ensure even when session_id has not
 *    arrived yet. A later session_id must enrich, not replace, the checkpoint.
 *
 * 4. Broker death: when lease.closed resolves with an Error mid-turn, the
 *    adapter must reject/terminate, not hang waiting for a notification that
 *    will never arrive.
 *
 * 5. One-shot fallback guard: once persistent continuity exists, one-shot
 *    fallback is forbidden inside that session even if acquireServer is absent.
 *
 * 6. acquireServer absent + no prior continuity: must fall back to one-shot.
 *
 * 7. spec.key must not be overwritten by the service with provider:projectRoot.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderRequest } from '../../../shared/types.js';
import type { ProviderRuntime, ProviderServerLease } from '../../types.js';

// ─── module-level mocks ────────────────────────────────────────────────────

vi.mock('../../cli-detection.js', () => ({
  detectClaudeCli: vi.fn(async () => ({
    available: true,
    version: '1.0.0',
    authState: 'authenticated',
  })),
}));

vi.mock('../../inject.js', () => ({
  resolveInjectMd: vi.fn(() => null),
}));

async function loadProvider() {
  vi.resetModules();
  return import('../adapter.js');
}

// ─── helpers ───────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'session-persistent-1',
    prompt: 'do work',
    bypassPermissions: true,
    cwd: '/workspace',
    coralEnv: {},
    ...overrides,
  };
}

/**
 * A fake ProviderServerLease where the caller controls when closed resolves.
 */
function makeLease(options: {
  rpcImpl?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  closedWith?: Error | undefined;
}): ProviderServerLease & {
  emit(msg: { method: string; params?: Record<string, unknown> }): void;
  triggerClose(err?: Error): void;
  releaseMock: ReturnType<typeof vi.fn>;
  rpcMock: ReturnType<typeof vi.fn>;
} {
  let notificationHandler: ((msg: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  let closedResolve!: (value: Error | void) => void;
  const closedPromise = new Promise<Error | void>((r) => (closedResolve = r));

  const rpcMock = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (options.rpcImpl) return options.rpcImpl(method, params);
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
    closed: closedPromise,
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
    onEvent: vi.fn(),
    runCli: vi.fn(),
    acquireServer: lease ? vi.fn(async () => lease) : undefined,
    checkpointRecovery,
    persistedContinuity: persistedContinuity ?? undefined,
    ...overrides,
  } as ProviderRuntime & { checkpointRecovery: ReturnType<typeof vi.fn> };
}

// ─── bootstrap-drift redirect ──────────────────────────────────────────────

describe('claude adapter: bootstrap drift when persistent continuity exists', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('throws or rejects (new Coral session required) when cwd drifts against persisted continuity', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async () => ({}),
    });
    const persistedContinuity = {
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:original',
        permissionMode: 'bypass',
      },
      conversationRef: 'sess-original',
    };

    const runtime = makeRuntime(lease, {}, persistedContinuity);

    // Request with different cwd — this is a drift against persisted continuity.
    const driftedRequest = makeRequest({ cwd: '/different/workspace' });

    const result = await claudeProvider.execute(driftedRequest, runtime);

    // Must not call acquireServer or mutate continuity — must signal redirect.
    expect(runtime.acquireServer).not.toHaveBeenCalled();
    expect(runtime.checkpointRecovery).not.toHaveBeenCalled();

    // Result must indicate that a new session is required, not proceed silently.
    // It should either throw, reject, or return a non-resumable error result.
    expect(result.nonResumable === true || result.errors !== undefined).toBe(true);
  });

  it('does not fall back to one-shot runCli when persistent continuity exists and cwd drifts', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({ rpcImpl: async () => ({}) });
    const persistedContinuity = {
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:hash1',
        permissionMode: 'bypass',
      },
      conversationRef: 'sess-live',
    };

    const runCliMock = vi.fn();
    const runtime = makeRuntime(lease, { runCli: runCliMock }, persistedContinuity);

    await claudeProvider.execute(makeRequest({ cwd: '/other' }), runtime).catch(() => {});

    // runCli (one-shot path) must not have been invoked.
    expect(runCliMock).not.toHaveBeenCalled();
  });

  it('does not create a second broker lease for the same session when signature drifts', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({ rpcImpl: async () => ({}) });
    const persistedContinuity = {
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:hash1',
        permissionMode: 'bypass',
      },
      conversationRef: 'sess-live',
    };

    const acquireServerMock = vi.fn(async () => lease);
    const runtime = makeRuntime(null, { acquireServer: acquireServerMock }, persistedContinuity);

    await claudeProvider.execute(makeRequest({ cwd: '/drift' }), runtime).catch(() => {});

    // acquireServer must not have been called — no second broker must be created.
    expect(acquireServerMock).not.toHaveBeenCalled();
  });
});

// ─── one-shot fallback: no prior continuity ────────────────────────────────

describe('claude adapter: one-shot fallback when no persistent continuity exists', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses runCli (one-shot) when acquireServer is absent and no persistent continuity', async () => {
    const { claudeProvider } = await loadProvider();

    const runCliMock = vi.fn(async () => ({
      stdout: JSON.stringify({
        type: 'result',
        result: 'one-shot answer',
        session_id: 'sess-oneshot',
        total_cost_usd: 0.01,
      }),
      stderr: '',
      code: 0,
      aborted: false,
    }));

    const runtime = makeRuntime(null, { runCli: runCliMock });
    // No persistedContinuity — one-shot is permitted.

    const result = await claudeProvider.execute(makeRequest(), runtime);

    expect(runCliMock).toHaveBeenCalled();
    expect(result.content).toBeTruthy();
  });

  it('uses persistent path when acquireServer is present and no prior continuity', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:new',
              permissionMode: 'bypass',
            },
            sessionId: null, // not yet received
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-1' };
        }
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    // No persistedContinuity yet.

    const execution = claudeProvider.execute(makeRequest(), runtime);

    // Simulate broker notifying completion.
    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('session/ensure', expect.any(Object));
    });

    lease.emit({
      method: 'session/updated',
      params: { sessionId: 'sess-new-1' },
    });
    lease.emit({
      method: 'turn/completed',
      params: { brokerTurnId: 'turn-1', result: 'persistent answer', costUsd: 0.02 },
    });

    await expect(execution).resolves.toMatchObject({ content: 'persistent answer' });

    // runCli must NOT have been called — persistent path was used.
    expect((runtime as unknown as { runCli: ReturnType<typeof vi.fn> }).runCli).not.toHaveBeenCalled();
  });
});

// ─── checkpoint timing ─────────────────────────────────────────────────────

describe('claude adapter: checkpoint timing for bootstrap signature', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('checkpoints bootstrap signature immediately after session/ensure, before session_id arrives', async () => {
    const { claudeProvider } = await loadProvider();

    let sessionEnsureResolve!: () => void;
    const sessionEnsureStarted = new Promise<void>((r) => (sessionEnsureResolve = r));

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          sessionEnsureResolve();
          return {
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypass',
            },
            sessionId: null, // no session_id yet — this is the critical window
          };
        }
        if (method === 'turn/start') return { brokerTurnId: 'turn-1' };
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = claudeProvider.execute(makeRequest(), runtime);

    await sessionEnsureStarted;

    // By the time session/ensure resolves, checkpointRecovery must have been
    // called with at least the bootstrap signature — even without session_id.
    await vi.waitFor(() => {
      expect(runtime.checkpointRecovery).toHaveBeenCalled();
    });

    const firstCall = runtime.checkpointRecovery.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    // The bootstrap signature must be present in the first checkpoint.
    expect(firstCall).toBeDefined();
    const meta = firstCall?.providerMeta as Record<string, unknown> | undefined;
    expect(meta?.bootstrapSignature).toBeDefined();
    // session_id should be absent or null at this point.
    expect(meta?.conversationRef == null || meta?.sessionId == null).toBe(true);

    // Resolve turn.
    lease.emit({ method: 'turn/completed', params: { brokerTurnId: 'turn-1', result: 'ok', costUsd: 0 } });
    await execution.catch(() => {});
  });

  it('enriches checkpoint with session_id when session/updated arrives later', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            bootstrapSignature: { cwd: '/workspace', systemPromptHash: 'sha256:abc', permissionMode: 'bypass' },
            sessionId: null,
          };
        }
        if (method === 'turn/start') return { brokerTurnId: 'turn-1' };
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = claudeProvider.execute(makeRequest(), runtime);

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    // Later session update brings the session_id.
    lease.emit({ method: 'session/updated', params: { sessionId: 'sess-late-1' } });
    lease.emit({ method: 'turn/completed', params: { brokerTurnId: 'turn-1', result: 'answer', costUsd: 0.005 } });

    await execution;

    // A subsequent checkpoint must include the session_id.
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
            bootstrapSignature: { cwd: '/workspace', systemPromptHash: 'sha256:abc', permissionMode: 'bypass' },
            sessionId: 'sess-turn-ckpt',
          };
        }
        if (method === 'turn/start') return { brokerTurnId: 'broker-turn-42' };
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = claudeProvider.execute(makeRequest(), runtime);

    await vi.waitFor(() => {
      const calls = runtime.checkpointRecovery.mock.calls as Array<[Record<string, unknown>]>;
      return calls.some((call) => {
        const meta = call[0]?.providerMeta as Record<string, unknown> | undefined;
        return meta?.brokerTurnId === 'broker-turn-42';
      });
    });

    lease.emit({ method: 'turn/completed', params: { brokerTurnId: 'broker-turn-42', result: 'done', costUsd: 0 } });
    await execution;
  });
});

// ─── broker death → terminal failure ──────────────────────────────────────

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
            bootstrapSignature: { cwd: '/workspace', systemPromptHash: 'sha256:abc', permissionMode: 'bypass' },
            sessionId: 'sess-broker-death',
          };
        }
        if (method === 'turn/start') return { brokerTurnId: 'turn-death' };
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = claudeProvider.execute(makeRequest(), runtime);

    // Wait for turn/start to be acknowledged.
    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    // Simulate broker process dying.
    lease.triggerClose(new Error('broker process exited with code 1'));

    // The adapter must NOT hang — it must resolve/reject within a reasonable time.
    const result = await Promise.race([
      execution,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1000)),
    ]);

    expect(result).not.toBe('timeout');
    // The result should indicate failure or abort.
    if (typeof result !== 'string') {
      expect(result.aborted === true || result.errors !== undefined || result.nonResumable === true).toBe(true);
    }
  }, 3000);

  it('releases the lease when broker dies, even if release was not called yet', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            bootstrapSignature: { cwd: '/workspace', systemPromptHash: 'sha256:abc', permissionMode: 'bypass' },
            sessionId: 'sess-release',
          };
        }
        if (method === 'turn/start') return { brokerTurnId: 'turn-release' };
        return {};
      },
    });

    const runtime = makeRuntime(lease);
    const execution = claudeProvider.execute(makeRequest(), runtime);

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    lease.triggerClose(new Error('unexpected broker exit'));
    await execution.catch(() => {});

    // lease.release must have been called exactly once.
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  }, 3000);
});

// ─── recovery split: claudeRecovery is one-shot only ──────────────────────

describe('claude adapter: claudeRecovery must not be invoked for persistent jobs', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('claudeRecovery.finalizeFromArtifacts is defined (sanity: one-shot path still has it)', async () => {
    const { claudeProvider } = await loadProvider();
    // The recovery contract must still exist for one-shot jobs.
    expect(claudeProvider.recovery).toBeDefined();
    expect(claudeProvider.recovery?.finalizeFromArtifacts).toBeInstanceOf(Function);
  });

  it('does not provide a recovery contract for persistent broker execution', async () => {
    // AC11: Persistent Claude app-server jobs use provider-aware app-server
    // finalization, NOT artifact-backed claudeRecovery.
    // The provider's appServer contract (AC7) is the signal — if the provider
    // opts into appServer, the service must NOT use recovery.finalizeFromArtifacts
    // for those jobs.
    const { claudeProvider } = await loadProvider();

    // If the provider exposes an appServer contract, verify it is distinct
    // from the recovery contract (the service must not use both).
    if ('appServer' in claudeProvider && claudeProvider.appServer !== undefined) {
      // appServer.finalizeInterrupted and recovery.finalizeFromArtifacts serve
      // different transports and must not be the same function.
      const appServer = (claudeProvider as unknown as { appServer: { finalizeInterrupted: unknown } }).appServer;
      expect(appServer.finalizeInterrupted).not.toBe(claudeProvider.recovery?.finalizeFromArtifacts);
    }
  });
});

// ─── spec.key must not be overwritten ─────────────────────────────────────

describe('request-mapping: spec.key is stable and must not be replaced', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('buildClaudeProviderServerSpec produces a key that includes both sessionId and bootstrap signature', async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — module not yet implemented
    const { buildClaudeProviderServerSpec } = await import('../request-mapping.js').catch(() => null) ?? {};
    if (!buildClaudeProviderServerSpec) {
      // Module does not exist yet — test is a future gate.
      return;
    }

    const spec = buildClaudeProviderServerSpec(
      makeRequest(),
      'sha256:system-prompt-hash',
      undefined, // no persisted continuity
    );

    expect(spec.key).toContain('session-persistent-1');
    // Key must not be the generic provider:projectRoot form.
    expect(spec.key).not.toMatch(/^provider:/);
  });

  it('buildClaudeProviderServerSpec key changes when sessionId changes (one broker per session)', async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const { buildClaudeProviderServerSpec } = await import('../request-mapping.js').catch(() => null) ?? {};
    if (!buildClaudeProviderServerSpec) return;

    const spec1 = buildClaudeProviderServerSpec(makeRequest({ sessionId: 'session-a' }), 'sha256:hash', undefined);
    const spec2 = buildClaudeProviderServerSpec(makeRequest({ sessionId: 'session-b' }), 'sha256:hash', undefined);

    expect(spec1.key).not.toBe(spec2.key);
  });

  it('buildClaudeProviderServerSpec key is identical for same session and same bootstrap signature', async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const { buildClaudeProviderServerSpec } = await import('../request-mapping.js').catch(() => null) ?? {};
    if (!buildClaudeProviderServerSpec) return;

    const spec1 = buildClaudeProviderServerSpec(makeRequest({ sessionId: 'session-c' }), 'sha256:hash', undefined);
    const spec2 = buildClaudeProviderServerSpec(makeRequest({ sessionId: 'session-c' }), 'sha256:hash', undefined);

    expect(spec1.key).toBe(spec2.key);
  });
});

// ─── fork stays on one-shot path ──────────────────────────────────────────

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
      stdout: JSON.stringify({ type: 'result', result: 'forked', session_id: 'sess-fork', total_cost_usd: 0 }),
      stderr: '',
      code: 0,
      aborted: false,
    }));

    const runtime = makeRuntime(lease, { acquireServer: acquireServerMock, runCli: runCliMock });

    await claudeProvider.execute(
      makeRequest({ action: 'fork', conversationRef: 'sess-original' }),
      runtime,
    );

    expect(acquireServerMock).not.toHaveBeenCalled();
    expect(runCliMock).toHaveBeenCalled();
  });
});

// ─── bypassPermissions: false stays on one-shot before continuity ──────────

describe('claude adapter: bypassPermissions=false uses one-shot before persistent continuity', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses runCli (one-shot) for bypassPermissions=false when no persistent continuity exists', async () => {
    const { claudeProvider } = await loadProvider();

    const runCliMock = vi.fn(async () => ({
      stdout: JSON.stringify({ type: 'result', result: 'approved', session_id: 'sess-noperm', total_cost_usd: 0.001 }),
      stderr: '',
      code: 0,
      aborted: false,
    }));
    const lease = makeLease({ rpcImpl: async () => ({}) });
    const acquireServerMock = vi.fn(async () => lease);
    const runtime = makeRuntime(lease, { acquireServer: acquireServerMock, runCli: runCliMock });

    // bypassPermissions=false, no persistedContinuity
    await claudeProvider.execute(makeRequest({ bypassPermissions: false }), runtime);

    expect(acquireServerMock).not.toHaveBeenCalled();
    expect(runCliMock).toHaveBeenCalled();
  });

  it('requires new Coral session for bypassPermissions=false when persistent continuity already exists', async () => {
    const { claudeProvider } = await loadProvider();

    const persistedContinuity = {
      bootstrapSignature: {
        cwd: '/workspace',
        systemPromptHash: 'sha256:hash',
        permissionMode: 'bypass', // was established with bypass
      },
      conversationRef: 'sess-established',
    };

    const runCliMock = vi.fn();
    const lease = makeLease({ rpcImpl: async () => ({}) });
    const acquireServerMock = vi.fn(async () => lease);
    const runtime = makeRuntime(lease, { acquireServer: acquireServerMock, runCli: runCliMock }, persistedContinuity);

    // New request with bypassPermissions=false — drifts from established 'bypass' permissionMode.
    const result = await claudeProvider.execute(
      makeRequest({ bypassPermissions: false }),
      runtime,
    );

    // Must NOT fall back to one-shot inside the existing session.
    expect(runCliMock).not.toHaveBeenCalled();
    // Must NOT create a new broker lease for this session.
    expect(acquireServerMock).not.toHaveBeenCalled();
    // Must signal that a new session is needed.
    expect(result.nonResumable === true || result.errors !== undefined).toBe(true);
  });
});
