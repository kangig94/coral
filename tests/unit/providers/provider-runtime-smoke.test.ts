import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import { brokerNotificationMethods, type SessionEnsureParams } from '#src/providers/claude/appserver/protocol.js';
import type { ClaudeBootstrapSignature } from '#src/providers/claude/request-prep.js';
import type {
  ProviderContinuityEventBody,
  ProviderEventBody,
  ProviderRequest,
  AppServerSession,
} from '#src/providers/contract.js';
import type { BoundProvider, BoundProviderAppServerExecutionRuntime } from '#src/providers/bound-provider-contract.js';
import type { ProviderBindingEnvelope } from '#src/infra/provider-binding-envelope.js';
import { collectProviderEvents } from '#src/providers/stream.js';
import { commitContinuityEvent } from '#src/providers/internal/continuity-commit.js';
import { createDeferred } from '#tools/testing/deferred.js';
import {
  TEST_CLAUDE_BINDING,
  TEST_CODEX_BINDING,
  withTestBindingLocation,
} from '../../helpers/provider-credentials.js';

const REGISTERED_PROVIDER_NAMES = ['claude', 'codex'] as const;
type RegisteredProviderName = (typeof REGISTERED_PROVIDER_NAMES)[number];

const CLAUDE_BOOTSTRAP_SIGNATURE: ClaudeBootstrapSignature = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:sha256:fake',

  bootstrapConfigHash: 'sha256:test-bootstrap',
  permissionMode: 'default',
};

function echoClaudeBootstrapSignature(params: Record<string, unknown> | undefined): ClaudeBootstrapSignature {
  const ensure = params as unknown as SessionEnsureParams;
  return {
    cwd: ensure.cwd,
    systemPromptHash: ensure.systemPromptHash,
    permissionMode: ensure.permissionMode,
    bootstrapConfigHash: ensure.bootstrapConfigHash,
  };
}

beforeAll(() => vi.stubGlobal('__PLUGIN_ROOT__', '/test/plugin'));
afterAll(() => vi.unstubAllGlobals());

type MockLease = AppServerSession & {
  close(outcome?: Error | void): void;
  emit(message: { method: string; params?: Record<string, unknown> }): void;
  releaseMock: () => void;
  rpcMock: ReturnType<typeof vi.fn>;
  subscribeMock: ReturnType<typeof vi.fn>;
};

type PreparedRuntime = BoundProviderAppServerExecutionRuntime;

type SmokeRuntime = PreparedRuntime & {
  controller: AbortController;
};

let testSessionFactory: () => Promise<AppServerSession> = async () => {
  throw new Error('appServerSession should not be called in this smoke scenario.');
};

const appServerHost = {
  openSession: vi.fn(async () => {
    const session = await testSessionFactory();
    return {
      session,
      hostRef: {
        provider: 'test',
        fingerprint: '0'.repeat(64),
        instanceId: 'instance-1',
        leaseMode: 'shared' as const,
      },
      close: () => (session as MockLease).releaseMock(),
    };
  }),
  attachSession: async () => null,
};

