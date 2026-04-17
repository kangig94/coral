import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexProvider } from '../codex/adapter.js';
import type { ProviderRequest } from '../../shared/types.js';
import type { PreflightRuntime, ProviderRuntime, ProviderServerLease } from '../types.js';

type CodexPreflightRuntimeFixture = {
  runtime: PreflightRuntime;
  exec: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  homedir: ReturnType<typeof vi.fn>;
};

function makePreflightRuntimeFixture(): CodexPreflightRuntimeFixture {
  const exec = vi.fn(async () => ({
    status: 0,
    stdout: 'usage: codex app-server',
    stderr: '',
    error: undefined,
  }));
  const readFileSync = vi.fn(() => JSON.stringify({ tokens: { access_token: 'token-1' } }));
  const homedir = vi.fn(() => '/mock-home');

  return {
    runtime: {
      process: { exec } as Pick<PreflightRuntime['process'], 'exec'> as PreflightRuntime['process'],
      storage: { readFileSync } as Pick<PreflightRuntime['storage'], 'readFileSync'> as PreflightRuntime['storage'],
      env: { homedir } as Pick<PreflightRuntime['env'], 'homedir'> as PreflightRuntime['env'],
    },
    exec,
    readFileSync,
    homedir,
  };
}

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'job-1',
    prompt: 'Run checks',
    cwd: '/tmp/test',
    effort: 'high',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function makeLease(
  rpcImpl: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): ProviderServerLease & {
  emit(message: { method: string; params?: Record<string, unknown> }): void;
  releaseMock: ReturnType<typeof vi.fn>;
  rpcMock: ReturnType<typeof vi.fn>;
  subscribeMock: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let handler: ((message: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    handler = null;
  });
  const rpcMock = vi.fn((method: string, params: Record<string, unknown>) => rpcImpl(method, params));
  const subscribeMock = vi.fn((next: (message: { method: string; params?: Record<string, unknown> }) => void) => {
    handler = next;
    return unsubscribe;
  });
  const releaseMock = vi.fn();
  const closed = new Promise<Error | void>(() => {});

  return {
    rpc: rpcMock as unknown as ProviderServerLease['rpc'],
    subscribe: subscribeMock as unknown as ProviderServerLease['subscribe'],
    release: releaseMock,
    closed,
    rpcMock,
    subscribeMock,
    releaseMock,
    unsubscribe,
    emit(message: { method: string; params?: Record<string, unknown> }) {
      handler?.(message);
    },
  };
}

function makeRuntime(
  lease: ProviderServerLease,
  overrides: Partial<ProviderRuntime> = {},
): ProviderRuntime & {
  checkpointRecovery: ReturnType<typeof vi.fn>;
} {
  const controller = new AbortController();
  const checkpointRecovery = vi.fn();

  return {
    signal: controller.signal,
    onEvent: vi.fn(),
    runCli: vi.fn(),
    acquireServer: vi.fn(async () => lease),
    checkpointRecovery,
    ...overrides,
  } as ProviderRuntime & { checkpointRecovery: ReturnType<typeof vi.fn> };
}

async function loadProvider() {
  vi.resetModules();
  return import('../codex/adapter.js');
}

