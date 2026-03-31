import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest } from '../../../shared/types.js';
import type { ProviderRuntime, ProviderServerLease } from '../../types.js';

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
    onEvent: vi.fn(),
    runCli: vi.fn(),
    acquireServer: lease ? vi.fn(async () => lease) : undefined,
    checkpointRecovery,
    persistedContinuity: persistedContinuity ?? undefined,
    ...overrides,
  } as ProviderRuntime & { checkpointRecovery: ReturnType<typeof vi.fn> };
}

describe('claude adapter recovery contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-recovery-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('finalizes from stdout file with valid stream-JSON output', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    const streamOutput = [
      '{"type":"assistant","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Recovered answer"}]}}',
      '{"type":"result","result":"Recovered answer","session_id":"sess-recovered","total_cost_usd":0.05,"duration_ms":3200}',
    ].join('\n');
    writeFileSync(stdoutPath, streamOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
    });

    expect(result.content).toBe('Recovered answer');
    expect(result.conversationRef).toBe('sess-recovered');
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.usage?.costUsd).toBe(0.05);
    expect(result.durationMs).toBe(3200);
  });

  it('falls back to raw content for unparseable stdout', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    const rawContent = 'This is not stream-JSON, just plain text.';
    writeFileSync(stdoutPath, rawContent, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 1,
      signal: null,
    });

    expect(result.content).toBe(rawContent);
    expect(result.exitCode).toBe(1);
  });

  it('includes kill signal notice in raw fallback', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    writeFileSync(stdoutPath, 'raw output', 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: null,
      signal: 'SIGKILL',
    });

    expect(result.content).toBe('raw output');
    expect(result.notice).toBe('killed by SIGKILL');
  });

  it('uses fallbackConversationRef when stream-JSON lacks session_id', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    // stream-JSON result with no session_id
    const streamOutput = '{"type":"result","result":"No session output"}\n';
    writeFileSync(stdoutPath, streamOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
      fallbackConversationRef: 'fallback-sess',
    });

    expect(result.content).toBe('No session output');
    expect(result.conversationRef).toBe('fallback-sess');
  });

  it('falls back to assistant text when result response is missing', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    const streamOutput = [
      '{"type":"assistant","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"assistant text"}]}}',
      '{"type":"result","session_id":"sess-fallback","total_cost_usd":0.01}',
    ].join('\n');
    writeFileSync(stdoutPath, streamOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
    });

    expect(result.content).toBe('assistant text');
    expect(result.conversationRef).toBe('sess-fallback');
  });

  it('handles empty stdout as raw fallback', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    writeFileSync(stdoutPath, '', 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
    });

    // Empty stdout → parser returns isError=true, no response → raw fallback
    expect(result.content).toBe('');
  });

  it('marks parsed recovered output as aborted when the wrapper exited by signal', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    const streamOutput = [
      '{"type":"assistant","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Recovered answer"}]}}',
      '{"type":"result","result":"Recovered answer","session_id":"sess-recovered","total_cost_usd":0.05,"duration_ms":3200}',
    ].join('\n');
    writeFileSync(stdoutPath, streamOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: null,
      signal: 'SIGTERM',
    });

    expect(result.aborted).toBe(true);
    expect(result.conversationRef).toBe('sess-recovered');
  });

  it('extracts progress from complete appended lines only', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const firstLine = '{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}\n';
    const partialLine = '{"type":"assistant","message":{"content":[{"type":"text","text":"second"}]}}';
    writeFileSync(stdoutPath, `${firstLine}${partialLine}`, 'utf-8');

    const first = claudeProvider.recovery!.extractProgress!({ stdoutPath, fromOffset: 0 });
    expect(first.messages).toEqual(['Generating response...']);
    expect(first.newOffset).toBe(Buffer.byteLength(firstLine));

    writeFileSync(stdoutPath, `${firstLine}${partialLine}\n`, 'utf-8');

    const second = claudeProvider.recovery!.extractProgress!({ stdoutPath, fromOffset: first.newOffset });
    expect(second.messages).toEqual(['Generating response...']);
    expect(second.newOffset).toBeGreaterThan(first.newOffset);
  });
});

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
        permissionMode: 'bypass',
      },
      conversationRef: 'sess-original',
    });

    const result = await claudeProvider.execute(makeRequest({ cwd: '/different/workspace' }), runtime);

    expect(runtime.acquireServer).not.toHaveBeenCalled();
    expect(runtime.checkpointRecovery).not.toHaveBeenCalled();
    expect(result.nonResumable === true || result.errors !== undefined).toBe(true);
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
          permissionMode: 'bypass',
        },
        conversationRef: 'sess-live',
      },
    );

    await claudeProvider.execute(makeRequest({ cwd: '/other' }), runtime).catch(() => {});

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
          permissionMode: 'bypass',
        },
        conversationRef: 'sess-live',
      },
    );

    await claudeProvider.execute(makeRequest({ cwd: '/drift' }), runtime).catch(() => {});

    expect(acquireServerMock).not.toHaveBeenCalled();
  });
});

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
    const execution = claudeProvider.execute(makeRequest(), runtime);

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
    expect((runtime as unknown as { runCli: ReturnType<typeof vi.fn> }).runCli).not.toHaveBeenCalled();
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
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypass',
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
    const execution = claudeProvider.execute(makeRequest(), runtime);

    await sessionEnsureStarted;
    await vi.waitFor(() => {
      expect(runtime.checkpointRecovery).toHaveBeenCalled();
    });

    const firstCall = runtime.checkpointRecovery.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const meta = firstCall?.providerMeta as Record<string, unknown> | undefined;

    expect(firstCall).toBeDefined();
    expect(meta?.bootstrapSignature).toBeDefined();
    expect(meta?.conversationRef == null || meta?.sessionId == null).toBe(true);

    lease.emit({
      method: 'turn/completed',
      params: { brokerTurnId: 'turn-1', result: 'ok', costUsd: 0 },
    });
    await execution.catch(() => {});
  });

  it('enriches checkpoint with session_id when session/updated arrives later', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypass',
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
    const execution = claudeProvider.execute(makeRequest(), runtime);

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    lease.emit({ method: 'session/updated', params: { sessionId: 'sess-late-1' } });
    lease.emit({
      method: 'turn/completed',
      params: { brokerTurnId: 'turn-1', result: 'answer', costUsd: 0.005 },
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
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypass',
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
    const execution = claudeProvider.execute(makeRequest(), runtime);

    await vi.waitFor(() => {
      const calls = runtime.checkpointRecovery.mock.calls as Array<[Record<string, unknown>]>;
      return calls.some((call) => {
        const meta = call[0]?.providerMeta as Record<string, unknown> | undefined;
        return meta?.brokerTurnId === 'broker-turn-42';
      });
    });

    lease.emit({
      method: 'turn/completed',
      params: { brokerTurnId: 'broker-turn-42', result: 'done', costUsd: 0 },
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
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypass',
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
    const execution = claudeProvider.execute(makeRequest(), runtime);

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
      expect(result.aborted === true || result.errors !== undefined || result.nonResumable === true).toBe(true);
    }
  }, 3000);

  it('releases the lease when broker dies, even if release was not called yet', async () => {
    const { claudeProvider } = await loadProvider();

    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            bootstrapSignature: {
              cwd: '/workspace',
              systemPromptHash: 'sha256:abc',
              permissionMode: 'bypass',
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
    const execution = claudeProvider.execute(makeRequest(), runtime);

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    lease.triggerClose(new Error('unexpected broker exit'));
    await execution.catch(() => {});

    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  }, 3000);
});

describe('claude adapter: claudeRecovery must not be invoked for persistent jobs', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('claudeRecovery.finalizeFromArtifacts is defined (sanity: one-shot path still has it)', async () => {
    const { claudeProvider } = await loadProvider();

    expect(claudeProvider.recovery).toBeDefined();
    expect(claudeProvider.recovery?.finalizeFromArtifacts).toBeInstanceOf(Function);
  });

  it('does not provide a recovery contract for persistent broker execution', async () => {
    const { claudeProvider } = await loadProvider();

    if ('appServer' in claudeProvider && claudeProvider.appServer !== undefined) {
      const appServer = (claudeProvider as unknown as { appServer: { finalizeInterrupted: unknown } }).appServer;
      expect(appServer.finalizeInterrupted).not.toBe(claudeProvider.recovery?.finalizeFromArtifacts);
    }
  });
});