function makeLease(rpcImpl: (method: string, params: Record<string, unknown>) => Promise<unknown>): MockLease {
  const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
  const closed = createDeferred<Error | void>();
  const rpcMock = vi.fn((method: string, params: Record<string, unknown>) =>
    method === 'config/read' ? Promise.resolve({ config: {} }) : rpcImpl(method, params),
  );
  const subscribeMock = vi.fn((handler: (message: { method: string; params?: Record<string, unknown> }) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  });
  const releaseMock = vi.fn();

  return {
    rpc: rpcMock as unknown as AppServerSession['rpc'],
    subscribe: subscribeMock as unknown as AppServerSession['subscribe'],
    closed: closed.promise,
    interrupt: vi.fn(async () => ({ kind: 'not-accepted' as const, reason: 'test refusal' })),
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

function makeRuntime(options: {
  controller?: AbortController;
  persistedContinuity?: PreparedRuntime['persistedContinuity'];
  appServerSessionImpl?: () => Promise<AppServerSession>;
  env?: PreparedRuntime['env'];
  storage?: PreparedRuntime['storage'];
}): SmokeRuntime {
  appServerHost.openSession.mockClear();
  const controller = options.controller ?? new AbortController();
  testSessionFactory =
    options.appServerSessionImpl ??
    (async () => {
      throw new Error('appServerSession should not be called in this smoke scenario.');
    });

  return {
    controller,
    transport: 'app-server',
    signal: controller.signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    storage: options.storage ?? ({ existsSync: () => true } as unknown as PreparedRuntime['storage']),
    env: options.env,
    jobId: 'smoke-job',
    onAppServerWaiting: vi.fn(),
    onHostRef: vi.fn(),
    onProviderTurnTerminal: vi.fn(),
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

function getProductionProvider(
  name: RegisteredProviderName,
  binding: ProviderBindingEnvelope = name === 'claude' ? TEST_CLAUDE_BINDING : TEST_CODEX_BINDING,
): BoundProvider {
  const registry = createBuiltInProviderRegistry();
  registry.connectAppServerHost(appServerHost);
  const provider = registry.rehydrateBinding(binding);
  if (!provider.ok || provider.value.name !== name) throw new Error(`Expected built-in provider ${name} to bind.`);
  return provider.value;
}

function executeProvider(provider: BoundProvider, request: ProviderRequest, runtime: PreparedRuntime) {
  const prepared = provider.prepareExecution({
    request,
    baseEnv: {},
    storage: { existsSync: () => false },
    platform: process.platform,
  });
  if (prepared.kind !== 'app-server') throw new Error(`Expected ${provider.name} to prepare app-server execution.`);
  return prepared.execute(runtime);
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

function fakeDirent(name: string, kind: 'directory' | 'file') {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
  };
}

describe('provider runtime smoke', () => {
  it.each(REGISTERED_PROVIDER_NAMES)(
    'runs %s through the production-composed stack with one terminal last and valid continuity snapshots',
    async (providerName) => {
      const provider = getProductionProvider(providerName);

      if (providerName === 'claude') {
        const lease = makeLease(async (method, params) => {
          if (method === 'session/ensure') {
            return {
              brokerSessionKey: 'broker-claude-smoke',
              bootstrapSignature: echoClaudeBootstrapSignature(params),
              sessionId: 'claude-session-smoke',
              conversationRef: 'claude-session-smoke',
            };
          }
          if (method === 'turn/start') {
            return {
              brokerSessionKey: params.brokerSessionKey,
              brokerTurnId: params.brokerTurnId,
              sessionId: 'claude-session-smoke',
              conversationRef: 'claude-session-smoke',
            };
          }
          throw new Error(`Unexpected Claude smoke RPC: ${method}`);
        });
        const runtime = makeRuntime({ appServerSessionImpl: async () => lease });

        const eventsPromise = collectProviderEvents(executeProvider(provider, makeRequest('claude'), runtime));

        await vi.waitFor(() => {
          expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
        });

        lease.emit({
          method: brokerNotificationMethods.turnProgress,
          params: {
            brokerSessionKey: 'broker-claude-smoke',
            brokerTurnId: 'test-uuid',
            sessionId: 'claude-session-smoke',
            conversationRef: 'claude-session-smoke',
            message: 'Claude broker progress',
          },
        });
        lease.emit({
          method: brokerNotificationMethods.turnCompleted,
          params: {
            brokerSessionKey: 'broker-claude-smoke',
            brokerTurnId: 'test-uuid',
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
        expect(appServerHost.openSession).toHaveBeenCalledTimes(1);
        expect('runCli' in runtime).toBe(false);
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
      const runtime = makeRuntime({ appServerSessionImpl: async () => lease });

      const eventsPromise = collectProviderEvents(executeProvider(provider, makeRequest('codex'), runtime));

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
      expect(appServerHost.openSession).toHaveBeenCalledTimes(1);
      expect('runCli' in runtime).toBe(false);
    },
  );

  it('emits aborted from the Claude appserver path when aborted after turn start', async () => {
    const provider = getProductionProvider('claude');
    const controller = new AbortController();
    const lease = makeLease(async (method, params) => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-claude-aborted',
          bootstrapSignature: echoClaudeBootstrapSignature(params),
          sessionId: 'claude-session-aborted',
          conversationRef: 'claude-session-aborted',
        };
      }
      if (method === 'turn/start') {
        return {
          brokerSessionKey: params.brokerSessionKey,
          brokerTurnId: params.brokerTurnId,
          sessionId: 'claude-session-aborted',
          conversationRef: 'claude-session-aborted',
        };
      }
      if (method === 'turn/interrupt') {
        return {
          brokerTurnId: params.brokerTurnId,
          interrupted: true,
        };
      }
      throw new Error(`Unexpected Claude abort RPC: ${method}`);
    });
    const runtime = makeRuntime({ controller, appServerSessionImpl: async () => lease });

    const eventsPromise = collectProviderEvents(executeProvider(provider, makeRequest('claude'), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    runtime.controller.abort();

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith(
        'turn/interrupt',
        expect.objectContaining({
          brokerSessionKey: 'broker-claude-aborted',
          brokerTurnId: 'test-uuid',
        }),
      );
    });
    lease.emit({
      method: brokerNotificationMethods.turnFailed,
      params: {
        brokerSessionKey: 'broker-claude-aborted',
        brokerTurnId: 'test-uuid',
        message: 'Claude child exited after interruption.',
      },
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
    expect(appServerHost.openSession).toHaveBeenCalledTimes(1);
    expect('runCli' in runtime).toBe(false);
  });

  it('persists active Claude interrupt coordinates, reattaches for the exact recovered interrupt, and clears them on settlement', async () => {
    const provider = getProductionProvider('claude');
    const lease = makeLease(async (method, params) => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-recovered-interrupt',
          bootstrapSignature: echoClaudeBootstrapSignature(params),
          conversationRef: 'claude-recovered-interrupt',
        };
      }
      if (method === 'turn/start') {
        return {
          brokerSessionKey: params.brokerSessionKey,
          brokerTurnId: params.brokerTurnId,
          conversationRef: 'claude-recovered-interrupt',
        };
      }
      if (method === 'turn/interrupt') {
        return { brokerSessionKey: params.brokerSessionKey, brokerTurnId: params.brokerTurnId, interrupted: true };
      }
      throw new Error(`Unexpected recovered interrupt RPC: ${method}`);
    });
    const runtime = makeRuntime({ appServerSessionImpl: async () => lease });
    const observedEvents: ProviderEventBody[] = [];
    const eventsPromise = (async () => {
      for await (const event of executeProvider(provider, makeRequest('claude'), runtime)) {
        observedEvents.push(event);
        if (event.kind === 'continuity') commitContinuityEvent(event);
      }
      return observedEvents;
    })();

    await vi.waitFor(() => expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object)));
    lease.emit({
      method: brokerNotificationMethods.turnProgress,
      params: {
        brokerSessionKey: 'broker-recovered-interrupt',
        brokerTurnId: 'test-uuid',
        message: 'checkpoint active coordinates',
      },
    });
    await vi.waitFor(() => {
      expect(
        observedEvents.some(
          (event) => event.kind === 'continuity' && event.providerContinuity?.brokerTurnId === 'test-uuid',
        ),
      ).toBe(true);
    });
    const active = [...observedEvents]
      .reverse()
      .find(
        (event): event is ProviderContinuityEventBody =>
          event.kind === 'continuity' && event.providerContinuity?.brokerTurnId === 'test-uuid',
      )?.providerContinuity;
    expect(active).toMatchObject({
      brokerSessionKey: 'broker-recovered-interrupt',
      brokerTurnId: 'test-uuid',
    });

    const hostRef = {
      provider: 'claude',
      fingerprint: '0'.repeat(64),
      instanceId: 'instance-recovered-interrupt',
      leaseMode: 'shared' as const,
    };
    const recoveryRegistry = createBuiltInProviderRegistry();
    recoveryRegistry.connectAppServerHost({
      openSession: async () => {
        throw new Error('Recovered interrupt must attach, not open.');
      },
      attachSession: async () => ({ session: lease, hostRef, close: vi.fn() }),
    });
    const recovered = recoveryRegistry.rehydrateBinding(TEST_CLAUDE_BINDING);
    if (!recovered.ok) throw new Error('Expected recovered Claude binding.');
    const recoveredHostInput = {
      request: makeRequest('claude'),
      baseEnv: {},
      platform: 'linux',
      storage: { existsSync: () => false },
      jobId: 'job-claude-runtime-smoke',
    } as const;
    const callsBeforeInterrupt = lease.rpcMock.mock.calls.length;
    await expect(recovered.value.appServer?.interrupt(hostRef, active ?? {}, recoveredHostInput)).resolves.toEqual({
      kind: 'accepted',
    });
    expect(lease.rpcMock).toHaveBeenNthCalledWith(callsBeforeInterrupt + 1, 'turn/interrupt', {
      brokerSessionKey: 'broker-recovered-interrupt',
      brokerTurnId: 'test-uuid',
    });
    await expect(
      recovered.value.appServer?.interrupt(
        hostRef,
        { bootstrapSignature: CLAUDE_BOOTSTRAP_SIGNATURE },
        recoveredHostInput,
      ),
    ).resolves.toMatchObject({ kind: 'not-accepted' });
    expect(lease.rpcMock).toHaveBeenCalledTimes(callsBeforeInterrupt + 1);

    lease.emit({
      method: brokerNotificationMethods.turnCompleted,
      params: {
        brokerSessionKey: 'broker-recovered-interrupt',
        brokerTurnId: 'test-uuid',
        conversationRef: 'claude-recovered-interrupt',
        result: 'done',
        durationMs: 1,
        isError: false,
      },
    });
    const settledEvents = await eventsPromise;
    const settled = settledEvents.filter(isContinuityEvent).at(-1)?.providerContinuity;
    expect(settled).not.toHaveProperty('brokerSessionKey');
    expect(settled).not.toHaveProperty('brokerTurnId');
  });

  it('retries Claude JSONL artifact discovery after the transcript appears', async () => {
    const provider = getProductionProvider(
      'claude',
      withTestBindingLocation(TEST_CLAUDE_BINDING, '/home/tester/.claude'),
    );
    let artifactVisible = false;
    const lease = makeLease(async (method, params) => {
      if (method === 'session/ensure') {
        return {
          brokerSessionKey: 'broker-claude-artifact',
          bootstrapSignature: echoClaudeBootstrapSignature(params),
          sessionId: 'claude-session-artifact',
          conversationRef: 'claude-session-artifact',
        };
      }
      if (method === 'turn/start') {
        return {
          brokerSessionKey: params.brokerSessionKey,
          brokerTurnId: params.brokerTurnId,
          sessionId: 'claude-session-artifact',
          conversationRef: 'claude-session-artifact',
        };
      }
      throw new Error(`Unexpected Claude artifact RPC: ${method}`);
    });
    const runtime = makeRuntime({
      appServerSessionImpl: async () => lease,
      env: {
        homedir: () => '/home/tester',
        fullSnapshot: () => ({}),
        get: () => undefined,
      },
      storage: {
        readFileSync: () => '',
        statSync: () => ({}) as ReturnType<PreparedRuntime['storage']['statSync']>,
        existsSync: (path: string) => path === '/home/tester/.claude/projects',
        readdirSync: (path: string) => {
          if (path === '/home/tester/.claude/projects') {
            return [fakeDirent('-workspace', 'directory')];
          }
          if (path === '/home/tester/.claude/projects/-workspace' && artifactVisible) {
            return [fakeDirent('claude-session-artifact.jsonl', 'file')];
          }
          return [];
        },
      } as unknown as PreparedRuntime['storage'],
    });

    const eventsPromise = collectProviderEvents(executeProvider(provider, makeRequest('claude'), runtime));

    await vi.waitFor(() => {
      expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
    });

    artifactVisible = true;
    lease.emit({
      method: brokerNotificationMethods.turnCompleted,
      params: {
        brokerSessionKey: 'broker-claude-artifact',
        brokerTurnId: 'test-uuid',
        sessionId: 'claude-session-artifact',
        conversationRef: 'claude-session-artifact',
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

    expect(events).toContainEqual({
      kind: 'artifact_handle',
      handle: '/home/tester/.claude/projects/-workspace/claude-session-artifact.jsonl',
      identity: {
        kind: 'claude-jsonl',
        conversationRef: 'claude-session-artifact',
      },
    });
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
        return {};
      }
      throw new Error(`Unexpected Codex abort RPC: ${method}`);
    });
    const runtime = makeRuntime({ controller, appServerSessionImpl: async () => lease });

    const eventsPromise = collectProviderEvents(executeProvider(provider, makeRequest('codex'), runtime));

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
    expect(appServerHost.openSession).toHaveBeenCalledTimes(1);
    expect('runCli' in runtime).toBe(false);
  });
});
