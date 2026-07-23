import { describe, expect, it, vi } from 'vitest';

import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderRequest,
} from '#src/providers/contract.js';
import { collectProviderEvents } from '#src/providers/stream.js';
import {
  brokerNotificationMethods,
  type SessionEnsureParams,
  type TurnFailureDiagnostic,
} from '#src/providers/claude/appserver/protocol.js';
import type { ClaudeBootstrapSignature } from '#src/providers/claude/request-prep.js';
import { claudeSessionKernel } from '#src/providers/claude/session-kernel.js';
import type { ClaudeExecutionPlan } from '#src/providers/claude/execution-plan.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { TEST_CLAUDE_PLAN } from '../../../helpers/provider-credentials.js';

type MockLease = AppServerSession & {
  readonly rpcMock: ReturnType<typeof vi.fn>;
  emit(message: { method: string; params?: Record<string, unknown> }): void;
};

function echoBootstrapSignature(params: Record<string, unknown> | undefined): ClaudeBootstrapSignature {
  const ensure = params as unknown as SessionEnsureParams;
  return {
    cwd: ensure.cwd,
    systemPromptHash: ensure.systemPromptHash,
    permissionMode: ensure.permissionMode,
    bootstrapConfigHash: ensure.bootstrapConfigHash,
  };
}

const REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'job-claude-diagnostic',
  name: 'claude',
  prompt: 'hello',
  cwd: '/workspace',
  bypassPermissions: false,
  coralEnv: {},
};

const DIAGNOSTIC = {
  reason: 'silent-hang',
  phase: 'registered',
  idleMs: 90_000,
  attempts: 2,
  childOutputTail: 'child tail',
  transcriptTail: 'transcript tail',
  sessionId: 'claude-session-diagnostic',
  conversationRef: 'claude-session-diagnostic',
} as const satisfies TurnFailureDiagnostic;

function makeLease(): MockLease {
  let notificationHandler: ((message: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  const rpcMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'session/ensure') {
      return {
        brokerSessionKey: 'broker-claude-diagnostic',
        bootstrapSignature: echoBootstrapSignature(params),
        sessionId: 'claude-session-diagnostic',
        conversationRef: 'claude-session-diagnostic',
      };
    }
    if (method === 'turn/start') {
      return {
        brokerSessionKey: 'broker-claude-diagnostic',
        brokerTurnId: 'claude-turn-diagnostic',
        sessionId: 'claude-session-diagnostic',
        conversationRef: 'claude-session-diagnostic',
      };
    }
    throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
  });

  return {
    rpc: rpcMock as unknown as AppServerSession['rpc'],
    subscribe: (handler) => {
      notificationHandler = handler;
      return () => {
        notificationHandler = null;
      };
    },
    closed: new Promise<Error | void>(() => {}),
    interrupt: (continuity) => Promise.resolve(rpcMock('turn/interrupt', continuity)).then(() => true),
    rpcMock,
    emit(message) {
      notificationHandler?.(message);
    },
  };
}

type ClaudeRuntime = ProviderAppServerRuntime<ClaudeExecutionPlan>;

function makeRuntime(controller = new AbortController()): ClaudeRuntime {
  return {
    transport: 'app-server',
    signal: controller.signal,
    appServerSession: makeLease(),
    time: {
      now: () => 1_000,
      setTimeout: () => ({ unref: () => {} }),
      clearTimeout: () => {},
    } as ClaudeRuntime['time'],
    storage: {
      existsSync: () => false,
      readFileSync: () => '',
      statSync: () => ({}) as ReturnType<ClaudeRuntime['storage']['statSync']>,
      readdirSync: () => [],
    } as unknown as ClaudeRuntime['storage'],
    ids: { uuid: () => 'claude-turn-diagnostic', sha256: () => 'sha256:test' },
    continuityBridge: {
      checkpoint: vi.fn(),
      transportClosed: vi.fn(),
    },
    kbRoot: '/mock/kb',
    executionPlan: TEST_CLAUDE_PLAN,
  };
}

function bindSession(runtime: ClaudeRuntime, session: AppServerSession): () => void {
  const previous = runtime.appServerSession;
  Object.defineProperty(runtime, 'appServerSession', { configurable: true, value: session });
  return () => {
    Object.defineProperty(runtime, 'appServerSession', { configurable: true, value: previous });
  };
}

