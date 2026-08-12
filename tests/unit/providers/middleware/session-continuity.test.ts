import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AppServerSession,
  Provider,
  ProviderAppServerRuntime,
  ProviderContinuityUpdate,
  ProviderEventBody,
  ProviderRequest,
  ProviderStandaloneRuntime,
} from '#src/providers/contract.js';
import type { ProviderTransportClose } from '#src/providers/protocol.js';
import type { CodexExecutionPlan } from '#src/providers/codex/execution-plan.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { commitContinuityEvent, rejectContinuityEvent } from '#src/providers/internal/continuity-commit.js';
import { sessionContinuity, type SessionContinuityContract } from '#src/providers/middleware/session-continuity.js';
import { TEST_CODEX_PLAN } from '../../../helpers/provider-credentials.js';

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
  cwd: fixtureCanonicalWorkDir(process.cwd()),
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

type CodexAppServerRuntime = ProviderAppServerRuntime<CodexExecutionPlan>;
type CodexStandaloneRuntime = ProviderStandaloneRuntime<CodexExecutionPlan>;
type CodexRuntimeCommon = Omit<CodexStandaloneRuntime, 'runCli' | 'transport'>;

function createRuntimeCommon(continuityBridge: CodexStandaloneRuntime['continuityBridge']): CodexRuntimeCommon {
  return {
    signal: new AbortController().signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    storage: { existsSync: () => true } as unknown as CodexStandaloneRuntime['storage'],
    continuityBridge,
    kbRoot: '/mock/kb',
    executionPlan: TEST_CODEX_PLAN,
  };
}

function createRuntime(
  continuityBridge: CodexStandaloneRuntime['continuityBridge'] = {
    checkpoint: () => {},
    transportClosed: () => {},
  },
  overrides: Partial<CodexRuntimeCommon> = {},
): CodexStandaloneRuntime {
  return {
    ...createRuntimeCommon(continuityBridge),
    transport: 'standalone',
    runCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
    ...overrides,
  };
}

function createAppServerRuntime(
  appServerSession: AppServerSession,
  continuityBridge: CodexAppServerRuntime['continuityBridge'],
): CodexAppServerRuntime {
  return {
    ...createRuntimeCommon(continuityBridge),
    transport: 'app-server',
    appServerSession,
    onProviderTurnTerminal: () => {},
  };
}

function cloneState(state: TestState): TestState {
  return {
    conversationRef: state.conversationRef,
    resumable: state.resumable,
    providerContinuity: state.providerContinuity === null ? null : { ...state.providerContinuity },
  };
}

