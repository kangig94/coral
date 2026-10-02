import { describe, expect, it, vi } from 'vitest';

import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderRequest,
} from '#src/providers/contract.js';
import { collectProviderEvents } from '#src/providers/stream.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
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
  readonly started: Promise<void>;
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
  cwd: fixtureCanonicalWorkDir('/workspace'),
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
  const started = createDeferred<void>();
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
      started.resolve();
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
    started: started.promise,
    rpc: rpcMock as unknown as AppServerSession['rpc'],
    subscribe: (handler) => {
      notificationHandler = handler;
      return () => {
        notificationHandler = null;
      };
    },
    closed: new Promise<Error | void>(() => {}),
    interrupt: (continuity) =>
      Promise.resolve(rpcMock('turn/interrupt', continuity)).then(() => ({ kind: 'accepted' as const })),
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
    onProviderTurnTerminal: vi.fn(),
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

  it.each([['cwd', '/other-workspace']] as const)(
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
          disposition: 'observed-absent',
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
    const startEntered = createDeferred<void>();
    const checkpointEntered = createDeferred<void>();
    const interruptEntered = createDeferred<void>();
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
          startEntered.resolve();
          return startGate.promise;
        }
        if (method === 'turn/interrupt') {
          interruptEntered.resolve();
          return {
            brokerTurnId: params.brokerTurnId,
            interrupted: true,
          };
        }
        throw new Error(`Unexpected Claude diagnostic RPC: ${method}`);
      }) as AppServerSession['rpc'],
      interrupt: async (continuity) => {
        await lease.rpc('turn/interrupt', continuity);
        return { kind: 'accepted' };
      },
    };
    const runtime = makeRuntime(controller);
    runtime.continuityBridge.checkpoint = vi.fn((update) => {
      if (update.providerContinuity?.brokerTurnId === undefined) return;
      checkpointEntered.resolve();
      return activeCheckpointGate.promise;
    });
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await checkpointEntered.promise;
      expect(lease.rpcMock).not.toHaveBeenCalledWith('turn/start', expect.any(Object));

      activeCheckpointGate.resolve();
      await startEntered.promise;
      controller.abort();
      await interruptEntered.promise;
      lease.emit({
        method: brokerNotificationMethods.turnFailed,
        params: {
          brokerSessionKey: 'broker-claude-diagnostic',
          brokerTurnId: 'claude-turn-diagnostic',
          message: 'Claude child exited after interruption.',
        },
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

  it('materializes a broker turn diagnostic into the provider failure cause', async () => {
    const lease = makeLease();
    const runtime = makeRuntime();
    const clearLease = bindSession(runtime, lease);

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(REQUEST, runtime));

      await lease.started;
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

      await lease.started;
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
});
