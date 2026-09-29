import type { Runtime } from '../../../runtime/ports.js';
import type {
  KbDaemonDisposalSettlement,
  KbDaemonHealthSnapshot,
  KbDaemonProtocolBindings,
} from '../kb-daemon-supervisor.js';
import type { KbDaemonSupervisorState } from './state.js';
import type { createKbDaemonHealth } from './health.js';
import type { createKbDaemonRequests } from './requests.js';
import { createKbDaemonProbes } from './probes.js';
import { createKbDaemonRpc } from './rpc.js';
import { createKbDaemonRequestRecovery } from './request-recovery.js';

type ServiceRequestDependencies = Pick<ReturnType<typeof createKbDaemonHealth>, 'read' | 'setFailure'> &
  Pick<ReturnType<typeof createKbDaemonRequests>, 'sendRequest' | 'runExclusive'> &
  Readonly<{
    startNow: () => Promise<KbDaemonHealthSnapshot>;
    stopNow: (reason: string) => Promise<KbDaemonDisposalSettlement>;
    requestTimeoutMs: number;
    jobRequestTimeoutMs: number;
  }>;

export function createKbDaemonServiceRequests(
  runtime: Runtime,
  state: KbDaemonSupervisorState,
  dependencies: ServiceRequestDependencies,
  protocol: KbDaemonProtocolBindings,
) {
  const { sendRequest, setFailure, read, runExclusive, startNow, stopNow, requestTimeoutMs, jobRequestTimeoutMs } =
    dependencies;
  const { probeExclusive, warmupNow, recoverForRequest } = createKbDaemonProbes(
    runtime,
    state,
    {
      sendRequest,
      setFailure,
      read,
      runExclusive,
      startNow: () => startNow(),
      stopNow: (reason) => stopNow(reason),
    },
    protocol,
  );

  const {
    kbUnavailable,
    sendKbReadRequest,
    sendKbMutationRequest,
    sendExpansionRpcRequest,
    abortKbJobsNow,
    listActiveKbJobsNow,
    listActiveKbJobsForSuccession,
  } = createKbDaemonRpc(sendRequest, requestTimeoutMs, jobRequestTimeoutMs, protocol);

  const { readKbNow, mutateKbNow, expansionRpcNow } = createKbDaemonRequestRecovery(state, {
    kbUnavailable,
    sendKbReadRequest,
    sendKbMutationRequest,
    sendExpansionRpcRequest,
    recoverForRequest,
  });

  return {
    probeExclusive,
    warmupNow,
    readKbNow,
    mutateKbNow,
    expansionRpcNow,
    abortKbJobsNow,
    listActiveKbJobsNow,
    listActiveKbJobsForSuccession,
  };
}