describe('codex adapter app-server flow', () => {
  let preflightRuntime: CodexPreflightRuntimeFixture;

  beforeEach(() => {
    vi.clearAllMocks();
    preflightRuntime = makePreflightRuntimeFixture();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('fails preflight when Codex CLI does not support app-server', async () => {
    preflightRuntime.exec.mockResolvedValue({
      status: 1,
      stdout: '',
      stderr: 'unknown subcommand',
      error: undefined,
    });

    const { codexProvider } = await loadProvider();

    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).rejects.toThrow(
      'Codex CLI does not support app-server. Update with: npm update -g @openai/codex',
    );
    expect(preflightRuntime.readFileSync).not.toHaveBeenCalled();
  });

  it('fails preflight when ~/.codex/auth.json is missing or has no tokens', async () => {
    preflightRuntime.readFileSync.mockReturnValue(JSON.stringify({ tokens: {} }));

    const { codexProvider } = await loadProvider();

    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).rejects.toThrow(
      'Codex CLI is not authenticated. Run "codex login" to create ~/.codex/auth.json.',
    );
    expect(preflightRuntime.readFileSync).toHaveBeenCalledWith('/mock-home/.codex/auth.json', 'utf-8');
  });

  it('passes preflight when app-server is available and auth.json contains tokens', async () => {
    const { codexProvider } = await loadProvider();

    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).resolves.toBeUndefined();
    expect(preflightRuntime.exec).toHaveBeenCalledWith('codex', ['app-server', '--help'], {
      encoding: 'utf-8',
      timeout: 10_000,
      inheritEnv: true,
    });
    expect(preflightRuntime.readFileSync).toHaveBeenCalledWith('/mock-home/.codex/auth.json', 'utf-8');
  });

  it('reuses successful preflight checks within the cache TTL', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const { codexProvider } = await loadProvider();

    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).resolves.toBeUndefined();
    now += 30_000;
    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).resolves.toBeUndefined();

    expect(preflightRuntime.exec).toHaveBeenCalledTimes(1);
    expect(preflightRuntime.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('re-runs preflight checks after the cache TTL expires', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const { codexProvider } = await loadProvider();

    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).resolves.toBeUndefined();
    now += 60_001;
    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).resolves.toBeUndefined();

    expect(preflightRuntime.exec).toHaveBeenCalledTimes(2);
    expect(preflightRuntime.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('caches failed app-server availability checks within the cache TTL', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    preflightRuntime.exec.mockResolvedValue({
      status: 1,
      stdout: '',
      stderr: 'unknown subcommand',
      error: undefined,
    });

    const { codexProvider } = await loadProvider();

    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).rejects.toThrow(
      'Codex CLI does not support app-server. Update with: npm update -g @openai/codex',
    );
    now += 30_000;
    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).rejects.toThrow(
      'Codex CLI does not support app-server. Update with: npm update -g @openai/codex',
    );

    expect(preflightRuntime.exec).toHaveBeenCalledTimes(1);
    expect(preflightRuntime.readFileSync).not.toHaveBeenCalled();
  });

  it('caches failed auth token checks within the cache TTL', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    preflightRuntime.readFileSync.mockReturnValue(JSON.stringify({ tokens: {} }));

    const { codexProvider } = await loadProvider();

    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).rejects.toThrow(
      'Codex CLI is not authenticated. Run "codex login" to create ~/.codex/auth.json.',
    );
    now += 30_000;
    await expect(codexProvider.preflight?.(preflightRuntime.runtime)).rejects.toThrow(
      'Codex CLI is not authenticated. Run "codex login" to create ~/.codex/auth.json.',
    );

    expect(preflightRuntime.exec).toHaveBeenCalledTimes(1);
    expect(preflightRuntime.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('checkpoints threadId after thread/start and turnId as soon as turn/start responds', async () => {
    const lease = makeLease(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(lease);
    const { codexProvider } = await loadProvider();

    const execution = codexProvider.execute(makeRequest(), runtime);

    await vi.waitFor(() => {
      expect(runtime.checkpointRecovery).toHaveBeenCalledTimes(2);
    });

    expect(runtime.checkpointRecovery).toHaveBeenNthCalledWith(1, {
      conversationRef: 'thread-1',
      providerMeta: {
        providerContinuity: {
          cwd: '/tmp/test',
          threadId: 'thread-1',
        },
      },
    });
    expect(runtime.checkpointRecovery).toHaveBeenNthCalledWith(2, {
      conversationRef: 'thread-1',
      providerMeta: {
        providerContinuity: {
          cwd: '/tmp/test',
          threadId: 'thread-1',
          turnId: 'turn-1',
        },
      },
    });
    expect(lease.unsubscribe).not.toHaveBeenCalled();

    lease.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: {
          type: 'agentMessage',
          text: 'Final answer',
        },
      },
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
        },
      },
    });

    await expect(execution).resolves.toMatchObject({
      content: 'Final answer',
      conversationRef: 'thread-1',
    });
    expect(runtime.checkpointRecovery).toHaveBeenLastCalledWith({
      conversationRef: 'thread-1',
      providerMeta: {
        providerContinuity: {
          cwd: '/tmp/test',
          threadId: 'thread-1',
        },
      },
    });
    expect(lease.unsubscribe).toHaveBeenCalledTimes(1);
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('sends turn/interrupt through the active lease when aborted after turn/start', async () => {
    const controller = new AbortController();
    const lease = makeLease(async (method, params) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') {
        return {
          threadId: params.threadId,
          turnId: params.turnId,
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(lease, {
      signal: controller.signal,
    });
    const { codexProvider } = await loadProvider();

    const execution = codexProvider.execute(makeRequest(), runtime);

    await vi.waitFor(() => {
      expect(runtime.checkpointRecovery).toHaveBeenCalledWith({
        conversationRef: 'thread-1',
        providerMeta: {
          providerContinuity: {
            cwd: '/tmp/test',
            threadId: 'thread-1',
            turnId: 'turn-1',
          },
        },
      });
    });

    controller.abort();
    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/interrupt', {
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
    });

    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'interrupted',
        },
      },
    });

    await expect(execution).resolves.toMatchObject({
      outcome: { kind: 'aborted', reason: 'signal_abort' },
      conversationRef: 'thread-1',
    });
  });

  it('returns a terminal non-resumable result when resume targets a missing thread', async () => {
    const lease = makeLease(async (method) => {
      if (method === 'thread/resume') {
        throw new Error('No such thread');
      }
      if (method === 'turn/start') {
        throw new Error('turn/start should not be called for a missing thread');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const runtime = makeRuntime(lease);
    const { codexProvider } = await loadProvider();

    await expect(
      codexProvider.execute(
        makeRequest({
          action: 'resume',
          conversationRef: 'thread-missing',
        }),
        runtime,
      ),
    ).resolves.toMatchObject({
      content: '',
      nonResumable: true,
      outcome: {
        kind: 'coral_fault',
        fault: {
          kind: 'provider_session_unavailable',
          provider: 'codex',
          note: 'Conversation thread-missing is no longer resumable because the saved thread is missing or invalid.',
        },
      },
    });

    expect(runtime.checkpointRecovery).not.toHaveBeenCalled();
    expect(lease.rpcMock.mock.calls.map(([method]) => method)).toEqual(['thread/resume']);
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('fails fork immediately with an explicit unsupported error', async () => {
    const lease = makeLease(async () => ({}));
    const runtime = makeRuntime(lease);
    const { codexProvider } = await loadProvider();

    await expect(
      codexProvider.execute(
        makeRequest({
          action: 'fork',
          conversationRef: 'thread-1',
        }),
        runtime,
      ),
    ).rejects.toThrow('Codex app-server fork is unsupported until clone/fork RPC is available.');

    expect(runtime.acquireServer).not.toHaveBeenCalled();
    expect(lease.releaseMock).not.toHaveBeenCalled();
  });
});

describe('codex adapter: provider export role contract', () => {
  it('exposes appServerLifecycle as a required role', () => {
    expect(codexProvider.appServerLifecycle).toBeDefined();
  });

  it('does not declare artifactRecovery or artifactCleanup', () => {
    expect(codexProvider).not.toHaveProperty('artifactRecovery');
    expect(codexProvider).not.toHaveProperty('artifactCleanup');
  });
});
