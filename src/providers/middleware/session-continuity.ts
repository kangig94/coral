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
      let active = true;

      const continuityBridge = createContinuityBridge({
        checkpoint(update) {
          state = contract.applyUpdate(state, update);
        },
        transportClosed(closed) {
          pendingTransportClosed = closed;
        },
        isActive: () => active,
      });

      const wrappedRuntime: ProviderRuntime = { ...runtime, continuityBridge };

      const finalizeSnapshot = (): ContinuitySnapshot | null => {
        if (pendingTransportClosed !== undefined) {
          if (contract.applyTransportClosed) {
            state = contract.applyTransportClosed(state, pendingTransportClosed);
          }
          pendingTransportClosed = undefined;
        }

        const snapshot = normalizeSnapshot(contract.snapshot(state));
        if (isDeepStrictEqual(lastSnapshot, snapshot)) {
          return null;
        }

        lastSnapshot = snapshot;
        return snapshot;
      };

      yield continuityEvent(lastSnapshot);

      try {
        for await (const event of next(request, wrappedRuntime)) {
          if (event.kind !== 'terminal') {
            yield event;
            continue;
          }

          const finalSnapshot = finalizeSnapshot();
          if (finalSnapshot) {
            yield continuityEvent(finalSnapshot);
          }

          yield event;
          return;
        }

        const finalSnapshot = finalizeSnapshot();
        if (finalSnapshot) {
          yield continuityEvent(finalSnapshot);
        }
      } catch (err) {
        if (!contract.isSessionUnavailable(err)) {
          throw err;
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
