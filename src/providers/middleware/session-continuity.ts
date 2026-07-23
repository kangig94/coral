import { isDeepStrictEqual } from 'node:util';

import type {
  ProviderContinuityEventBody,
  ProviderContinuityUpdate,
  ProviderMiddleware,
  ProviderRequest,
  ProviderRuntime,
} from '../contract.js';
import type { ProviderTransportClose } from '../protocol.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { providerSessionUnavailable } from '../fault.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import type { ProviderExecutionPlan } from '../execution-plan.js';
import { attachContinuityCommit } from '../internal/continuity-commit.js';

type ContinuitySnapshot = Pick<ProviderContinuityEventBody, 'conversationRef' | 'resumable' | 'providerContinuity'>;

type ContinuityQueue = {
  lastQueued: ContinuitySnapshot;
  lastQueuedCommit: Promise<void>;
  pending: ContinuityQueueEntry[];
  outstanding: Set<ContinuityQueueEntry>;
  failure?: Error;
};

type ContinuityState<TState> = {
  current: TState;
};

type ContinuityQueueEntry = {
  snapshot: ContinuitySnapshot;
  settled: boolean;
  resolve(): void;
  rejectPromise(error: unknown): void;
  commit: Readonly<{
    commit(): void;
    reject(error: unknown): void;
  }>;
};

type WakeSignal = {
  wake(): void;
  version(): number;
  waitAfter(version: number): Promise<void>;
};

type BridgeLifecycle = {
  active: boolean;
  creationStack?: string;
  deactivationStack?: string;
};

export interface SessionContinuityContract<TState> {
  read(
    persisted: ProviderContinuityBlob | undefined,
    request: ProviderRequest,
  ): { providerState: TState; opening: ContinuitySnapshot };
  applyUpdate(state: TState, update: ProviderContinuityUpdate): TState;
  snapshot(state: TState): ContinuitySnapshot;
  applyTransportClosed?(state: TState, closed: ProviderTransportClose): TState;
  isSessionUnavailable(err: unknown): boolean;
}

function buildSessionUnavailableFailureCause(provider: string, reason: string) {
  return providerSessionUnavailable({ provider, reason });
}

export function sessionContinuity<
  TState,
  Plan extends ProviderExecutionPlan,
  ExecutionRuntime extends ProviderRuntime<Plan> = ProviderRuntime<Plan>,
>(providerName: string, contract: SessionContinuityContract<TState>): ProviderMiddleware<Plan, ExecutionRuntime> {
  return (next) =>
    async function* sessionContinuityProvider(request, runtime) {
      const startedAt = runtime.time.now();
      const { providerState, opening } = contract.read(runtime.persistedContinuity, request);
      const queue: ContinuityQueue = {
        lastQueued: normalizeSnapshot(opening),
        lastQueuedCommit: Promise.resolve(),
        pending: [],
        outstanding: new Set(),
      };
      const state: ContinuityState<TState> = {
        current: providerState,
      };
      const devAssertions = runtime.env?.get('CORAL_DEV_ASSERTIONS') === '1';
      const bridgeLifecycle = createBridgeLifecycle(devAssertions);
      const wake = createWakeSignal();
      const continuityBridge = createContinuityBridge(bridgeLifecycle, contract, state, queue, wake, devAssertions);

      const wrappedRuntime: ExecutionRuntime = {
        ...runtime,
        signal: createAbortAwareSignal(runtime.signal),
        continuityBridge,
      } as ExecutionRuntime;

      const iterator = next(request, wrappedRuntime)[Symbol.asyncIterator]();
      let downstreamSettled = false;
      let transportClosed = false;
      let downstream = iterator.next().then((step) => ({ kind: 'downstream' as const, step }));
      let wakePending = wake.waitAfter(wake.version()).then(() => ({ kind: 'wake' as const }));
      const transportClosePending =
        runtime.transport === 'app-server'
          ? runtime.appServerSession.closed.then((error) => ({
              kind: 'transport_closed' as const,
              closed: { kind: 'transport_closed' as const, error: error ?? null },
            }))
          : null;
      try {
        for (;;) {
          yield* drainContinuity(queue.pending);

          const outcome = await Promise.race(
            transportClosed || transportClosePending === null
              ? [downstream, wakePending]
              : [downstream, wakePending, transportClosePending],
          );
          if (outcome.kind === 'wake') {
            wakePending = wake.waitAfter(wake.version()).then(() => ({ kind: 'wake' as const }));
            continue;
          }
          if (outcome.kind === 'transport_closed') {
            transportClosed = true;
            continuityBridge.transportClosed(outcome.closed);
            continue;
          }

          const event = outcome.step;
          if (event.done) {
            downstreamSettled = true;
            queueFinalContinuityIfDelta(contract, state, queue);
            yield* drainContinuity(queue.pending);
            return;
          }

          if (event.value.kind !== 'terminal') {
            yield event.value;
            downstream = iterator.next().then((step) => ({ kind: 'downstream' as const, step }));
            continue;
          }

          queueFinalContinuityIfDelta(contract, state, queue);
          yield* drainContinuity(queue.pending);

          yield event.value;
          return;
        }
      } catch (err) {
        if (!contract.isSessionUnavailable(err)) {
          throw err;
        }

        if (request.action === 'resume') {
          state.current = contract.applyUpdate(state.current, {
            conversationRef: null,
            resumable: true,
          });
          queueFinalContinuityIfDelta(contract, state, queue);
          yield* drainContinuity(queue.pending);
        }

        yield {
          kind: 'terminal',
          terminal: buildJobTerminal({
            content: '',
            durationMs: Math.max(0, runtime.time.now() - startedAt),
            outcome: { kind: 'failed' },
          }),
          diagnostics: buildJobDiagnostics({}),
          failureCause: buildSessionUnavailableFailureCause(providerName, errorReason(err)),
        };
        return;
      } finally {
        deactivateBridge(bridgeLifecycle, devAssertions);
        rejectContinuityQueue(queue, new Error('Continuity stream closed before checkpoint commit.'));
        if (!downstreamSettled && typeof iterator.return === 'function') {
          await iterator.return().catch(() => undefined);
        }
      }
    };
}

