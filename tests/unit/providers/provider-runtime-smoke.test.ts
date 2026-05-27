import { describe, expect, it, vi } from 'vitest';

import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import { brokerNotificationMethods, type ClaudeBootstrapSignature } from '#src/providers/claude/appserver/protocol.js';
import type { ProviderCliRunner } from '#src/providers/protocol.js';
import type {
  ProviderContinuityEventBody,
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
  ProviderSpec,
} from '#src/providers/contract.js';
import { collectProviderEvents } from '#src/providers/stream.js';
import { createDeferred } from '#tools/testing/deferred.js';

const REGISTERED_PROVIDER_NAMES = ['claude', 'codex'] as const;
type RegisteredProviderName = (typeof REGISTERED_PROVIDER_NAMES)[number];

const CLAUDE_BOOTSTRAP_SIGNATURE: ClaudeBootstrapSignature = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:smoke',
  permissionMode: 'default',
};

type MockLease = ProviderServerLease & {
  close(outcome?: Error | void): void;
  emit(message: { method: string; params?: Record<string, unknown> }): void;
  releaseMock: ReturnType<typeof vi.fn>;
  rpcMock: ReturnType<typeof vi.fn>;
  subscribeMock: ReturnType<typeof vi.fn>;
};

type SmokeRuntime = ProviderRuntime & {
  controller: AbortController;
  acquireServer: ReturnType<typeof vi.fn>;
  runCli: ReturnType<typeof vi.fn>;
};

function makeLease(rpcImpl: (method: string, params: Record<string, unknown>) => Promise<unknown>): MockLease {
  const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
  const closed = createDeferred<Error | void>();
  const rpcMock = vi.fn((method: string, params: Record<string, unknown>) => rpcImpl(method, params));
  const subscribeMock = vi.fn((handler: (message: { method: string; params?: Record<string, unknown> }) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  });
  const releaseMock = vi.fn();

  return {
    rpc: rpcMock as unknown as ProviderServerLease['rpc'],
    subscribe: subscribeMock as unknown as ProviderServerLease['subscribe'],
    release: releaseMock,
    closed: closed.promise,
    close(outcome) {
      closed.resolve(outcome);
    },
    emit(message) {
      for (const handler of handlers) {
        handler(message);
      }
    },
    releaseMock,
    rpcMock,
    subscribeMock,
  };
}

function makeRuntime(
  options: {
    controller?: AbortController;
    persistedContinuity?: ProviderRuntime['persistedContinuity'];
    runCliImpl?: ProviderCliRunner;
    acquireServerImpl?: () => Promise<ProviderServerLease>;
  } = {},
): SmokeRuntime {
  const controller = options.controller ?? new AbortController();
  const runCli = vi.fn<ProviderCliRunner>(
    options.runCliImpl ??
      (async () => {
        throw new Error('runCli should not be called in this smoke scenario.');
      }),
  );
  const acquireServer = vi.fn(
    options.acquireServerImpl ??
      (async () => {
        throw new Error('acquireServer should not be called in this smoke scenario.');
      }),
  );

  return {
    controller,
    signal: controller.signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    runCli,
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    storage: { existsSync: () => true } as unknown as ProviderRuntime['storage'],
    acquireServer,
    persistedContinuity: options.persistedContinuity,
    continuityBridge: {
      checkpoint: vi.fn(),
      transportClosed: vi.fn(),
    },
    kbRoot: '/mock/kb',
  };
}

