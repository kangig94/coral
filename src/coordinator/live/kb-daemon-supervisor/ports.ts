import type { KbDaemonHealthSnapshot, KbDaemonSupervisor } from '../kb-daemon-supervisor.js';
import type { KbDaemonSupervisorState } from './state.js';
import type { createKbDaemonHealth } from './health.js';
import type { createKbDaemonRequests } from './requests.js';
import type { createKbDaemonProbes } from './probes.js';
import type { createKbDaemonRpc } from './rpc.js';
import type { createKbDaemonRequestRecovery } from './request-recovery.js';
import type { createKbDaemonProcessStop } from './process-stop.js';

type PortsDependencies = Pick<ReturnType<typeof createKbDaemonHealth>, 'read'> &
  Pick<ReturnType<typeof createKbDaemonRequests>, 'runExclusive' | 'sendRequest'> &
  Pick<ReturnType<typeof createKbDaemonProbes>, 'probeExclusive' | 'warmupNow'> &
  Pick<
    ReturnType<typeof createKbDaemonRpc>,
    'abortKbJobsNow' | 'listActiveKbJobsNow' | 'listActiveKbJobsForSuccession'
  > &
  Pick<ReturnType<typeof createKbDaemonRequestRecovery>, 'readKbNow' | 'mutateKbNow' | 'expansionRpcNow'> &
  Pick<ReturnType<typeof createKbDaemonProcessStop>, 'stopNow'> &
  Readonly<{ startNow: () => Promise<KbDaemonHealthSnapshot>; requestTimeoutMs: number }>;

export function createKbDaemonSupervisorPorts(
  state: KbDaemonSupervisorState,
  dependencies: PortsDependencies,
): KbDaemonSupervisor {
  const {
    read,
    runExclusive,
    sendRequest,
    probeExclusive,
    warmupNow,
    readKbNow,
    mutateKbNow,
    expansionRpcNow,
    abortKbJobsNow,
    listActiveKbJobsNow,
    listActiveKbJobsForSuccession,
    startNow,
    stopNow,
    requestTimeoutMs,
  } = dependencies;
  return {
    read,
    onExit: (listener) => {
      state.exitListeners.add(listener);
      return () => {
        state.exitListeners.delete(listener);
      };
    },
    start: (store) =>
      runExclusive(async () => {
        if (state.disposed) {
          return read();
        }
        state.openedStore = store ?? state.openedStore;
        state.requestRecoveryEnabled = true;
        return startNow();
      }),
    probe: probeExclusive,
    warmup: () => runExclusive(warmupNow),
    readKb: readKbNow,
    mutateKb: mutateKbNow,
    expansionRpc: expansionRpcNow,
    abortKbJobs: abortKbJobsNow,
    listActiveKbJobs: listActiveKbJobsNow,
    listActiveKbJobsForSuccession,
    parkWriterTurn: async (signal) => {
      if (state.daemonProcess === null) return;
      const response = await sendRequest('writer.park', undefined, requestTimeoutMs, signal);
      if (
        !response.ok ||
        typeof response.result !== 'object' ||
        response.result === null ||
        !('kind' in response.result) ||
        response.result.kind !== 'parked'
      ) {
        throw new Error('KB daemon did not confirm its writer turn was parked.');
      }
    },
    reclaimWriterTurn: async (writerGeneration, signal) => {
      if (state.daemonProcess === null) return;
      const response = await sendRequest('writer.reclaim', writerGeneration, requestTimeoutMs, signal);
      if (
        !response.ok ||
        typeof response.result !== 'object' ||
        response.result === null ||
        !('kind' in response.result) ||
        response.result.kind !== 'reclaimed'
      ) {
        throw new Error('KB daemon did not confirm its writer turn was reclaimed.');
      }
    },
    stop: async (reason, stopOptions) => (await runExclusive(() => stopNow(reason, stopOptions?.signal))).snapshot,
    restart: (reason = 'restart', signal) =>
      runExclusive(async () => {
        signal?.throwIfAborted();
        if (state.disposed) {
          return read();
        }
        state.requestRecoveryEnabled = true;
        state.phase = 'restarting';
        void (await stopNow(reason, signal));
        signal?.throwIfAborted();
        if (state.daemonProcess !== null) {
          return read();
        }
        return startNow();
      }),
    dispose: async (reason = 'dispose', disposeOptions) => {
      state.requestRecoveryEnabled = false;
      return runExclusive(() => {
        // Re-assert inside the exclusive turn: a start/restart queued ahead of us
        // re-enables recovery, so disabling only before runExclusive would let a
        // post-dispose read/mutate revive the daemon. This second write is load-bearing.
        state.requestRecoveryEnabled = false;
        // Terminal supervisor disposal is distinct from a recoverable stop. A
        // start/restart queued after this turn must not flip recovery back on.
        state.disposed = true;
        return stopNow(reason, disposeOptions?.signal);
      });
    },
  };
}