function makeContract(options: {
  opening: TestState;
  applyUpdate?: (state: TestState, update: ProviderContinuityUpdate) => TestState;
  applyTransportClosed?: (state: TestState, closed: ProviderTransportClose) => TestState;
  isSessionUnavailable?: (err: unknown) => boolean;
}): SessionContinuityContract<TestState> {
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('sessionContinuity', () => {
  it('does not emit an opening continuity snapshot when no live delta occurs', async () => {
    const downstreamTerminal = terminalEvent('resumable');
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* openingResumableProvider() {
      yield downstreamTerminal;
    };

    const events = await collect(
      sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
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
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> =
      async function* openingNonResumableProvider() {
        yield terminalEvent('non-resumable');
      };

    const events = await collect(
      sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
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
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* unavailableProvider() {
      invocations += 1;
      if (downstreamReachedTerminal) {
        yield terminalEvent('unexpected');
      }
      throw unavailable;
    };

    const events = await collect(
      sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
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
          durationMs: expect.any(Number),
          outcome: { kind: 'failed' },
        },
        diagnostics: {},
        failureCause: {
          type: 'session.provider_failed',
          body: {
            provider: 'claude',
            reason: 'session_unavailable',
            message: 'session missing',
          },
        },
      },
    ]);
  });

  it('passes downstream terminals through unmodified when no final continuity delta exists', async () => {
    const downstreamTerminal = terminalEvent('pass-through');
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* passthroughProvider() {
      yield downstreamTerminal;
    };

    const events = await collect(
      sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
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
    let bridgeInsideProvider: CodexStandaloneRuntime['continuityBridge'] | null = null;
    const downstreamTerminal = terminalEvent('checkpointed');
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* checkpointProvider(
      _request,
      runtime,
    ) {
      bridgeInsideProvider = runtime.continuityBridge;
      runtime.continuityBridge.checkpoint({
        conversationRef: 'live-1',
        resumable: true,
        providerContinuity: { thread: 'live-1', phase: 'updated' },
      });
      yield downstreamTerminal;
    };

    const events = await collect(
      sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
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

  it('waits for the consumer to commit an emitted checkpoint before advancing the provider', async () => {
    let checkpointPersisted = false;
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* blockingCheckpointProvider(
      _request,
      runtime,
    ) {
      await runtime.continuityBridge.checkpoint({
        conversationRef: 'durable-before-rpc',
        resumable: true,
        providerContinuity: { turn: 'turn-before-rpc' },
      });
      checkpointPersisted = true;
      yield { kind: 'progress', message: 'rpc may start now' };
      yield terminalEvent('done');
    };
    const iterator = sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
      TEST_PROVIDER_NAME,
      makeContract({
        opening: { conversationRef: null, resumable: false, providerContinuity: null },
      }),
    )(provider)(BASE_REQUEST, createRuntime())[Symbol.asyncIterator]();

    const checkpoint = await iterator.next();
    expect(checkpoint).toEqual({
      done: false,
      value: {
        kind: 'continuity',
        conversationRef: 'durable-before-rpc',
        resumable: true,
        providerContinuity: { turn: 'turn-before-rpc' },
      },
    });
    expect(checkpointPersisted).toBe(false);
    if (checkpoint.done || checkpoint.value.kind !== 'continuity') {
      throw new Error('Expected a continuity checkpoint.');
    }
    commitContinuityEvent(checkpoint.value);

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: 'progress', message: 'rpc may start now' },
    });
    expect(checkpointPersisted).toBe(true);
    await iterator.return?.();
  });

  it('shares the outstanding receipt when identical checkpoints are coalesced', async () => {
    let secondCommitted = false;
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* duplicateCheckpointProvider(
      _request,
      runtime,
    ) {
      const update = {
        conversationRef: 'duplicate',
        resumable: true,
        providerContinuity: { turnId: 'turn-duplicate' },
      } as const;
      const first = runtime.continuityBridge.checkpoint(update);
      const second = Promise.resolve(runtime.continuityBridge.checkpoint(update)).then(() => {
        secondCommitted = true;
      });
      await Promise.all([first, second]);
      yield terminalEvent('duplicate committed once');
    };
    const iterator = sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
      TEST_PROVIDER_NAME,
      makeContract({ opening: { conversationRef: null, resumable: false, providerContinuity: null } }),
    )(provider)(BASE_REQUEST, createRuntime())[Symbol.asyncIterator]();

    const checkpoint = await iterator.next();
    expect(secondCommitted).toBe(false);
    if (checkpoint.done || checkpoint.value.kind !== 'continuity') throw new Error('Expected continuity event.');
    commitContinuityEvent(checkpoint.value);

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: terminalEvent('duplicate committed once'),
    });
    expect(secondCommitted).toBe(true);
    await iterator.next();
  });

  it('poisons the checkpoint queue after rejection so the same snapshot cannot become a false no-op success', async () => {
    const rejected = new Error('stale continuity claim');
    const observed: unknown[] = [];
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* retryingProvider(
      _request,
      runtime,
    ) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await runtime.continuityBridge.checkpoint({
            conversationRef: 'same-snapshot',
            resumable: true,
            providerContinuity: { turnId: 'turn-1' },
          });
        } catch (error) {
          observed.push(error);
        }
      }
      yield terminalEvent('stopped after rejected durability');
    };
    const iterator = sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
      TEST_PROVIDER_NAME,
      makeContract({ opening: { conversationRef: null, resumable: false, providerContinuity: null } }),
    )(provider)(BASE_REQUEST, createRuntime())[Symbol.asyncIterator]();

    const checkpoint = await iterator.next();
    if (checkpoint.done || checkpoint.value.kind !== 'continuity') throw new Error('Expected continuity event.');
    rejectContinuityEvent(checkpoint.value, rejected);

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: terminalEvent('stopped after rejected durability'),
    });
    expect(observed).toEqual([rejected, rejected]);
    await iterator.next();
  });

  it('rejects an outstanding checkpoint before closing its downstream iterator', async () => {
    let providerFinalized = false;
    let observedRejection: unknown;
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* suspendedProvider(
      _request,
      runtime,
    ) {
      try {
        await runtime.continuityBridge.checkpoint({ conversationRef: 'uncommitted', resumable: true });
      } catch (error) {
        observedRejection = error;
      } finally {
        providerFinalized = true;
      }
    };
    const iterator = sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
      TEST_PROVIDER_NAME,
      makeContract({ opening: { conversationRef: null, resumable: false, providerContinuity: null } }),
    )(provider)(BASE_REQUEST, createRuntime())[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: 'continuity' } });
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    expect(providerFinalized).toBe(true);
    expect(observedRejection).toBeInstanceOf(Error);
  });

  it('uses the middleware bridge when the app-server transport closes before provider next settles', async () => {
    const closed = deferred<Error | void>();
    const releaseProvider = deferred<void>();
    const appServerSession: AppServerSession = {
      rpc: async <R>() => ({}) as R,
      subscribe: () => () => {},
      closed: closed.promise,
      interrupt: async () => ({ kind: 'not-accepted', reason: 'test refusal' }),
    };
    const provider: Provider<CodexExecutionPlan, CodexAppServerRuntime> = async function* blockedProvider() {
      await releaseProvider.promise;
      yield terminalEvent('closed cleanly');
    };
    const runtime = createAppServerRuntime(appServerSession, {
      checkpoint: () => {
        throw new Error('outer NOOP checkpoint invoked');
      },
      transportClosed: () => {
        throw new Error('outer NOOP transport bridge invoked');
      },
    });
    const iterator = sessionContinuity<TestState, CodexExecutionPlan, CodexAppServerRuntime>(
      TEST_PROVIDER_NAME,
      makeContract({
        opening: {
          conversationRef: 'transport-session',
          resumable: true,
          providerContinuity: { transport: 'open' },
        },
        applyTransportClosed: (state) => ({
          ...state,
          resumable: false,
          providerContinuity: { transport: 'closed' },
        }),
      }),
    )(provider)(BASE_REQUEST, runtime)[Symbol.asyncIterator]();

    const first = iterator.next();
    closed.resolve(new Error('socket closed'));
    await expect(first).resolves.toEqual({
      done: false,
      value: {
        kind: 'continuity',
        conversationRef: 'transport-session',
        resumable: false,
        providerContinuity: { transport: 'closed' },
      },
    });
    releaseProvider.resolve();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: terminalEvent('closed cleanly') });
    await iterator.next();
  });

  it('keeps exactly one downstream next pending across repeated checkpoint wakes', async () => {
    const downstream = deferred<IteratorResult<ProviderEventBody>>();
    let downstreamNextCalls = 0;
    let downstreamReturnCalls = 0;
    let bridge!: CodexStandaloneRuntime['continuityBridge'];
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = (_request, runtime) => {
      bridge = runtime.continuityBridge;
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              downstreamNextCalls += 1;
              if (downstreamNextCalls > 1) throw new Error('concurrent downstream next');
              return downstream.promise;
            },
            async return() {
              downstreamReturnCalls += 1;
              return { done: true, value: undefined };
            },
          };
        },
      };
    };
    const iterator = sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
      TEST_PROVIDER_NAME,
      makeContract({
        opening: { conversationRef: null, resumable: false, providerContinuity: null },
      }),
    )(provider)(BASE_REQUEST, createRuntime())[Symbol.asyncIterator]();

    const first = iterator.next();
    await vi.waitFor(() => expect(downstreamNextCalls).toBe(1));
    void bridge.checkpoint({ conversationRef: 'checkpoint-1', resumable: true });
    await expect(first).resolves.toMatchObject({ value: { kind: 'continuity', conversationRef: 'checkpoint-1' } });
    expect(downstreamNextCalls).toBe(1);

    void bridge.checkpoint({ conversationRef: 'checkpoint-2', resumable: true });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: 'continuity', conversationRef: 'checkpoint-2' },
    });
    expect(downstreamNextCalls).toBe(1);

    downstream.resolve({ done: false, value: terminalEvent('single pending') });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: terminalEvent('single pending') });
    await iterator.next();
    expect(downstreamNextCalls).toBe(1);
    expect(downstreamReturnCalls).toBe(1);
  });

  it('closes the downstream iterator after a protocol terminal event', async () => {
    let finalized = false;
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* terminalWithFinally() {
      try {
        yield terminalEvent('terminal');
        await new Promise<never>(() => {});
      } finally {
        finalized = true;
      }
    };

    await collect(
      sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
        TEST_PROVIDER_NAME,
        makeContract({ opening: { conversationRef: null, resumable: false, providerContinuity: null } }),
      )(provider)(BASE_REQUEST, createRuntime()),
    );

    expect(finalized).toBe(true);
  });

  it('translates transport-closed state into a final continuity body here before the downstream terminal', async () => {
    const downstreamTerminal = terminalEvent('closed');
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* transportClosedProvider(
      _request,
      runtime,
    ) {
      runtime.continuityBridge.transportClosed({
        kind: 'transport_closed',
        error: new Error('socket closed'),
      });
      yield downstreamTerminal;
    };

    const events = await collect(
      sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
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
    let capturedBridge: CodexStandaloneRuntime['continuityBridge'] | null = null;
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> = async function* postDeactivationProdProvider(
      _request,
      runtime,
    ) {
      capturedBridge = runtime.continuityBridge;
      yield terminalEvent('prod');
    };

    await collect(
      sessionContinuity<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
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
    const { sessionContinuity: sessionContinuityWithAssertions } =
      await import('#src/providers/middleware/session-continuity.js');

    let capturedBridge: CodexStandaloneRuntime['continuityBridge'] | null = null;
    const provider: Provider<CodexExecutionPlan, CodexStandaloneRuntime> =
      async function* postDeactivationAssertProvider(_request, runtime) {
        capturedBridge = runtime.continuityBridge;
        yield terminalEvent('assert');
      };

    await collect(
      sessionContinuityWithAssertions<TestState, CodexExecutionPlan, CodexStandaloneRuntime>(
        TEST_PROVIDER_NAME,
        makeContract({
          opening: {
            conversationRef: null,
            resumable: false,
            providerContinuity: null,
          },
        }),
      )(provider)(
        BASE_REQUEST,
        createRuntime(undefined, {
          env: {
            get: (key) => (key === DEV_ASSERTIONS ? '1' : undefined),
            homedir: () => '/mock/home',
            fullSnapshot: () => ({}),
          },
        }),
      ),
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