describe('request-mapping: spec.key is stable and must not be replaced', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('buildClaudeProviderServerSpec produces a key that includes both sessionId and bootstrap signature', async () => {
    const { buildClaudeProviderServerSpec } = await import('../request-mapping.js');

    const spec = buildClaudeProviderServerSpec(
      makeRequest(),
      'sha256:system-prompt-hash',
      undefined,
    );

    expect(spec.key).toContain('session-persistent-1');
    expect(spec.key).not.toMatch(/^provider:/);
  });

  it('buildClaudeProviderServerSpec key changes when sessionId changes (one broker per session)', async () => {
    const { buildClaudeProviderServerSpec } = await import('../request-mapping.js');

    const spec1 = buildClaudeProviderServerSpec(makeRequest({ sessionId: 'session-a' }), 'sha256:hash', undefined);
    const spec2 = buildClaudeProviderServerSpec(makeRequest({ sessionId: 'session-b' }), 'sha256:hash', undefined);

    expect(spec1.key).not.toBe(spec2.key);
  });

  it('buildClaudeProviderServerSpec key is identical for same session and same bootstrap signature', async () => {
    const { buildClaudeProviderServerSpec } = await import('../request-mapping.js');

    const spec1 = buildClaudeProviderServerSpec(makeRequest({ sessionId: 'session-c' }), 'sha256:hash', undefined);
    const spec2 = buildClaudeProviderServerSpec(makeRequest({ sessionId: 'session-c' }), 'sha256:hash', undefined);

    expect(spec1.key).toBe(spec2.key);
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
    await claudeProvider.execute(
      makeRequest({ action: 'fork', conversationRef: 'sess-original' }),
      runtime,
    );

    expect(acquireServerMock).not.toHaveBeenCalled();
    expect(runCliMock).toHaveBeenCalled();
  });
});

