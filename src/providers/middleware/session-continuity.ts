import { isDeepStrictEqual } from 'node:util';

import type {
  Provider,
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

type ContinuitySnapshot = Pick<ProviderContinuityEventBody, 'conversationRef' | 'resumable' | 'providerContinuity'>;

type ContinuityQueue = {
  lastEmitted: ContinuitySnapshot;
  pending: ContinuitySnapshot[];
};

type ContinuityState<TState> = {
  current: TState;
  pendingTransportClosed?: ProviderTransportClose;
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

export function sessionContinuity<TState>(contract: SessionContinuityContract<TState>): ProviderMiddleware;
export function sessionContinuity<TState>(
  providerName: string,
  contract: SessionContinuityContract<TState>,
): ProviderMiddleware;
export function sessionContinuity<TState>(
  providerNameOrContract: string | SessionContinuityContract<TState>,
  maybeContract?: SessionContinuityContract<TState>,
): ProviderMiddleware {
  const providerName = typeof providerNameOrContract === 'string' ? providerNameOrContract : undefined;
  const contract = typeof providerNameOrContract === 'string' ? maybeContract : providerNameOrContract;
  if (!contract) {
    throw new Error('sessionContinuity requires a contract.');
  }

  return (next) =>
    async function* sessionContinuityProvider(request, runtime) {
      const { providerState, opening } = contract.read(runtime.persistedContinuity, request);
      const queue: ContinuityQueue = {
        lastEmitted: normalizeSnapshot(opening),
        pending: [],
      };
      const state: ContinuityState<TState> = {
        current: providerState,
      };
      const devAssertions = runtime.env?.get('CORAL_DEV_ASSERTIONS') === '1';
      const bridgeLifecycle = createBridgeLifecycle(devAssertions);
      const continuityBridge = createContinuityBridge(bridgeLifecycle, contract, state, queue, devAssertions);

      const wrappedRuntime: ProviderRuntime = {
        ...runtime,
        signal: createAbortAwareSignal(runtime.signal),
        continuityBridge,
      };

      try {
        for await (const event of runWithBridge(next, request, wrappedRuntime)) {
          yield* drainContinuity(queue.pending);

          if (event.kind !== 'terminal') {
            yield event;
            continue;
          }

          queueFinalContinuityIfDelta(contract, state, queue);
          yield* drainContinuity(queue.pending);

          yield event;
          return;
        }

        queueFinalContinuityIfDelta(contract, state, queue);
        yield* drainContinuity(queue.pending);
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
            outcome: { kind: 'failed' },
          }),
          diagnostics: buildJobDiagnostics({}),
          failureCause: buildSessionUnavailableFailureCause(providerName ?? 'unknown', errorReason(err)),
        };
        return;
      } finally {
        deactivateBridge(bridgeLifecycle, devAssertions);
      }
    };
}

function continuityEvent(snapshot: ContinuitySnapshot): ProviderContinuityEventBody {
  return {
    kind: 'continuity',
    ...snapshot,
  };
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
  devAssertions: boolean,
): ProviderRuntime['continuityBridge'] {
  return {
    checkpoint(update) {
      if (!assertBridgeActive(lifecycle, 'checkpoint', devAssertions)) {
        return;
      }

      state.current = contract.applyUpdate(state.current, update);
      queueContinuityIfDelta(queue, contract.snapshot(state.current));
    },
    transportClosed(closed) {
      if (!assertBridgeActive(lifecycle, 'transportClosed', devAssertions)) {
        return;
      }

      state.pendingTransportClosed = closed;
    },
  };
}

function runWithBridge(next: Provider, request: ProviderRequest, runtime: ProviderRuntime): ReturnType<Provider> {
  return next(request, runtime);
}

type AbortSignalListener = Parameters<AbortSignal['addEventListener']>[1];
type AbortSignalListenerOptions = Parameters<AbortSignal['addEventListener']>[2];

function createAbortAwareSignal(signal: AbortSignal): AbortSignal {
  return new Proxy(signal, {
    get(target, prop, receiver) {
      if (prop === 'addEventListener') {
        return (
          type: 'abort',
          listener: AbortSignalListener,
          options?: AbortSignalListenerOptions,
        ): void => {
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

function queueContinuityIfDelta(queue: ContinuityQueue, snapshot: ContinuitySnapshot): void {
  queue.lastEmitted = emitFinalContinuityIfDelta(queue.lastEmitted, snapshot, (nextSnapshot) => {
    queue.pending.push(nextSnapshot);
  });
}

function applyPendingTransportClosed<TState>(
  contract: SessionContinuityContract<TState>,
  state: ContinuityState<TState>,
): void {
  if (state.pendingTransportClosed === undefined) {
    return;
  }
  if (contract.applyTransportClosed) {
    state.current = contract.applyTransportClosed(state.current, state.pendingTransportClosed);
  }
  state.pendingTransportClosed = undefined;
}

function queueFinalContinuityIfDelta<TState>(
  contract: SessionContinuityContract<TState>,
  state: ContinuityState<TState>,
  queue: ContinuityQueue,
): void {
  applyPendingTransportClosed(contract, state);
  queueContinuityIfDelta(queue, contract.snapshot(state.current));
}

function emitFinalContinuityIfDelta(
  lastEmitted: ContinuitySnapshot,
  current: ContinuitySnapshot,
  emit: (snapshot: ContinuitySnapshot) => void,
): ContinuitySnapshot {
  const normalized = normalizeSnapshot(current);
  if (isDeepStrictEqual(lastEmitted, normalized)) {
    return lastEmitted;
  }

  emit(normalized);
  return normalized;
}

function* drainContinuity(pending: ContinuitySnapshot[]): Generator<ProviderContinuityEventBody> {
  while (pending.length > 0) {
    const snapshot = pending.shift();
    if (snapshot) {
      yield continuityEvent(snapshot);
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
