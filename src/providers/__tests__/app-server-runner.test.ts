import { describe, expect, it, vi } from 'vitest';
import type { ProviderRequest } from '../../shared/types.js';
import type { AppServerSessionDriver, DriverStepOutcome, TurnOutcome } from '../app-server/driver.js';
import { runAppServerTurn } from '../app-server/runner.js';
import type { ProviderRuntime, ProviderServerLease } from '../types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'run',
    cwd: '/workspace',
    effort: 'high',
    bypassPermissions: true,
    coralEnv: {},
    ...overrides,
  };
}

function makeLease(options: { unsubscribeThrows?: boolean } = {}): ProviderServerLease & {
  emit(message: { method: string; params?: Record<string, unknown> }): void;
  close(outcome?: Error | void): void;
  subscribeMock: ReturnType<typeof vi.fn>;
  releaseMock: ReturnType<typeof vi.fn>;
} {
  let handler: ((message: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  const closedDeferred = deferred<Error | void>();
  const subscribeMock = vi.fn((next: (message: { method: string; params?: Record<string, unknown> }) => void) => {
    handler = next;
    return () => {
      handler = null;
      if (options.unsubscribeThrows) {
        throw new Error('unsubscribe failed');
      }
    };
  });
  const releaseMock = vi.fn();

  return {
    rpc: vi.fn(),
    subscribe: subscribeMock as unknown as ProviderServerLease['subscribe'],
    release: releaseMock,
    closed: closedDeferred.promise,
    subscribeMock,
    releaseMock,
    emit(message) {
      handler?.(message);
    },
    close(outcome) {
      closedDeferred.resolve(outcome);
    },
  };
}

function makeRuntime(lease: ProviderServerLease, controller = new AbortController()): ProviderRuntime & {
  acquireServer: ReturnType<typeof vi.fn>;
  checkpointRecovery: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
} {
  const checkpointRecovery = vi.fn();
  const onEvent = vi.fn();
  return {
    signal: controller.signal,
    onEvent,
    runCli: vi.fn(),
    acquireServer: vi.fn(async () => lease),
    checkpointRecovery,
    persistedContinuity: undefined,
  };
}

type TestState = {
  ctxNotifications: string[];
  value: string;
  terminal: ReturnType<typeof deferred<TurnOutcome>>;
  interruptReady: boolean;
  interruptCalls: number;
  refs: {
    created?: TestState;
    apply?: TestState;
    await?: TestState;
    finalize?: TestState;
  };
  finalizeOutcomes: TurnOutcome[];
};

function createDriver(options: {
  subscriptionPhase?: 'beforeInitialize' | 'afterInitialize';
  initialize?: (state: TestState, ctx: { lease: ProviderServerLease }) => Promise<DriverStepOutcome>;
  startTurn?: (state: TestState) => Promise<DriverStepOutcome>;
  applyNotification?: (state: TestState, message: { method: string; params?: Record<string, unknown> }) => void;
  awaitTurnOutcome?: (state: TestState) => Promise<TurnOutcome>;
  requestInterrupt?: (state: TestState) => Promise<void>;
  onTransportClosed?: (state: TestState, outcome: Error | void) => TurnOutcome;
  finalize?: (state: TestState, outcome: TurnOutcome) => ReturnType<AppServerSessionDriver<TestState>['finalize']>;
} = {}): { driver: AppServerSessionDriver<TestState>; stateRef: () => TestState | undefined } {
  let stateRef: TestState | undefined;

  return {
    stateRef: () => stateRef,
    driver: {
      name: 'runner-test',
      faultProviderName: 'claude',
      subscriptionPhase: options.subscriptionPhase ?? 'beforeInitialize',
      buildServerSpec() {
        return {
          provider: 'runner-test',
          command: 'echo',
          args: [],
          cwd: '/workspace',
        };
      },
      createInitialState() {
        const state: TestState = {
          ctxNotifications: [],
          value: '',
          terminal: deferred<TurnOutcome>(),
          interruptReady: false,
          interruptCalls: 0,
          refs: {},
          finalizeOutcomes: [],
        };
        state.refs.created = state;
        stateRef = state;
        return state;
      },
      async initialize(ctx, state) {
        return options.initialize?.(state, { lease: ctx.lease }) ?? {};
      },
      async startTurn(_ctx, state) {
        return options.startTurn?.(state) ?? {};
      },
      applyNotification(state, message) {
        state.refs.apply = state;
        state.ctxNotifications.push(message.method);
        if (message.method === 'set-value' && typeof message.params?.value === 'string') {
          state.value = message.params.value;
        }
        options.applyNotification?.(state, message);
      },
      async awaitTurnOutcome(state) {
        state.refs.await = state;
        return options.awaitTurnOutcome?.(state) ?? state.terminal.promise;
      },
      async requestInterrupt(_ctx, state) {
        if (!state.interruptReady) {
          return;
        }
        state.interruptCalls += 1;
        await options.requestInterrupt?.(state);
      },
      onTransportClosed(state, outcome) {
        return (
          options.onTransportClosed?.(state, outcome) ?? {
            kind: 'failed',
            message: outcome instanceof Error ? outcome.message : 'closed',
          }
        );
      },
      finalize(state, outcome) {
        state.refs.finalize = state;
        state.finalizeOutcomes.push(outcome);
        if (options.finalize) {
          return options.finalize(state, outcome);
        }
        if (outcome.kind === 'completed') {
          return {
            content:
              state.value ||
              (typeof outcome.turn === 'string' ? outcome.turn : 'completed'),
            outcome: { kind: 'completed' },
          };
        }
        if (outcome.kind === 'aborted') {
          return { content: '', outcome: { kind: 'aborted', reason: outcome.reason } };
        }
        if (outcome.kind === 'nonResumable') {
          return {
            content: '',
            nonResumable: true,
            outcome: {
              kind: 'coral_fault',
              fault: {
                kind: 'provider_session_unavailable',
                provider: 'claude',
                note: outcome.message,
              },
            },
          };
        }
        return {
          content: '',
          exitCode: 1,
          outcome: {
            kind: 'coral_fault',
            fault: {
              kind: 'provider_request_failed',
              provider: 'claude',
              message: outcome.message,
            },
          },
        };
      },
    },
  };
}

describe('runAppServerTurn', () => {
  it('subscribes before initialize for beforeInitialize drivers', async () => {
    const lease = makeLease();
    const { driver } = createDriver({
      subscriptionPhase: 'beforeInitialize',
      async initialize(state, ctx) {
        state.value = `subscribed:${String((ctx.lease as typeof lease).subscribeMock.mock.calls.length)}`;
        return { terminal: { kind: 'completed', turn: 'done' } };
      },
    });

    const result = await runAppServerTurn(driver, makeRequest(), makeRuntime(lease));

    expect(lease.subscribeMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ content: 'subscribed:1' });
  });

  it('subscribes after initialize for afterInitialize drivers', async () => {
    const lease = makeLease();
    const { driver } = createDriver({
      subscriptionPhase: 'afterInitialize',
      async initialize(state, ctx) {
        state.value = `subscribed:${String((ctx.lease as typeof lease).subscribeMock.mock.calls.length)}`;
        return {};
      },
      async startTurn(state) {
        return { terminal: { kind: 'completed', turn: state.value } };
      },
    });

    const result = await runAppServerTurn(driver, makeRequest(), makeRuntime(lease));

    expect(lease.subscribeMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ content: 'subscribed:0' });
  });

  it('returns initialize-terminal outcomes without starting a turn', async () => {
    const lease = makeLease();
    const startTurn = vi.fn();
    const { driver } = createDriver({
      subscriptionPhase: 'afterInitialize',
      async initialize() {
        return { terminal: { kind: 'nonResumable', message: 'missing-thread' } };
      },
      async startTurn(state) {
        startTurn(state);
        return {};
      },
    });

    const result = await runAppServerTurn(driver, makeRequest({ action: 'resume' }), makeRuntime(lease));

    expect(startTurn).not.toHaveBeenCalled();
    expect(lease.subscribeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      nonResumable: true,
      outcome: {
        kind: 'coral_fault',
        fault: {
          kind: 'provider_session_unavailable',
          provider: 'claude',
          note: 'missing-thread',
        },
      },
    });
  });

  it('returns immediate terminal outcomes from startTurn', async () => {
    const lease = makeLease();
    const awaitTurnOutcome = vi.fn();
    const { driver } = createDriver({
      subscriptionPhase: 'afterInitialize',
      async startTurn() {
        return { terminal: { kind: 'completed', turn: 'immediate-terminal' } };
      },
      async awaitTurnOutcome(state) {
        awaitTurnOutcome(state);
        return state.terminal.promise;
      },
    });

    const result = await runAppServerTurn(driver, makeRequest(), makeRuntime(lease));

    expect(awaitTurnOutcome).not.toHaveBeenCalled();
    expect(result).toMatchObject({ content: 'immediate-terminal' });
  });

  it('honors abort at the post-initialize checkpoint without cancelling initialize', async () => {
    const lease = makeLease();
    const controller = new AbortController();
    const initializeDeferred = deferred<DriverStepOutcome>();
    const startTurn = vi.fn();
    const { driver, stateRef } = createDriver({
      async initialize(state) {
        state.value = 'initialize-in-flight';
        return initializeDeferred.promise;
      },
      async startTurn(state) {
        startTurn(state);
        return {};
      },
    });

    const execution = runAppServerTurn(driver, makeRequest(), makeRuntime(lease, controller));

    controller.abort();
    initializeDeferred.resolve({});

    await expect(execution).resolves.toMatchObject({ outcome: { kind: 'aborted', reason: 'signal_abort' } });
    expect(startTurn).not.toHaveBeenCalled();
    expect(stateRef()?.interruptCalls).toBe(0);
  });

  it('requests interrupt once after startTurn when abort arrives before turn settlement', async () => {
    const lease = makeLease();
    const controller = new AbortController();
    const { driver, stateRef } = createDriver({
      async startTurn(state) {
        controller.abort();
        state.interruptReady = true;
        return {};
      },
    });

    const execution = runAppServerTurn(driver, makeRequest(), makeRuntime(lease, controller));

    await vi.waitFor(() => {
      expect(stateRef()).toBeDefined();
    });
    await vi.waitFor(() => {
      expect(stateRef()?.interruptCalls).toBe(1);
    });

    stateRef()!.terminal.resolve({ kind: 'aborted', reason: 'signal_abort' });
    await expect(execution).resolves.toMatchObject({ outcome: { kind: 'aborted', reason: 'signal_abort' } });
  });

  it('requests interrupt on mid-turn aborts', async () => {
    const lease = makeLease();
    const controller = new AbortController();
    const { driver, stateRef } = createDriver({
      async startTurn(state) {
        state.interruptReady = true;
        return {};
      },
    });

    const execution = runAppServerTurn(driver, makeRequest(), makeRuntime(lease, controller));

    await vi.waitFor(() => {
      expect(stateRef()).toBeDefined();
    });
    controller.abort();
    await vi.waitFor(() => {
      expect(stateRef()?.interruptCalls).toBe(1);
    });

    stateRef()!.terminal.resolve({ kind: 'aborted', reason: 'signal_abort' });
    await expect(execution).resolves.toMatchObject({ outcome: { kind: 'aborted', reason: 'signal_abort' } });
  });

  it('uses the transport-close fallback when lease.closed wins', async () => {
    const lease = makeLease();
    const onTransportClosed = vi.fn((_state: TestState, outcome: Error | void): TurnOutcome => ({
      kind: 'failed',
      message: outcome instanceof Error ? outcome.message : 'closed-fallback',
    }));
    const { driver } = createDriver({ onTransportClosed });

    const execution = runAppServerTurn(driver, makeRequest(), makeRuntime(lease));
    lease.close(new Error('transport down'));

    await expect(execution).resolves.toMatchObject({
      exitCode: 1,
      outcome: {
        kind: 'coral_fault',
        fault: {
          kind: 'provider_request_failed',
          provider: 'claude',
          message: 'transport down',
        },
      },
    });
    expect(onTransportClosed).toHaveBeenCalledTimes(1);
  });

  it('preserves terminal completion when lease.closed resolves later', async () => {
    const lease = makeLease();
    const onTransportClosed = vi.fn((_state: TestState, _outcome: Error | void): TurnOutcome => ({
      kind: 'failed',
      message: 'should-not-win',
    }));
    const { driver, stateRef } = createDriver({ onTransportClosed });

    const execution = runAppServerTurn(driver, makeRequest(), makeRuntime(lease));
    await vi.waitFor(() => {
      expect(stateRef()).toBeDefined();
    });
    stateRef()!.terminal.resolve({ kind: 'completed', turn: 'winner' });
    await Promise.resolve();
    lease.close(new Error('late-close'));

    await expect(execution).resolves.toMatchObject({ content: 'winner' });
    expect(onTransportClosed).not.toHaveBeenCalled();
  });

  it('ignores post-settlement notifications after the close branch wins', async () => {
    const lease = makeLease();
    const { driver } = createDriver({
      onTransportClosed(state) {
        state.value = 'closed-state';
        return { kind: 'failed', message: 'close-won' };
      },
      finalize(state, outcome) {
        expect(state.ctxNotifications).not.toContain('late-notification');
        expect(state.value).toBe('closed-state');
        return {
          content: state.value,
          exitCode: outcome.kind === 'failed' ? 1 : 0,
          outcome:
            outcome.kind === 'failed'
              ? {
                  kind: 'coral_fault',
                  fault: {
                    kind: 'provider_request_failed',
                    provider: 'claude',
                    message: outcome.message,
                  },
                }
              : { kind: 'completed' },
        };
      },
    });

    const execution = runAppServerTurn(driver, makeRequest(), makeRuntime(lease));
    lease.close(new Error('transport close'));
    setTimeout(() => {
      lease.emit({ method: 'late-notification', params: { value: 'should-not-apply' } });
    }, 0);

    await expect(execution).resolves.toMatchObject({
      content: 'closed-state',
      exitCode: 1,
      outcome: {
        kind: 'coral_fault',
        fault: {
          kind: 'provider_request_failed',
          provider: 'claude',
          message: 'close-won',
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('maps startTurn exceptions into failed results', async () => {
    const lease = makeLease();
    const { driver } = createDriver({
      async startTurn() {
        throw new Error('boom');
      },
    });

    const result = await runAppServerTurn(driver, makeRequest(), makeRuntime(lease));

    expect(result).toMatchObject({
      exitCode: 1,
      outcome: {
        kind: 'coral_fault',
        fault: {
          kind: 'provider_request_failed',
          provider: 'claude',
          message: 'boom',
        },
      },
    });
  });

  it('preserves one stable state object across notification, await, and finalize', async () => {
    const lease = makeLease();
    const { driver, stateRef } = createDriver();

    const execution = runAppServerTurn(driver, makeRequest(), makeRuntime(lease));
    await vi.waitFor(() => {
      expect(stateRef()).toBeDefined();
    });
    lease.emit({ method: 'set-value', params: { value: 'stable-ref' } });
    stateRef()!.terminal.resolve({ kind: 'completed', turn: 'ignored' });

    await expect(execution).resolves.toMatchObject({ content: 'stable-ref' });
    const state = stateRef();
    expect(state).toBeDefined();
    expect(Object.is(state, state?.refs.created)).toBe(true);
    expect(Object.is(state, state?.refs.apply)).toBe(true);
    expect(Object.is(state, state?.refs.await)).toBe(true);
    expect(Object.is(state, state?.refs.finalize)).toBe(true);
  });

  it('still releases the lease when unsubscribe throws during finally', async () => {
    const lease = makeLease({ unsubscribeThrows: true });
    const { driver } = createDriver({
      async initialize() {
        return { terminal: { kind: 'nonResumable', message: 'stop' } };
      },
    });

    await expect(runAppServerTurn(driver, makeRequest(), makeRuntime(lease))).resolves.toMatchObject({
      nonResumable: true,
      outcome: {
        kind: 'coral_fault',
        fault: {
          kind: 'provider_session_unavailable',
          provider: 'claude',
          note: 'stop',
        },
      },
    });
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });

  it('swallows unsubscribe throws on terminal completion and preserves the completed outcome', async () => {
    const lease = makeLease({ unsubscribeThrows: true });
    const { driver, stateRef } = createDriver();

    const execution = runAppServerTurn(driver, makeRequest(), makeRuntime(lease));
    await vi.waitFor(() => {
      expect(stateRef()).toBeDefined();
    });
    stateRef()!.terminal.resolve({ kind: 'completed', turn: 'completed-value' });

    await expect(execution).resolves.toMatchObject({ content: 'completed-value' });
    expect(lease.releaseMock).toHaveBeenCalledTimes(1);
  });
});