describe('claude adapter: bypassPermissions=false uses one-shot before persistent continuity', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses runCli (one-shot) for bypassPermissions=false when no persistent continuity exists', async () => {
    const { claudeProvider } = await loadProvider();

    const runCliMock = vi.fn(async () => ({
      stdout: JSON.stringify({
        type: 'result',
        result: 'approved',
        session_id: 'sess-noperm',
        total_cost_usd: 0.001,
      }),
      stderr: '',
      code: 0,
      aborted: false,
    }));
    const lease = makeLease({ rpcImpl: async () => ({}) });
    const acquireServerMock = vi.fn(async () => lease);
    const runtime = makeRuntime(lease, { acquireServer: acquireServerMock, runCli: runCliMock });

    await claudeProvider.execute(makeRequest({ bypassPermissions: false }), runtime);

    expect(acquireServerMock).not.toHaveBeenCalled();
    expect(runCliMock).toHaveBeenCalled();
  });

  it('requires new Coral session for bypassPermissions=false when persistent continuity already exists', async () => {
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
          permissionMode: 'bypass',
        },
        conversationRef: 'sess-established',
      },
    );

    const result = await claudeProvider.execute(makeRequest({ bypassPermissions: false }), runtime);

    expect(runCliMock).not.toHaveBeenCalled();
    expect(acquireServerMock).not.toHaveBeenCalled();
    expect(result.nonResumable === true || result.errors !== undefined).toBe(true);
  });
});
