import { isDeepStrictEqual } from 'node:util';

import type {
  ProviderContinuityBlob,
  ProviderContinuityEventBody,
  ProviderContinuityUpdate,
  ProviderMiddleware,
  ProviderRequest,
  ProviderRuntime,
  ProviderTransportClose,
} from '../contract.js';
import { providerSessionUnavailable } from '../fault.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';

type ContinuitySnapshot = Pick<
  ProviderContinuityEventBody,
  'conversationRef' | 'resumable' | 'providerContinuity'
>;

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

export function sessionContinuity<TState>(contract: SessionContinuityContract<TState>): ProviderMiddleware {
  return (next) =>
    async function* sessionContinuityProvider(request, runtime) {
      const { providerState, opening } = contract.read(runtime.persistedContinuity, request);
      let state = providerState;
      let lastSnapshot = normalizeSnapshot(opening);
      let pendingTransportClosed: ProviderTransportClose | undefined;
      const pendingContinuity: ContinuitySnapshot[] = [];
      let active = true;

      const queueSnapshot = (snapshot: ContinuitySnapshot): void => {
        const normalized = normalizeSnapshot(snapshot);
        if (isDeepStrictEqual(lastSnapshot, normalized)) {
          return;
        }

        lastSnapshot = normalized;
        pendingContinuity.push(normalized);
      };

      const flushPendingTransportClose = (): void => {
        if (pendingTransportClosed === undefined) {
          return;
        }
        if (contract.applyTransportClosed) {
          state = contract.applyTransportClosed(state, pendingTransportClosed);
        }
        pendingTransportClosed = undefined;
      };

      const flushFinalSnapshot = (): void => {
        flushPendingTransportClose();
        queueSnapshot(contract.snapshot(state));
      };

      const continuityBridge = createContinuityBridge({
        checkpoint(update) {
          state = contract.applyUpdate(state, update);
          queueSnapshot(contract.snapshot(state));
        },
        transportClosed(closed) {
          pendingTransportClosed = closed;
        },
        isActive: () => active,
      });

      const wrappedRuntime: ProviderRuntime = { ...runtime, continuityBridge };

      try {
        for await (const event of next(request, wrappedRuntime)) {
          while (pendingContinuity.length > 0) {
            const snapshot = pendingContinuity.shift();
            if (snapshot) {
              yield continuityEvent(snapshot);
            }
          }

          if (event.kind !== 'terminal') {
            yield event;
            continue;
          }

          flushFinalSnapshot();
          while (pendingContinuity.length > 0) {
            const snapshot = pendingContinuity.shift();
            if (snapshot) {
              yield continuityEvent(snapshot);
            }
          }

          yield event;
          return;
        }

        flushFinalSnapshot();
        while (pendingContinuity.length > 0) {
          const snapshot = pendingContinuity.shift();
          if (snapshot) {
            yield continuityEvent(snapshot);
          }
        }
      } catch (err) {
        if (!contract.isSessionUnavailable(err)) {
          throw err;
        }

        if (request.action === 'resume') {
          state = contract.applyUpdate(state, {
            conversationRef: null,
            resumable: true,
          });
          flushFinalSnapshot();
          while (pendingContinuity.length > 0) {
            const snapshot = pendingContinuity.shift();
            if (snapshot) {
              yield continuityEvent(snapshot);
            }
          }
        }

        yield {
          kind: 'terminal',
          terminal: buildJobTerminal({
            content: '',
            outcome: {
              kind: 'failed',
              fault: providerSessionUnavailable({
                provider: request.name ?? 'unknown',
                reason: errorReason(err),
              }),
            },
          }),
          diagnostics: buildJobDiagnostics({}),
        };
        return;
      } finally {
        active = false;
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

function createContinuityBridge(options: {
  checkpoint(update: ProviderContinuityUpdate): void;
  transportClosed(closed: ProviderTransportClose): void;
  isActive(): boolean;
}): ProviderRuntime['continuityBridge'] {
  return {
    checkpoint(update) {
      if (!assertBridgeActive(options.isActive, 'checkpoint')) {
        return;
      }
      options.checkpoint(update);
    },
    transportClosed(closed) {
      if (!assertBridgeActive(options.isActive, 'transportClosed')) {
        return;
      }
      options.transportClosed(closed);
    },
  };
}

function assertBridgeActive(
  isActive: () => boolean,
  method: keyof ProviderRuntime['continuityBridge'],
): boolean {
  if (isActive()) {
    return true;
  }

  if (process.env.CORAL_DEV_ASSERTIONS !== '1') {
    return false;
  }

  const assertion = new Error(
    `Stale runtime.continuityBridge.${method}() call after sessionContinuity() deactivation.`,
  );
  assertion.name = 'AssertionError';
  throw assertion;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
