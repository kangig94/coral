import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Provider,
  ProviderContinuityUpdate,
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderTransportClose,
} from '../../contract.js';
import { sessionContinuity, type SessionContinuityContract } from '../session-continuity.js';

type TestState = {
  conversationRef: string | null;
  resumable: boolean;
  providerContinuity: Record<string, unknown> | null;
};

const BASE_REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'job-session-continuity',
  name: 'claude-opus-4-7',
  prompt: 'hello',
  cwd: process.cwd(),
  bypassPermissions: false,
  coralEnv: {},
};

const TEST_PROVIDER_NAME = 'claude';

const DEV_ASSERTIONS = 'CORAL_DEV_ASSERTIONS';
const ORIGINAL_DEV_ASSERTIONS = process.env[DEV_ASSERTIONS];

afterEach(() => {
  if (ORIGINAL_DEV_ASSERTIONS === undefined) {
    delete process.env[DEV_ASSERTIONS];
    return;
  }

  process.env[DEV_ASSERTIONS] = ORIGINAL_DEV_ASSERTIONS;
});

function createRuntime(
  continuityBridge: ProviderRuntime['continuityBridge'] = {
    checkpoint: () => {},
    transportClosed: () => {},
  },
): ProviderRuntime {
  return {
    signal: new AbortController().signal,
    runCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
    acquireServer: async () => {
      throw new Error('not used in session-continuity tests');
    },
    continuityBridge,
  };
}

function cloneState(state: TestState): TestState {
  return {
    conversationRef: state.conversationRef,
    resumable: state.resumable,
    providerContinuity: state.providerContinuity === null ? null : { ...state.providerContinuity },
  };
}

function makeContract(
  options: {
    opening: TestState;
    applyUpdate?: (state: TestState, update: ProviderContinuityUpdate) => TestState;
    applyTransportClosed?: (state: TestState, closed: ProviderTransportClose) => TestState;
    isSessionUnavailable?: (err: unknown) => boolean;
  },
): SessionContinuityContract<TestState> {
  return {
    read: () => {
      const state = cloneState(options.opening);
      return {
        providerState: state,
        opening: {
          conversationRef: state.conversationRef,
          resumable: state.resumable,
          providerContinuity: state.providerContinuity,
        },
      };
    },
    applyUpdate:
      options.applyUpdate ??
      ((state, update) => ({
        conversationRef: update.conversationRef ?? state.conversationRef,
        resumable: update.resumable ?? state.resumable,
        providerContinuity:
          update.providerContinuity === undefined
            ? state.providerContinuity
            : ((update.providerContinuity as Record<string, unknown> | null) ?? null),
      })),
    snapshot: (state) => ({
      conversationRef: state.conversationRef,
      resumable: state.resumable,
      providerContinuity: state.providerContinuity,
    }),
    ...(options.applyTransportClosed ? { applyTransportClosed: options.applyTransportClosed } : {}),
    isSessionUnavailable: options.isSessionUnavailable ?? (() => false),
  };
}

function terminalEvent(content: string): ProviderEventBody {
  return {
    kind: 'terminal',
    terminal: {
      content,
      model: 'model-1',
      outcome: { kind: 'completed' },
      durationMs: 12,
      warnings: ['kept'],
    },
    diagnostics: {
      warnings: ['diag-kept'],
    },
  };
}

