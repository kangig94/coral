import { describe, expect, it, vi } from 'vitest';

import { bindAppServerLease, getAppServerNotificationHandler } from '#src/providers/app-server.js';
import type {
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
} from '#src/providers/contract.js';
import { collectProviderEvents } from '#src/providers/stream.js';
import { brokerNotificationMethods, type TurnFailureDiagnostic } from '#src/providers/claude/appserver/protocol.js';
import { claudeSessionKernel } from '#src/providers/claude/session-kernel.js';
import { createDeferred } from '#tools/testing/deferred.js';

type MockLease = ProviderServerLease & {
  readonly rpcMock: ReturnType<typeof vi.fn>;
};

const BOOTSTRAP_SIGNATURE = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:test',
  permissionMode: 'default',
} as const;

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
  schemaVersion: 1,
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
  const rpcMock = vi.fn(async (method: string) => {
    if (method === 'session/ensure') {
      return {
        brokerSessionKey: 'broker-claude-diagnostic',
        bootstrapSignature: BOOTSTRAP_SIGNATURE,
        sessionId: 'claude-session-diagnostic',
        conversationRef: 'claude-session-diagnostic',
      };
    }
    if (method === 'turn/start') {
      return {
        brokerTurnId: 'claude-turn-diagnostic',
        sessionId: 'claude-session-diagnostic',
        conversationRef: 'claude-session-diagnostic',
      };
    }
    throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
  });

  return {
    rpc: rpcMock as unknown as ProviderServerLease['rpc'],
    subscribe: () => () => {},
    release: () => {},
    closed: new Promise<Error | void>(() => {}),
    rpcMock,
  };
}

function makeRuntime(): ProviderRuntime {
  return {
    signal: new AbortController().signal,
    runCli: async () => {
      throw new Error('runCli should not be used by the Claude appserver kernel.');
    },
    time: {
      now: () => 1_000,
      setTimeout: () => ({ unref: () => {} }),
      clearTimeout: () => {},
    } as ProviderRuntime['time'],
    storage: {
      existsSync: () => false,
      readFileSync: () => '',
      statSync: () => ({}) as ReturnType<ProviderRuntime['storage']['statSync']>,
      readdirSync: () => [],
    } as unknown as ProviderRuntime['storage'],
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:test' },
    acquireServer: async () => {
      throw new Error('acquireServer should already be bound by app-server middleware.');
    },
    continuityBridge: {
      checkpoint: vi.fn(),
      transportClosed: vi.fn(),
    },
    kbRoot: '/mock/kb',
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

describe('Claude session-kernel turn failure diagnostics', () => {
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
            bootstrapSignature: BOOTSTRAP_SIGNATURE,
            sessionId: 'claude-session-diagnostic',
            conversationRef: 'claude-session-diagnostic',
          };
        }
        if (method === 'turn/start') {
          return startGate.promise;
        }
        throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
      }) as ProviderServerLease['rpc'],
    };
    const runtime = makeRuntime();
    const clearLease = bindAppServerLease(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });

      getAppServerNotificationHandler(runtime)?.({
        method: brokerNotificationMethods.turnCompleted,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'stale-turn',
          result: 'stale result',
        },
      });

      startGate.resolve({
        brokerTurnId: 'test-uuid',
        sessionId: 'claude-session-diagnostic',
        conversationRef: 'claude-session-diagnostic',
      });

      getAppServerNotificationHandler(runtime)?.({
        method: brokerNotificationMethods.turnCompleted,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'test-uuid',
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
    const clearLease = bindAppServerLease(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });

      getAppServerNotificationHandler(runtime)?.({
        method: brokerNotificationMethods.turnCompleted,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          result: 'missing turn id result',
        },
      });

      getAppServerNotificationHandler(runtime)?.({
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

  it('materializes a broker turn diagnostic into the provider failure cause', async () => {
    const lease = makeLease();
    const runtime = makeRuntime();
    const clearLease = bindAppServerLease(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await vi.waitFor(() => {
        expect(lease.rpcMock).toHaveBeenCalledWith('turn/start', expect.any(Object));
      });

      const handler = getAppServerNotificationHandler(runtime);
      expect(handler).toBeDefined();
      handler?.({
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
});
