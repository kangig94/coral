import type { Runtime } from '../../../runtime/ports.js';
import type { KbDaemonSupervisorState } from './state.js';
import type { KbDaemonProtocolBindings, KbDaemonWireTypes } from './index.js';
type KbDaemonRequestMethod = KbDaemonWireTypes['requestMethod'];
type KbDaemonResponseMessage = KbDaemonWireTypes['responseMessage'];
import type { KbDaemonHealthSnapshot } from './index.js';

export function createKbDaemonRequests(
  runtime: Runtime,
  state: KbDaemonSupervisorState,
  read: () => KbDaemonHealthSnapshot,
  requestTimeoutMs: number,
  protocol: KbDaemonProtocolBindings,
) {
  const { KB_DAEMON_REQUEST_MESSAGE, encodeKbDaemonMessage } = protocol;
  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = state.operation ?? Promise.resolve(read());
    const next = previous.catch(() => read()).then(fn);
    const wrapped = next.finally(() => {
      if (state.operation === wrapped) {
        state.operation = null;
      }
    });
    state.operation = wrapped;
    return wrapped;
  };

  const rejectPendingRequests = (message: string, activeGeneration?: number): void => {
    for (const [id, pending] of state.pendingRequests) {
      if (activeGeneration !== undefined && pending.generation !== activeGeneration) {
        continue;
      }
      runtime.time.clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      state.pendingRequests.delete(id);
    }
  };

  const sendRequest = async (
    method: KbDaemonRequestMethod,
    params?: unknown,
    timeoutMs = requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<KbDaemonResponseMessage> => {
    const activeDaemonProcess = state.daemonProcess;
    if (activeDaemonProcess === null || activeDaemonProcess.stdin === null || state.phase !== 'online') {
      throw new Error('KB daemon is not online');
    }
    if (signal?.aborted) {
      throw new Error('KB daemon request aborted');
    }

    const requestGeneration = state.generation;
    const id = `${state.generation}:${state.nextRequestId++}`;
    const sentAt = runtime.time.now();
    const response = await new Promise<KbDaemonResponseMessage>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        runtime.time.clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        state.pendingRequests.delete(id);
      };
      const rejectWith = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        rejectWith(new Error('KB daemon request aborted'));
      };
      const timeout = runtime.time.setTimeout(() => {
        rejectWith(new Error(`KB daemon request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      state.pendingRequests.set(id, {
        generation: state.generation,
        timeout,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: rejectWith,
        cleanup,
      });
      try {
        activeDaemonProcess.stdin?.write(
          encodeKbDaemonMessage({ type: KB_DAEMON_REQUEST_MESSAGE, id, method, params }),
        );
      } catch (error: unknown) {
        rejectWith(error instanceof Error ? error : new Error(String(error)));
      }
    });
    // Only the current generation's latency is a live health signal; a
    // late-completing request from a restarted daemon must not clobber it.
    if (requestGeneration === state.generation) {
      state.lastHeartbeatLatencyMs = Math.max(0, runtime.time.now() - sentAt);
    }
    return response;
  };

  return { runExclusive, rejectPendingRequests, sendRequest };
}
