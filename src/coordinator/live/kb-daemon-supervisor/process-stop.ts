import type { KbDaemonProtocolBindings } from '../kb-daemon-supervisor.js';
import type { KbDaemonSupervisorState } from './state.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { DaemonProcessLike, KbDaemonDisposalSettlement } from '../kb-daemon-supervisor.js';
import type { createKbDaemonHealth } from './health.js';
import type { createKbDaemonRequests } from './requests.js';

function withAbortableTimeout(
  runtime: Runtime,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<'timeout' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    const timeout = runtime.time.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('timeout');
    }, ms);
    timeout.unref?.();
    const onAbort = (): void => {
      runtime.time.clearTimeout(timeout);
      resolve('aborted');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForClose(daemonProcess: DaemonProcessLike): Promise<void> {
  return new Promise((resolve) => {
    daemonProcess.on('close', () => resolve());
  });
}

type StopDependencies = Pick<ReturnType<typeof createKbDaemonHealth>, 'read' | 'setFailure'> &
  Pick<ReturnType<typeof createKbDaemonRequests>, 'rejectPendingRequests' | 'runExclusive'> &
  Readonly<{ acceptKbDaemonKill: (child: DaemonProcessLike) => void }>;

export function createKbDaemonProcessStop(
  runtime: Runtime,
  state: KbDaemonSupervisorState,
  stopTimeoutMs: number,
  dependencies: StopDependencies,
  protocol: KbDaemonProtocolBindings,
) {
  const { KB_DAEMON_REQUEST_MESSAGE, encodeKbDaemonMessage } = protocol;
  const { read, setFailure, acceptKbDaemonKill, rejectPendingRequests, runExclusive } = dependencies;
  const stopNow = async (reason = 'stop', signal?: AbortSignal): Promise<KbDaemonDisposalSettlement> => {
    const activeDaemonProcess = state.daemonProcess;
    if (activeDaemonProcess === null) {
      state.phase = 'stopped';
      state.pid = null;
      state.readyAt = null;
      rejectPendingRequests('KB daemon stopped');
      return { kind: 'confirmed-absent', snapshot: read() };
    }

    state.phase = 'stopping';
    const closeSettlement = waitForClose(activeDaemonProcess);
    const closed = closeSettlement.then(() => 'closed' as const);
    try {
      activeDaemonProcess.stdin?.write(
        encodeKbDaemonMessage({
          type: KB_DAEMON_REQUEST_MESSAGE,
          id: `${state.generation}:shutdown`,
          method: 'shutdown',
          params: { reason },
        }),
      );
      activeDaemonProcess.stdin?.end();
    } catch {
      acceptKbDaemonKill(activeDaemonProcess);
    }

    const result = await Promise.race([closed, withAbortableTimeout(runtime, stopTimeoutMs, signal)]);
    if (result !== 'closed' && state.daemonProcess === activeDaemonProcess) {
      setFailure(
        result === 'aborted'
          ? 'daemon stop aborted by shutdown budget'
          : `daemon stop timed out after ${stopTimeoutMs}ms`,
      );
      acceptKbDaemonKill(activeDaemonProcess);
    }
    rejectPendingRequests('KB daemon stopped');
    if (result === 'closed' || state.daemonProcess !== activeDaemonProcess) {
      return { kind: 'confirmed-absent', snapshot: read() };
    }
    if (typeof activeDaemonProcess.pid === 'number') {
      try {
        if (runtime.process.observeLiveness(activeDaemonProcess.pid) === 'absent') {
          if (state.daemonProcess === activeDaemonProcess) {
            state.daemonProcess = null;
            state.pid = null;
            state.readyAt = null;
          }
          return { kind: 'confirmed-absent', snapshot: read() };
        }
      } catch {
        // Unknown liveness retains the close-backed shutdown obligation.
      }
    }
    return {
      kind: 'holding',
      snapshot: read(),
      reason: `KB daemon process ${activeDaemonProcess.pid ?? 'unknown'} has not been observed absent`,
      exit: 'kb-daemon-process-close',
      retryAfter: closeSettlement,
      retry: (retrySignal) => runExclusive(() => stopNow(reason, retrySignal)),
    };
  };

  return { stopNow };
}