function terminalEvent(events: readonly ProviderEventBody[]): Extract<ProviderEventBody, { kind: 'terminal' }> {
  const terminal = events.find(
    (event): event is Extract<ProviderEventBody, { kind: 'terminal' }> => event.kind === 'terminal',
  );
  if (terminal === undefined) {
    throw new Error('Expected terminal event.');
  }
  return terminal;
}

function suspendedEvent(events: readonly ProviderEventBody[]): Extract<ProviderEventBody, { kind: 'suspended' }> {
  const suspended = events.find(
    (event): event is Extract<ProviderEventBody, { kind: 'suspended' }> => event.kind === 'suspended',
  );
  if (suspended === undefined) {
    throw new Error('Expected suspended event.');
  }
  return suspended;
}

describe('Claude session-kernel turn failure diagnostics', () => {
  it('fails closed before turn/start when session/ensure omits a valid bootstrap signature', async () => {
    const rpcMock = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-claude-diagnostic',
          sessionId: 'claude-session-diagnostic',
          conversationRef: 'claude-session-diagnostic',
        };
      }
      throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
    });
    const lease = { ...makeLease(), rpc: rpcMock as AppServerSession['rpc'], rpcMock };
    const runtime = makeRuntime();
    const clearLease = bindSession(runtime, lease);

    try {
      const terminal = terminalEvent(await collectProviderEvents(claudeSessionKernel(REQUEST, runtime)));
      expect(terminal.terminal.outcome).toEqual({ kind: 'failed' });
      expect(terminal.failureCause).toMatchObject({
        body: { message: expect.stringContaining('bootstrap signature missing or invalid') },
      });
      expect(rpcMock).not.toHaveBeenCalledWith('turn/start', expect.any(Object));
    } finally {
      clearLease();
    }
  });

  it.each([
    ['cwd', '/other-workspace'],
    ['systemPromptHash', 'sha256:other-system-prompt'],
    ['permissionMode', 'bypassPermissions'],
    ['bootstrapConfigHash', 'sha256:other-bootstrap-config'],
  ] as const)(
    'fails closed before turn/start when session/ensure returns a valid-shaped mismatched %s',
    async (field, mismatch) => {
      const rpcMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: 'broker-claude-diagnostic',
            bootstrapSignature: { ...echoBootstrapSignature(params), [field]: mismatch },
            sessionId: 'claude-session-diagnostic',
            conversationRef: 'claude-session-diagnostic',
          };
        }
        throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
      });
      const lease = { ...makeLease(), rpc: rpcMock as AppServerSession['rpc'], rpcMock };
      const runtime = makeRuntime();
      const clearLease = bindSession(runtime, lease);

      try {
        const terminal = terminalEvent(await collectProviderEvents(claudeSessionKernel(REQUEST, runtime)));
        expect(terminal.terminal.outcome).toEqual({ kind: 'failed' });
        expect(terminal.failureCause).toMatchObject({
          body: { message: expect.stringContaining('exact requested bootstrap signature') },
        });
        expect(rpcMock).not.toHaveBeenCalledWith('turn/start', expect.any(Object));
      } finally {
        clearLease();
      }
    },
  );

  it('fails closed when turn/start does not echo the exact broker identities', async () => {
    const rpcMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-claude-diagnostic',
          bootstrapSignature: echoBootstrapSignature(params),
          sessionId: 'claude-session-diagnostic',
          conversationRef: 'claude-session-diagnostic',
        };
      }
      if (method === 'turn/start') return { sessionId: 'claude-session-diagnostic' };
      throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
    });
    const lease = { ...makeLease(), rpc: rpcMock as AppServerSession['rpc'], rpcMock };
    const runtime = makeRuntime();
    const clearLease = bindSession(runtime, lease);

    try {
      const terminal = terminalEvent(await collectProviderEvents(claudeSessionKernel(REQUEST, runtime)));
      expect(terminal.terminal.outcome).toEqual({ kind: 'failed' });
      expect(terminal.failureCause).toMatchObject({
        body: { message: expect.stringContaining('exact requested broker session key') },
      });
    } finally {
      clearLease();
    }
  });

  it('closes an ensured broker session when aborted before turn/start', async () => {
    const controller = new AbortController();
    const rpcMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'session/ensure') {
        controller.abort();
        return {
          brokerSessionKey: 'broker-claude-diagnostic',
          bootstrapSignature: echoBootstrapSignature(params),
          sessionId: 'claude-session-diagnostic',
          conversationRef: 'claude-session-diagnostic',
        };
      }
      if (method === 'session/close') {
        return {
          brokerSessionKey: 'broker-claude-diagnostic',
          closed: true,
        };
      }
      throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
    });
    const lease: MockLease = {
      ...makeLease(),
      rpc: rpcMock as unknown as AppServerSession['rpc'],
      rpcMock,
    };
    const runtime = makeRuntime(controller);
    const clearLease = bindSession(runtime, lease);

    try {
      const events = await collectProviderEvents(claudeSessionKernel(REQUEST, runtime));
      const terminal = terminalEvent(events);

      expect(terminal.terminal.outcome).toEqual({ kind: 'aborted', reason: 'signal_abort' });
      expect(rpcMock.mock.calls.map(([method]) => method)).toEqual(['session/ensure', 'session/close']);
    } finally {
      clearLease();
    }
  });

  it('interrupts the broker turn when aborted while turn/start is in flight', async () => {
    const controller = new AbortController();
    const startGate = createDeferred<Record<string, unknown>>();
    const activeCheckpointGate = createDeferred<void>();
    const rpcMock = vi.fn();
    const lease: MockLease = {
      ...makeLease(),
      rpcMock,
      rpc: (async (method: string, params: Record<string, unknown>) => {
        rpcMock(method, params);
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: 'broker-claude-diagnostic',
            bootstrapSignature: echoBootstrapSignature(params),
            sessionId: 'claude-session-diagnostic',
            conversationRef: 'claude-session-diagnostic',
          };
        }
        if (method === 'turn/start') {
          return startGate.promise;
        }
        if (method === 'turn/interrupt') {
          return {
            brokerTurnId: params.brokerTurnId,
            interrupted: true,
          };
        }
        throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
      }) as AppServerSession['rpc'],
      interrupt: async (continuity) => {
        await lease.rpc('turn/interrupt', continuity);
        return true;
      },
    };
    const runtime = makeRuntime(controller);
    runtime.continuityBridge.checkpoint = vi.fn((update) =>
      update.providerContinuity?.brokerTurnId === undefined ? undefined : activeCheckpointGate.promise,
    );
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(runtime.continuityBridge.checkpoint).toHaveBeenCalledWith(
          expect.objectContaining({
            providerContinuity: expect.objectContaining({
              brokerSessionKey: 'broker-claude-diagnostic',
              brokerTurnId: 'claude-turn-diagnostic',
            }),
          }),
        );
      });
      expect(lease.rpcMock).not.toHaveBeenCalledWith('turn/start', expect.any(Object));

      activeCheckpointGate.resolve();
      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });
      controller.abort();
      await vi.waitFor(() => {
        expect(rpcMock).toHaveBeenCalledWith('turn/interrupt', {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
        });
      });

      const terminal = terminalEvent(await eventsPromise);
      startGate.resolve({
        brokerSessionKey: 'broker-claude-diagnostic',
        brokerTurnId: 'claude-turn-diagnostic',
        sessionId: 'claude-session-diagnostic',
        conversationRef: 'claude-session-diagnostic',
      });

      expect(terminal.terminal.outcome).toEqual({ kind: 'aborted', reason: 'signal_abort' });
      expect(rpcMock.mock.calls.map(([method]) => method)).toEqual(['session/ensure', 'turn/start', 'turn/interrupt']);
      expect(rpcMock).toHaveBeenCalledWith('turn/interrupt', {
        brokerSessionKey: 'broker-claude-diagnostic',
        brokerTurnId: 'claude-turn-diagnostic',
      });
    } finally {
      clearLease();
    }
  });

  it('waits for delayed turn activation and retries when the first in-flight interrupt reports false', async () => {
    const controller = new AbortController();
    const startGate = createDeferred<Record<string, unknown>>();
    const interrupt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const rpcMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-claude-diagnostic',
          bootstrapSignature: echoBootstrapSignature(params),
          sessionId: 'claude-session-diagnostic',
          conversationRef: 'claude-session-diagnostic',
        };
      }
      if (method === 'turn/start') return startGate.promise;
      throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
    });
    const lease: MockLease = {
      ...makeLease(),
      rpc: rpcMock as AppServerSession['rpc'],
      rpcMock,
      interrupt,
    };
    const runtime = makeRuntime(controller);
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));
      await vi.waitFor(() => expect(rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object)));
      controller.abort();
      await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
      expect(interrupt).toHaveBeenNthCalledWith(1, {
        brokerSessionKey: 'broker-claude-diagnostic',
        brokerTurnId: 'claude-turn-diagnostic',
      });

      startGate.resolve({
        brokerSessionKey: 'broker-claude-diagnostic',
        brokerTurnId: 'claude-turn-diagnostic',
        sessionId: 'claude-session-diagnostic',
        conversationRef: 'claude-session-diagnostic',
      });
      const terminal = terminalEvent(await eventsPromise);

      expect(interrupt).toHaveBeenCalledTimes(2);
      expect(interrupt).toHaveBeenNthCalledWith(2, {
        brokerSessionKey: 'broker-claude-diagnostic',
        brokerTurnId: 'claude-turn-diagnostic',
      });
      expect(terminal.terminal.outcome).toEqual({ kind: 'aborted', reason: 'signal_abort' });
    } finally {
      clearLease();
    }
  });

  it.each([
    ['persistent false', () => Promise.resolve(false)],
    ['throwing', () => Promise.reject(new Error('interrupt unavailable'))],
  ] as const)(
    'retains the active recovery checkpoint when %s cancellation cannot be confirmed',
    async (_caseName, interruptAttempt) => {
      const controller = new AbortController();
      const startGate = createDeferred<Record<string, unknown>>();
      const interrupt = vi.fn(interruptAttempt);
      const rpcMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: 'broker-claude-diagnostic',
            bootstrapSignature: echoBootstrapSignature(params),
            sessionId: 'claude-session-diagnostic',
            conversationRef: 'claude-session-diagnostic',
          };
        }
        if (method === 'turn/start') return startGate.promise;
        throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
      });
      const lease: MockLease = {
        ...makeLease(),
        rpc: rpcMock as AppServerSession['rpc'],
        rpcMock,
        interrupt,
      };
      const runtime = makeRuntime(controller);
      const checkpoint = vi.fn();
      runtime.continuityBridge.checkpoint = checkpoint;
      const clearLease = bindSession(runtime, lease);

      try {
        const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));
        await vi.waitFor(() => expect(rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object)));
        controller.abort();
        await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
        startGate.resolve({
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          sessionId: 'claude-session-diagnostic',
          conversationRef: 'claude-session-diagnostic',
        });

        const events = await eventsPromise;
        const suspended = suspendedEvent(events);
        expect(interrupt).toHaveBeenCalledTimes(2);
        expect(suspended.reason).toBe('interrupt_unconfirmed');
        expect(events.some((event) => event.kind === 'terminal')).toBe(false);
        expect(checkpoint.mock.calls.at(-1)?.[0]).toMatchObject({
          providerContinuity: {
            brokerSessionKey: 'broker-claude-diagnostic',
            brokerTurnId: 'claude-turn-diagnostic',
          },
        });
      } finally {
        clearLease();
      }
    },
  );

  it('ignores completed notifications for a different broker turn before turn/start returns', async () => {
    const startGate = createDeferred<Record<string, unknown>>();
    const rpcMock = vi.fn();
    const lease: MockLease = {
      ...makeLease(),
      rpcMock,
      rpc: (async (method: string, params: Record<string, unknown>) => {
        rpcMock(method, params);
        if (method === 'session/ensure') {
          return {
            brokerSessionKey: 'broker-claude-diagnostic',
            bootstrapSignature: echoBootstrapSignature(params),
            sessionId: 'claude-session-diagnostic',
            conversationRef: 'claude-session-diagnostic',
          };
        }
        if (method === 'turn/start') {
          return startGate.promise;
        }
        throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
      }) as AppServerSession['rpc'],
    };
    const runtime = makeRuntime();
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });

      lease.emit({
        method: brokerNotificationMethods.turnCompleted,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'stale-turn',
          result: 'stale result',
        },
      });

      startGate.resolve({
        brokerSessionKey: 'broker-claude-diagnostic',
        brokerTurnId: 'claude-turn-diagnostic',
        sessionId: 'claude-session-diagnostic',
        conversationRef: 'claude-session-diagnostic',
      });

      lease.emit({
        method: brokerNotificationMethods.turnCompleted,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          result: 'real result',
        },
      });

      const terminal = terminalEvent(await eventsPromise);
      expect(terminal.terminal.content).toBe('real result');
    } finally {
      clearLease();
    }
  });

  it('ignores turn terminal notifications without a broker turn id', async () => {
    const lease = makeLease();
    const runtime = makeRuntime();
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });

      lease.emit({
        method: brokerNotificationMethods.turnCompleted,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          result: 'missing turn id result',
        },
      });

      lease.emit({
        method: brokerNotificationMethods.turnCompleted,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          result: 'valid result',
        },
      });

      const terminal = terminalEvent(await eventsPromise);
      expect(terminal.terminal.content).toBe('valid result');
    } finally {
      clearLease();
    }
  });

  it('reports normalized usage from a completed broker turn', async () => {
    const lease = makeLease();
    const runtime = makeRuntime();
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });

      lease.emit({
        method: brokerNotificationMethods.turnCompleted,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          result: 'usage result',
          model: 'claude-sonnet',
          durationMs: 250,
          costUsd: 0.42,
          usage: {
            input_tokens: 101,
            cache_read_input_tokens: 202,
            cache_creation_input_tokens: 303,
            output_tokens: 404,
          },
        },
      });

      const terminal = terminalEvent(await eventsPromise);

      expect(terminal.terminal.outcome).toEqual({ kind: 'completed' });
      expect(terminal.terminal.usage).toEqual({
        inputTokens: 101,
        cacheReadTokens: 202,
        cacheWriteTokens: 303,
        outputTokens: 404,
        costUsd: 0.42,
      });
    } finally {
      clearLease();
    }
  });

  it('materializes a broker turn diagnostic into the provider failure cause', async () => {
    const lease = makeLease();
    const runtime = makeRuntime();
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });
      lease.emit({
        method: brokerNotificationMethods.turnFailed,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          message: 'Claude turn stalled after prompt registration.',
          sessionId: 'claude-session-diagnostic',
          conversationRef: 'claude-session-diagnostic',
          diagnostic: DIAGNOSTIC,
        },
      });

      const terminal = terminalEvent(await eventsPromise);

      expect(terminal.failureCause).toEqual({
        type: 'session.provider_failed',
        body: {
          provider: 'claude',
          reason: 'request_failed',
          message: 'Claude turn stalled after prompt registration.',
          diagnostic: DIAGNOSTIC,
        },
      });
    } finally {
      clearLease();
    }
  });

  it('carries last observed usage into a failed terminal', async () => {
    const lease = makeLease();
    const runtime = makeRuntime();
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });
      lease.emit({
        method: brokerNotificationMethods.turnProgress,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          message: 'partial usage observed',
          costUsd: 0.12,
          usage: {
            input_tokens: 31,
            cache_read_input_tokens: 37,
          },
        },
      });
      lease.emit({
        method: brokerNotificationMethods.turnFailed,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          message: 'Claude turn stalled after prompt registration.',
          sessionId: 'claude-session-diagnostic',
          conversationRef: 'claude-session-diagnostic',
          diagnostic: DIAGNOSTIC,
        },
      });

      const terminal = terminalEvent(await eventsPromise);

      expect(terminal.terminal.outcome).toEqual({ kind: 'failed' });
      expect(terminal.terminal.usage).toEqual({
        inputTokens: 31,
        cacheReadTokens: 37,
        costUsd: 0.12,
      });
    } finally {
      clearLease();
    }
  });

  it('carries last observed usage into an aborted terminal', async () => {
    const controller = new AbortController();
    const rpcMock = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-claude-diagnostic',
          bootstrapSignature: echoBootstrapSignature(params),
          sessionId: 'claude-session-diagnostic',
          conversationRef: 'claude-session-diagnostic',
        };
      }
      if (method === 'turn/start') {
        return {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          sessionId: 'claude-session-diagnostic',
          conversationRef: 'claude-session-diagnostic',
        };
      }
      if (method === 'turn/interrupt') {
        return {
          brokerTurnId: params.brokerTurnId,
          interrupted: true,
        };
      }
      throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
    });
    const lease: MockLease = {
      ...makeLease(),
      rpc: rpcMock as unknown as AppServerSession['rpc'],
      rpcMock,
      interrupt: async () => true,
    };
    const runtime = makeRuntime(controller);
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });

      lease.emit({
        method: brokerNotificationMethods.turnProgress,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          message: 'partial usage observed',
          usage: {
            input_tokens: 41,
            cache_creation_input_tokens: 43,
            output_tokens: 47,
          },
        },
      });
      controller.abort();

      const terminal = terminalEvent(await eventsPromise);

      expect(terminal.terminal.outcome).toEqual({ kind: 'aborted', reason: 'signal_abort' });
      expect(terminal.terminal.usage).toEqual({
        inputTokens: 41,
        cacheWriteTokens: 43,
        outputTokens: 47,
      });
    } finally {
      clearLease();
    }
  });
});
