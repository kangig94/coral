import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest } from '../../shared/types.js';
import type { ProviderRuntime, ProviderServerLease } from '../types.js';

vi.mock('../claude/claude-executor.js', () => {
  class MockClaudeExecParseError extends Error {
    readonly failure: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      parseError: string;
    };

    constructor(failure: { exitCode: number | null; stdout: string; stderr: string; parseError: string }) {
      super('mock parse error');
      this.name = 'ClaudeExecParseError';
      this.failure = failure;
    }
  }

  return {
    ClaudeExecParseError: MockClaudeExecParseError,
    executeClaudeFork: vi.fn(),
  };
});

import { ClaudeExecParseError, executeClaudeFork } from '../claude/claude-executor.js';
import { claudeProvider, OUTPUT_STYLE_OVERRIDE } from '../claude/adapter.js';

const mockExecuteClaudeFork = vi.mocked(executeClaudeFork);
const BROKER_SESSION_KEY = 'broker-session-parity';

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'job-1',
    prompt: 'Run checks',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function makeLease(options: {
  rpcImpl?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}): ProviderServerLease & {
  emit(msg: { method: string; params?: Record<string, unknown> }): void;
  rpcMock: ReturnType<typeof vi.fn>;
} {
  let notificationHandler: ((msg: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  const rpcMock = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (options.rpcImpl) {
      return options.rpcImpl(method, params);
    }
    return {};
  });

  return {
    rpc: rpcMock as unknown as ProviderServerLease['rpc'],
    subscribe: vi.fn((handler) => {
      notificationHandler = handler;
      return () => {
        notificationHandler = null;
      };
    }),
    release: vi.fn(),
    closed: new Promise<Error | void>(() => {}),
    rpcMock,
    emit(msg) {
      notificationHandler?.(msg);
    },
  };
}

function makeRuntime(lease?: ProviderServerLease): {
  runCli: ReturnType<typeof vi.fn>;
  runtime: ProviderRuntime;
} {
  const controller = new AbortController();
  const runCli = vi.fn();
  return {
    runCli,
    runtime: {
      signal: controller.signal,
      onEvent: () => {},
      runCli,
      acquireServer: lease ? vi.fn(async () => lease) : undefined,
      checkpointRecovery: vi.fn(),
    },
  };
}

function baseForkResult(
  overrides: Partial<{
    response: string;
    sessionId: string | null;
    model: string;
    durationMs: number;
    costUsd: number | null;
    aborted: boolean;
  }> = {},
): {
  response: string;
  sessionId: string | null;
  model: string;
  durationMs: number;
  costUsd: number | null;
  aborted: boolean;
} {
  return {
    response: 'ok',
    sessionId: 'claude-thread',
    model: 'claude-sonnet-4-6-20250514',
    durationMs: 15,
    costUsd: 0,
    aborted: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteClaudeFork.mockResolvedValue(baseForkResult({ sessionId: 'claude-fork' }));
});