function makeRequest(provider: RegisteredProviderName, overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: `job-${provider}-runtime-smoke`,
    name: provider,
    prompt: `Run ${provider} smoke coverage.`,
    cwd: '/workspace',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function getProductionProvider(name: RegisteredProviderName): ProviderSpec {
  const provider = createBuiltInProviderRegistry().get(name);
  if (!provider) {
    throw new Error(`Expected built-in provider ${name} to be registered.`);
  }

  return provider;
}

function isTerminalEvent(event: ProviderEventBody): event is Extract<ProviderEventBody, { kind: 'terminal' }> {
  return event.kind === 'terminal';
}

function isContinuityEvent(event: ProviderEventBody): event is ProviderContinuityEventBody {
  return event.kind === 'continuity';
}

function expectSingleTerminalLast(events: ProviderEventBody[]): Extract<ProviderEventBody, { kind: 'terminal' }> {
  const terminals = events.filter(isTerminalEvent);
  expect(terminals).toHaveLength(1);
  expect(events[events.length - 1]).toBe(terminals[0]);
  return terminals[0];
}

function expectValidContinuitySnapshots(events: ProviderEventBody[]): ProviderContinuityEventBody[] {
  const continuityEvents = events.filter(isContinuityEvent);

  for (const event of continuityEvents) {
    expect(Object.hasOwn(event, 'conversationRef')).toBe(true);
    expect(Object.hasOwn(event, 'resumable')).toBe(true);
    expect(Object.hasOwn(event, 'providerContinuity')).toBe(true);
    expect(typeof event.conversationRef === 'string' || event.conversationRef === null).toBe(true);
    expect(typeof event.resumable).toBe('boolean');

    if (event.resumable) {
      expect(event.conversationRef).not.toBeNull();
    }
  }

  return continuityEvents;
}

describe('provider runtime smoke', () => {
  it.each(REGISTERED_PROVIDER_NAMES)(
    'runs %s through the production-composed stack with one terminal last and valid continuity snapshots',
    async (providerName) => {
      const provider = getProductionProvider(providerName);

      if (providerName === 'claude') {
        const lease = makeLease(async (method) => {
          if (method === 'session/ensure') {
            return {
              brokerSessionKey: 'broker-claude-smoke',
              bootstrapSignature: CLAUDE_BOOTSTRAP_SIGNATURE,
              sessionId: 'claude-session-smoke',
              conversationRef: 'claude-session-smoke',
            };
          }
          if (method === 'turn/start') {
            return {
              brokerTurnId: 'claude-turn-smoke',
              sessionId: 'claude-session-smoke',
              conversationRef: 'claude-session-smoke',
            };
          }
          throw new Error(`Unexpected Claude smoke RPC: ${method}`);
        });
        const runtime = makeRuntime({
          acquireServerImpl: async () => lease,
        });

        const eventsPromise = collectProviderEvents(provider.run(makeRequest('claude'), runtime));

        await vi.waitFor(() => {
          expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
        });

        lease.emit({
          method: brokerNotificationMethods.turnProgress,
          params: {
            brokerSessionKey: 'broker-claude-smoke',
            brokerTurnId: 'claude-turn-smoke',
            sessionId: 'claude-session-smoke',
            conversationRef: 'claude-session-smoke',
            message: 'Claude broker progress',
          },
        });
        lease.emit({
          method: brokerNotificationMethods.turnCompleted,
          params: {
            brokerSessionKey: 'broker-claude-smoke',
            brokerTurnId: 'claude-turn-smoke',
            sessionId: 'claude-session-smoke',
            conversationRef: 'claude-session-smoke',
            result: 'Claude broker result',
            model: 'claude-sonnet-4',
            durationMs: 12,
            numTurns: 1,
            costUsd: 0.01,
            usage: null,
            isError: false,
            subtype: null,
          },
        });

        const events = await eventsPromise;
        const terminal = expectSingleTerminalLast(events);
        const continuityEvents = expectValidContinuitySnapshots(events);

        expect(continuityEvents.length).toBeGreaterThan(0);
        expect(terminal.terminal.outcome).toEqual({ kind: 'completed' });
        expect(runtime.acquireServer).toHaveBeenCalledTimes(1);
        expect(runtime.runCli).not.toHaveBeenCalled();
        return;
      }

      const lease = makeLease(async (method) => {
        if (method === 'thread/start') {
          return { thread: { id: 'codex-thread-smoke' } };
        }
        if (method === 'turn/start') {
          return { turn: { id: 'codex-turn-smoke', status: 'inProgress' } };
        }
        throw new Error(`Unexpected Codex smoke RPC: ${method}`);
      });
      const runtime = makeRuntime({
        acquireServerImpl: async () => lease,
      });

      const eventsPromise = collectProviderEvents(provider.run(makeRequest('codex'), runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });

      lease.emit({
        method: 'item/completed',
        params: {
          threadId: 'codex-thread-smoke',
          item: {
            type: 'agentMessage',
            text: 'Codex final answer',
            phase: 'final_answer',
          },
        },
      });
      lease.emit({
        method: 'turn/completed',
        params: {
          threadId: 'codex-thread-smoke',
          turn: { id: 'codex-turn-smoke', status: 'completed' },
        },
      });

      const events = await eventsPromise;
      const terminal = expectSingleTerminalLast(events);
      const continuityEvents = expectValidContinuitySnapshots(events);

      expect(continuityEvents.length).toBeGreaterThan(0);
      expect(terminal.terminal.outcome).toEqual({ kind: 'completed' });
      expect(runtime.acquireServer).toHaveBeenCalledTimes(1);
      expect(runtime.runCli).not.toHaveBeenCalled();
    },
  );

  it('emits aborted from the Claude appserver path when aborted after turn start', async () => {
    const provider = getProductionProvider('claude');
    const controller = new AbortController();
    const lease = makeLease(async (method, params) => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-claude-aborted',
          bootstrapSignature: CLAUDE_BOOTSTRAP_SIGNATURE,
          sessionId: 'claude-session-aborted',
          conversationRef: 'claude-session-aborted',
        };
      }
      if (method === 'turn/start') {
        return {
          brokerTurnId: 'claude-turn-aborted',
          sessionId: 'claude-session-aborted',
          conversationRef: 'claude-session-aborted',
        };
      }
      if (method === 'turn/interrupt') {
        return {
          brokerTurnId: params.brokerTurnId ?? 'claude-turn-aborted',
          interrupted: true,
        };
      }
      throw new Error(`Unexpected Claude abort RPC: ${method}`);
    });
    const runtime = makeRuntime({
      controller,
      acquireServerImpl: async () => lease,
    });

    const eventsPromise = collectProviderEvents(provider.run(makeRequest('claude'), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    runtime.controller.abort();

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith(
        'turn/interrupt',
        expect.objectContaining({
          brokerSessionKey: 'broker-claude-aborted',
          brokerTurnId: 'claude-turn-aborted',
        }),
      );
    });

    const events = await eventsPromise;
    const terminal = expectSingleTerminalLast(events);
    const continuityEvents = expectValidContinuitySnapshots(events);
    const finalProviderContinuity = continuityEvents.at(-1)?.providerContinuity;

    expect(
      finalProviderContinuity && typeof finalProviderContinuity === 'object'
        ? Object.hasOwn(finalProviderContinuity, 'brokerTurnId')
        : false,
    ).toBe(false);
    expect(terminal.terminal.outcome).toEqual({ kind: 'aborted', reason: 'signal_abort' });
    expect(runtime.acquireServer).toHaveBeenCalledTimes(1);
    expect(runtime.runCli).not.toHaveBeenCalled();
  });

  it('emits aborted from the Codex leaf kernel when aborted mid-stream', async () => {
    const provider = getProductionProvider('codex');
    const controller = new AbortController();
    const lease = makeLease(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'codex-thread-aborted' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'codex-turn-aborted', status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') {
        return {
          threadId: 'codex-thread-aborted',
          turnId: 'codex-turn-aborted',
        };
      }
      throw new Error(`Unexpected Codex abort RPC: ${method}`);
    });
    const runtime = makeRuntime({
      controller,
      acquireServerImpl: async () => lease,
    });

    const eventsPromise = collectProviderEvents(provider.run(makeRequest('codex'), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    runtime.controller.abort();

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith(
        'turn/interrupt',
        expect.objectContaining({
          threadId: 'codex-thread-aborted',
          turnId: 'codex-turn-aborted',
        }),
      );
    });

    lease.emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread-aborted',
        turn: { id: 'codex-turn-aborted', status: 'interrupted' },
      },
    });

    const events = await eventsPromise;
    const terminal = expectSingleTerminalLast(events);

    expectValidContinuitySnapshots(events);
    expect(terminal.terminal.outcome).toEqual({ kind: 'aborted', reason: 'signal_abort' });
    expect(runtime.acquireServer).toHaveBeenCalledTimes(1);
    expect(runtime.runCli).not.toHaveBeenCalled();
  });

});