function continuityEvent(entry: ContinuityQueueEntry): ProviderContinuityEventBody {
  return attachContinuityCommit(
    {
      kind: 'continuity',
      ...entry.snapshot,
    },
    entry.commit,
  );
}

function normalizeSnapshot(snapshot: ContinuitySnapshot): ContinuitySnapshot {
  return {
    conversationRef: snapshot.conversationRef,
    resumable: snapshot.resumable,
    providerContinuity: snapshot.providerContinuity,
  };
}

function createBridgeLifecycle(captureDebugStacks: boolean): BridgeLifecycle {
  return {
    active: true,
    creationStack: captureDebugStacks ? captureStack('Continuity bridge created here.') : undefined,
  };
}

function deactivateBridge(lifecycle: BridgeLifecycle, captureDebugStacks: boolean): void {
  if (captureDebugStacks) {
    lifecycle.deactivationStack = captureStack('Continuity bridge deactivated here.');
  }
  lifecycle.active = false;
}

function createContinuityBridge<TState>(
  lifecycle: BridgeLifecycle,
  contract: SessionContinuityContract<TState>,
  state: ContinuityState<TState>,
  queue: ContinuityQueue,
  wake: WakeSignal,
  devAssertions: boolean,
): ProviderRuntime['continuityBridge'] {
  return {
    checkpoint(update) {
      if (!assertBridgeActive(lifecycle, 'checkpoint', devAssertions)) {
        return;
      }

      state.current = contract.applyUpdate(state.current, update);
      const acknowledged = queueContinuityIfDelta(queue, contract.snapshot(state.current));
      wake.wake();
      return acknowledged;
    },
    transportClosed(closed) {
      if (!assertBridgeActive(lifecycle, 'transportClosed', devAssertions)) {
        return;
      }

      if (contract.applyTransportClosed) {
        state.current = contract.applyTransportClosed(state.current, closed);
      }
      void queueContinuityIfDelta(queue, contract.snapshot(state.current));
      wake.wake();
    },
  };
}

function createWakeSignal(): WakeSignal {
  let version = 0;
  let resolvePulse!: () => void;
  let pulse = new Promise<void>((resolve) => {
    resolvePulse = resolve;
  });
  return {
    wake() {
      version += 1;
      const resolve = resolvePulse;
      pulse = new Promise<void>((nextResolve) => {
        resolvePulse = nextResolve;
      });
      resolve();
    },
    version() {
      return version;
    },
    waitAfter(observedVersion) {
      return version === observedVersion ? pulse : Promise.resolve();
    },
  };
}