async function collect(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function captureThrownError(invoke: () => void): Error {
  try {
    invoke();
  } catch (error) {
    return error as Error;
  }

  throw new Error('Expected callback to throw.');
}

describe('sessionContinuity', () => {
  it('does not emit an opening continuity snapshot when no live delta occurs', async () => {
    const downstreamTerminal = terminalEvent('resumable');
    const provider: Provider = async function* openingResumableProvider() {
      yield downstreamTerminal;
    };

    const events = await collect(
      sessionContinuity(
        TEST_PROVIDER_NAME,
        makeContract({
          opening: {
            conversationRef: 'abc',
            resumable: true,
            providerContinuity: { thread: 'abc' },
          },
        }),
      )(provider)(BASE_REQUEST, createRuntime()),
    );

    expect(events).toEqual([downstreamTerminal]);
    expect(events.filter((event) => event.kind === 'continuity')).toHaveLength(0);
  });

  it('does not emit opening continuity for non-resumable persisted state without a live delta', async () => {
    const provider: Provider = async function* openingNonResumableProvider() {
      yield terminalEvent('non-resumable');
    };

    const events = await collect(
      sessionContinuity(
        TEST_PROVIDER_NAME,
        makeContract({
          opening: {
            conversationRef: null,
            resumable: false,
            providerContinuity: null,
          },
        }),
      )(provider)(BASE_REQUEST, createRuntime()),
    );

    expect(events).toEqual([terminalEvent('non-resumable')]);
  });

  it('maps session-unavailable errors to a terminal fault without synthesizing opening continuity', async () => {
    const unavailable = new Error('session missing');
    let invocations = 0;
    const downstreamReachedTerminal = false;
    const provider: Provider = async function* unavailableProvider() {
      invocations += 1;
      if (downstreamReachedTerminal) {
        yield terminalEvent('unexpected');
      }
      throw unavailable;
    };

    const events = await collect(
      sessionContinuity(
        TEST_PROVIDER_NAME,
        makeContract({
          opening: {
            conversationRef: 'persisted-1',
            resumable: true,
            providerContinuity: { thread: 'persisted-1' },
          },
          isSessionUnavailable: (err) => err === unavailable,
        }),
      )(provider)(BASE_REQUEST, createRuntime()),
    );

    expect(invocations).toBe(1);
    expect(downstreamReachedTerminal).toBe(false);
    expect(events).toEqual([
      {
        kind: 'terminal',
        terminal: {
          content: '',
          outcome: {
            kind: 'failed',
            fault: {
              kind: 'provider_session_unavailable',
              provider: 'claude',
              reason: 'session missing',
            },
          },
        },
        diagnostics: {},
      },
    ]);
  });

  it('passes downstream terminals through unmodified when no final continuity delta exists', async () => {
    const downstreamTerminal = terminalEvent('pass-through');
    const provider: Provider = async function* passthroughProvider() {
      yield downstreamTerminal;
    };

    const events = await collect(
      sessionContinuity(
        TEST_PROVIDER_NAME,
        makeContract({
          opening: {
            conversationRef: 'stable',
            resumable: true,
            providerContinuity: { thread: 'stable' },
          },
        }),
      )(provider)(BASE_REQUEST, createRuntime()),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(downstreamTerminal);
    expect(events).toEqual([downstreamTerminal]);
  });

  it('emits final continuity from live bridge checkpoints before the downstream terminal', async () => {
    let baseCheckpointCalls = 0;
    let baseTransportClosedCalls = 0;
    const outerRuntime = createRuntime({
      checkpoint: () => {
        baseCheckpointCalls += 1;
      },
      transportClosed: () => {
        baseTransportClosedCalls += 1;
      },
    });
    let bridgeInsideProvider: ProviderRuntime['continuityBridge'] | null = null;
    const downstreamTerminal = terminalEvent('checkpointed');
    const provider: Provider = async function* checkpointProvider(_request, runtime) {
      bridgeInsideProvider = runtime.continuityBridge;
      runtime.continuityBridge.checkpoint({
        conversationRef: 'live-1',
        resumable: true,
        providerContinuity: { thread: 'live-1', phase: 'updated' },
      });
      yield downstreamTerminal;
    };

    const events = await collect(
      sessionContinuity(
        TEST_PROVIDER_NAME,
        makeContract({
          opening: {
            conversationRef: null,
            resumable: false,
            providerContinuity: { phase: 'opening' },
          },
        }),
      )(provider)(BASE_REQUEST, outerRuntime),
    );

    expect(bridgeInsideProvider).not.toBeNull();
    expect(bridgeInsideProvider).not.toBe(outerRuntime.continuityBridge);
    expect(baseCheckpointCalls).toBe(0);
    expect(baseTransportClosedCalls).toBe(0);
    expect(events).toEqual([
      {
        kind: 'continuity',
        conversationRef: 'live-1',
        resumable: true,
        providerContinuity: { thread: 'live-1', phase: 'updated' },
      },
      downstreamTerminal,
    ]);
  });

  it('translates transport-closed state into a final continuity body here before the downstream terminal', async () => {
    const downstreamTerminal = terminalEvent('closed');
    const provider: Provider = async function* transportClosedProvider(_request, runtime) {
      runtime.continuityBridge.transportClosed({
        kind: 'transport_closed',
        error: new Error('socket closed'),
      });
      yield downstreamTerminal;
    };

    const events = await collect(
      sessionContinuity(
        TEST_PROVIDER_NAME,
        makeContract({
          opening: {
            conversationRef: 'conversation-1',
            resumable: true,
            providerContinuity: { closeKind: 'open' },
          },
          applyTransportClosed: (state, closed) => ({
            conversationRef: state.conversationRef,
            resumable: false,
            providerContinuity: { closeKind: closed.kind },
          }),
        }),
      )(provider)(BASE_REQUEST, createRuntime()),
    );

    expect(events).toEqual([
      {
        kind: 'continuity',
        conversationRef: 'conversation-1',
        resumable: false,
        providerContinuity: { closeKind: 'transport_closed' },
      },
      downstreamTerminal,
    ]);
  });

  it('treats post-deactivation bridge calls as silent no-ops in production', async () => {
    let capturedBridge: ProviderRuntime['continuityBridge'] | null = null;
    const provider: Provider = async function* postDeactivationProdProvider(_request, runtime) {
      capturedBridge = runtime.continuityBridge;
      yield terminalEvent('prod');
    };

    await collect(
      sessionContinuity(
        TEST_PROVIDER_NAME,
        makeContract({
          opening: {
            conversationRef: null,
            resumable: false,
            providerContinuity: null,
          },
        }),
      )(provider)(BASE_REQUEST, createRuntime()),
    );

    expect(capturedBridge).not.toBeNull();
    expect(() => {
      capturedBridge?.checkpoint({ conversationRef: 'stale-prod' });
      capturedBridge?.transportClosed({ kind: 'transport_closed' });
    }).not.toThrow();
  });

  it('throws assertion errors for post-deactivation bridge calls when CORAL_DEV_ASSERTIONS=1', async () => {
    process.env[DEV_ASSERTIONS] = '1';
    vi.resetModules();
    const { sessionContinuity: sessionContinuityWithAssertions } = await import('../session-continuity.js');

    let capturedBridge: ProviderRuntime['continuityBridge'] | null = null;
    const provider: Provider = async function* postDeactivationAssertProvider(_request, runtime) {
      capturedBridge = runtime.continuityBridge;
      yield terminalEvent('assert');
    };

    await collect(
      sessionContinuityWithAssertions(
        TEST_PROVIDER_NAME,
        makeContract({
          opening: {
            conversationRef: null,
            resumable: false,
            providerContinuity: null,
          },
        }),
      )(provider)(BASE_REQUEST, createRuntime()),
    );

    expect(capturedBridge).not.toBeNull();
    const checkpointAssertion = captureThrownError(() => {
      capturedBridge?.checkpoint({ conversationRef: 'stale-assert' });
    });
    expect(checkpointAssertion.message).toMatch(/runtime\.continuityBridge\.checkpoint\(\)/);
    expect(checkpointAssertion.message).toContain('Bridge creation stack:');
    expect(checkpointAssertion.message).toContain('Continuity bridge created here.');
    expect(checkpointAssertion.message).toContain('Bridge deactivation stack:');
    expect(checkpointAssertion.message).toContain('Continuity bridge deactivated here.');
    expect(checkpointAssertion.message).toContain(
      'cancel delayed callbacks or stop emitting after the provider iterator returns',
    );

    const transportClosedAssertion = captureThrownError(() => {
      capturedBridge?.transportClosed({ kind: 'transport_closed' });
    });
    expect(transportClosedAssertion.message).toMatch(/runtime\.continuityBridge\.transportClosed\(\)/);
  });
});