describe('claude provider adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteClaudeFork.mockResolvedValue(
      baseForkResult({
        response: 'claude fork',
        sessionId: 'claude-thread-fork',
        durationMs: 24,
        costUsd: 0.003,
      }),
    );
  });

  it('exec combines system-channel instruction with systemPrompt', async () => {
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: '/repo',
              systemPromptHash: 'sha256:ensure',
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
    const { runtime, runCli } = makeRuntime(lease);

    const execution = claudeProvider.execute(
      makeRequest({
        instruction: { channel: 'system', content: 'You are the architect agent' },
        systemPrompt: 'Honor repository policy',
        
        cwd: '/repo',
        effort: 'medium',
        bypassPermissions: true,
      }),
      runtime,
    );

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('session/ensure', expect.objectContaining({
        cwd: '/repo',
        permissionMode: 'bypassPermissions',
        systemPrompt: `You are the architect agent\n\nHonor repository policy\n\n${OUTPUT_STYLE_OVERRIDE}`,
      }));
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.objectContaining({
        prompt: 'Run checks',
        
      }));
    });
    lease.emit({
      method: 'turn/completed',
      params: { brokerSessionKey: BROKER_SESSION_KEY, brokerTurnId: 'turn-1', result: 'done', costUsd: 0 },
    });
    await execution;
    expect(runCli).not.toHaveBeenCalled();
  });

  it('exec prepends prompt-channel instruction and keeps systemPrompt separate', async () => {
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: process.cwd(),
              systemPromptHash: 'sha256:ensure',
              permissionMode: 'default',
            },
            sessionId: null,
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-2' };
        }
        return {};
      },
    });
    const { runtime, runCli } = makeRuntime(lease);

    const execution = claudeProvider.execute(
      makeRequest({
        instruction: { channel: 'prompt', content: 'First follow this instruction' },
        systemPrompt: 'System stays separate',
        
      }),
      runtime,
    );

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('session/ensure', expect.objectContaining({
        systemPrompt: `System stays separate\n\n${OUTPUT_STYLE_OVERRIDE}`,
      }));
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.objectContaining({
        prompt: 'First follow this instruction\n\n---\n\nRun checks',
        
      }));
    });
    lease.emit({
      method: 'turn/completed',
      params: { brokerSessionKey: BROKER_SESSION_KEY, brokerTurnId: 'turn-2', result: 'done', costUsd: 0 },
    });
    await execution;
    expect(runCli).not.toHaveBeenCalled();
  });

  it('exec passes systemPrompt through unchanged when no instruction is set', async () => {
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: process.cwd(),
              systemPromptHash: 'sha256:ensure',
              permissionMode: 'default',
            },
            sessionId: null,
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-3' };
        }
        return {};
      },
    });
    const { runtime, runCli } = makeRuntime(lease);

    const execution = claudeProvider.execute(
      makeRequest({
        systemPrompt: 'Just the system prompt',
      }),
      runtime,
    );

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('session/ensure', expect.objectContaining({
        systemPrompt: `Just the system prompt\n\n${OUTPUT_STYLE_OVERRIDE}`,
      }));
    });
    lease.emit({
      method: 'turn/completed',
      params: { brokerSessionKey: BROKER_SESSION_KEY, brokerTurnId: 'turn-3', result: 'done', costUsd: 0 },
    });
    await execution;
    expect(runCli).not.toHaveBeenCalled();
  });

  it('resume uses the persistent broker path with conversationRef', async () => {
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: process.cwd(),
              systemPromptHash: 'sha256:ensure',
              permissionMode: 'default',
            },
            sessionId: 'claude-thread-123',
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-resume' };
        }
        return {};
      },
    });
    const { runtime, runCli } = makeRuntime(lease);

    const execution = claudeProvider.execute(
      makeRequest({
        action: 'resume',
        conversationRef: 'claude-thread-123',
        prompt: 'Continue',
        systemPrompt: 'Restore persona',
      }),
      runtime,
    );

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('session/ensure', expect.objectContaining({
        conversationRef: 'claude-thread-123',
        systemPrompt: `Restore persona\n\n${OUTPUT_STYLE_OVERRIDE}`,
      }));
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.objectContaining({
        prompt: 'Continue',
      }));
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        brokerSessionKey: BROKER_SESSION_KEY,
        brokerTurnId: 'turn-resume',
        result: 'resumed',
        conversationRef: 'claude-thread-123',
        costUsd: 0,
      },
    });
    await execution;
    expect(runCli).not.toHaveBeenCalled();
  });

  it('returns nonResumable ProviderResult when fork throws ClaudeExecParseError', async () => {
    mockExecuteClaudeFork.mockRejectedValueOnce(
      new ClaudeExecParseError({
        exitCode: 7,
        stdout: 'not json',
        stderr: 'stderr',
        parseError: 'parse failed',
      }),
    );

    const result = await claudeProvider.execute(
      makeRequest({ action: 'fork', conversationRef: 'claude-thread-123', model: 'sonnet' }),
      makeRuntime().runtime,
    );

    expect(result).toEqual({
      content: '',
      notice: 'Claude CLI returned non-JSON output; result is non-resumable.',
      nonResumable: true,
      model: 'sonnet',
      exitCode: 7,
      errors: [
        {
          exitCode: 7,
          stdout: 'not json',
          stderr: 'stderr',
          parseError: 'parse failed',
        },
      ],
    });
  });

  it('maps persistent broker output into ProviderResult fields including usage.costUsd', async () => {
    const lease = makeLease({
      rpcImpl: async (method) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: BROKER_SESSION_KEY,
            bootstrapSignature: {
              cwd: process.cwd(),
              systemPromptHash: 'sha256:ensure',
              permissionMode: 'default',
            },
            sessionId: 'claude-session-9',
          };
        }
        if (method === 'turn/start') {
          return { brokerTurnId: 'turn-result' };
        }
        return {};
      },
    });
    const execution = claudeProvider.execute(makeRequest({ model: 'sonnet' }), makeRuntime(lease).runtime);

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });
    lease.emit({
      method: 'turn/completed',
      params: {
        brokerSessionKey: BROKER_SESSION_KEY,
        brokerTurnId: 'turn-result',
        result: 'mapped claude text',
        sessionId: 'claude-session-9',
        
        durationMs: 18,
        costUsd: 0.42,
      },
    });
    const result = await execution;

    expect(result).toMatchObject({
      content: 'mapped claude text',
      conversationRef: 'claude-session-9',
      
      durationMs: 18,
      exitCode: 0,
      usage: { costUsd: 0.42 },
    });
  });
});