type AbortSignalListener = Parameters<AbortSignal['addEventListener']>[1];
type AbortSignalListenerOptions = Parameters<AbortSignal['addEventListener']>[2];

function createAbortAwareSignal(signal: AbortSignal): AbortSignal {
  return new Proxy(signal, {
    get(target, prop, receiver) {
      if (prop === 'addEventListener') {
        return (type: 'abort', listener: AbortSignalListener, options?: AbortSignalListenerOptions): void => {
          if (type === 'abort' && target.aborted) {
            notifyAbortListener(target, listener);
            return;
          }

          target.addEventListener(type, listener, options);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function notifyAbortListener(signal: AbortSignal, listener: AbortSignalListener): void {
  const event = new Event('abort');
  if (typeof listener === 'function') {
    listener.call(signal, event);
    return;
  }

  listener.handleEvent(event);
}

function queueContinuityIfDelta(queue: ContinuityQueue, snapshot: ContinuitySnapshot): Promise<void> {
  if (queue.failure !== undefined) {
    const rejected = Promise.reject(queue.failure);
    void rejected.catch(() => undefined);
    return rejected;
  }

  const normalized = normalizeSnapshot(snapshot);
  if (isDeepStrictEqual(queue.lastQueued, normalized)) {
    return queue.lastQueuedCommit;
  }

  let resolveCommit!: () => void;
  let rejectCommit!: (error: unknown) => void;
  const committed = new Promise<void>((resolve, reject) => {
    resolveCommit = resolve;
    rejectCommit = reject;
  });
  void committed.catch(() => undefined);
  const entry: ContinuityQueueEntry = {
    snapshot: normalized,
    settled: false,
    resolve: resolveCommit,
    rejectPromise: rejectCommit,
    commit: Object.freeze({
      commit() {
        settleContinuityEntry(queue, entry);
      },
      reject(error: unknown) {
        rejectContinuityQueue(queue, error);
      },
    }),
  };
  queue.lastQueued = normalized;
  queue.lastQueuedCommit = committed;
  queue.pending.push(entry);
  queue.outstanding.add(entry);
  return committed;
}

function settleContinuityEntry(queue: ContinuityQueue, entry: ContinuityQueueEntry): void {
  if (entry.settled) return;
  entry.settled = true;
  queue.outstanding.delete(entry);
  entry.resolve();
}

function rejectContinuityQueue(queue: ContinuityQueue, error: unknown): void {
  queue.failure ??= error instanceof Error ? error : new Error(String(error));
  const failure = queue.failure;
  for (const entry of queue.outstanding) {
    if (entry.settled) continue;
    entry.settled = true;
    entry.rejectPromise(failure);
  }
  queue.outstanding.clear();
  queue.pending.length = 0;
}

function queueFinalContinuityIfDelta<TState>(
  contract: SessionContinuityContract<TState>,
  state: ContinuityState<TState>,
  queue: ContinuityQueue,
): void {
  void queueContinuityIfDelta(queue, contract.snapshot(state.current));
}

function* drainContinuity(pending: ContinuityQueueEntry[]): Generator<ProviderContinuityEventBody> {
  let consumed = 0;
  try {
    while (consumed < pending.length) {
      const entry = pending[consumed];
      consumed += 1;
      if (entry !== undefined) {
        yield continuityEvent(entry);
      }
    }
  } finally {
    if (consumed > 0) {
      pending.splice(0, consumed);
    }
  }
}

function assertBridgeActive(
  lifecycle: BridgeLifecycle,
  method: keyof ProviderRuntime['continuityBridge'],
  devAssertions: boolean,
): boolean {
  if (lifecycle.active) {
    return true;
  }

  if (!devAssertions) {
    return false;
  }

  const assertion = new Error(
    [
      `Stale runtime.continuityBridge.${method}() call after sessionContinuity() deactivation.`,
      'Remediation: cancel delayed callbacks or stop emitting after the provider iterator returns.',
      '',
      'Bridge creation stack:',
      lifecycle.creationStack ?? 'stack unavailable',
      '',
      'Bridge deactivation stack:',
      lifecycle.deactivationStack ?? 'stack unavailable',
    ].join('\n'),
  );
  assertion.name = 'AssertionError';
  throw assertion;
}

function captureStack(message: string): string | undefined {
  return new Error(message).stack;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
