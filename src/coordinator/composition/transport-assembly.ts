import {
  reconcileAbandonedRequestStatuses,
  writeAbandonedRequestStatus,
} from '../../infra/abandoned-request-status.js';
import { formatError } from '../../infra/error-format.js';
import { probeProcessIncarnation } from '../../infra/node-process.js';
import { buildTransportErrorResponse } from '../../transport/error-response.js';
import { createHttpHandler, sendJson } from '../../transport/http/handler.js';
import { createIpcServer } from '../../transport/ipc/server.js';
import type { HttpHandlerPorts } from '../../transport/server-ports.js';
import { createRequestLeaseOwner } from '../live/request-leases.js';
import type { KbDaemonSupervisor } from '../live/kb-daemon-supervisor/index.js';
import { createCoordinatorHealthReader } from './health-observation.js';
import { createCoordinatorEventStreamPorts } from './event-stream-ports.js';
import type { createCoordinatorCoreContext } from './core-context.js';
import type { createCoordinatorExecutionAssembly } from './execution-assembly.js';
import type { createRecoveryAssembly } from './recovery-assembly.js';
import type { connectLaunchEvidence } from './launch-evidence.js';
import type { createSuccessionJobView, createCoordinatorSuccessionAssembly } from './succession-assembly.js';
import type { createCoordinatorRequestPorts } from './request-ports.js';
import type { CoordinatorCoreOptions } from './types.js';

function createCoordinatorRequestLeaseOwner(
  core: ReturnType<typeof createCoordinatorCoreContext>,
  options: CoordinatorCoreOptions,
) {
  const { runtime, world, identity } = core;
  reconcileAbandonedRequestStatuses(runtime.storage, runtime.paths.coral.coordinator.runDir);
  const requestOwnerIncarnation = probeProcessIncarnation(process.pid);
  const requestLeases = createRequestLeaseOwner({
    time: runtime.time,
    timing: options.requestLeaseTiming,
    newRecordId: () => runtime.ids.uuid(),
    owner:
      requestOwnerIncarnation === null
        ? undefined
        : { instanceId: identity.instanceId, pid: process.pid, incarnation: requestOwnerIncarnation },
    begin: () => world.idleTimer.beginRequest(),
    end: () => world.idleTimer.endRequest(),
    abandon: (request) => writeAbandonedRequestStatus(runtime.storage, runtime.paths.coral.coordinator.runDir, request),
  });

  return requestLeases;
}

export function createCoordinatorTransportAssembly(input: {
  core: ReturnType<typeof createCoordinatorCoreContext>;
  options: CoordinatorCoreOptions;
  execution: ReturnType<typeof createCoordinatorExecutionAssembly>;
  recovery: ReturnType<typeof createRecoveryAssembly>;
  evidence: ReturnType<typeof connectLaunchEvidence>;
  jobView: ReturnType<typeof createSuccessionJobView>;
  successionAssembly: ReturnType<typeof createCoordinatorSuccessionAssembly>;
  requestPorts: ReturnType<typeof createCoordinatorRequestPorts>;
  kbDaemonSupervisorWithTrackedShutdown: KbDaemonSupervisor;
  maxEventStreamConnections: number;
  launchPermitReportAgeMs: number;
}) {
  const {
    core,
    options,
    execution,
    recovery,
    evidence,
    jobView,
    successionAssembly,
    requestPorts,
    kbDaemonSupervisorWithTrackedShutdown,
    maxEventStreamConnections,
    launchPermitReportAgeMs,
  } = input;
  const {
    runtime,
    world,
    state,
    identity,
    runtimeState,
    strictHealthIdentity,
    strictHealthBundleDir,
    kbDaemonSupervisor,
  } = core;
  const { defaults, control, streamResponses, eventStreamSubscriptions } = execution;
  const { providerOperationAdoptionRefusals } = recovery;
  const { settlementRefusalRecordingFailures } = evidence;
  const { readSelfIncarnation } = jobView;
  const { succession } = successionAssembly;
  const { rpcPorts } = requestPorts;
  const requestLeases = createCoordinatorRequestLeaseOwner(core, options);
  const httpHandlerDeps: HttpHandlerPorts = {
    identity,
    time: runtime.time,
    coralEnvSnapshot: world.coralEnvSnapshot,
    ...(world.systemProviderScope === undefined ? {} : { systemProviderScope: world.systemProviderScope }),
    remoteAccess: world.remoteAccess,
    childPrincipals: world.childPrincipalRegistry,
    admin: {
      succession: succession.dispatch,
      getLifecycleState: () => runtimeState.getLifecycle(),
      isLifecycleRunning: () => runtimeState.getLifecycle() === 'running',
      isDrainRequested: control.isDrainRequested,
      isLaunchFenceActive: () => runtimeState.getLaunchFenceActive(),
      isSuccessionAdmissionPaused: () => world.launchCoordinator.successionAdmissionPaused(),
      admitTopLevelLaunch: () => world.launchCoordinator.admitTopLevelLaunch(),
      beginRequest: () => {
        world.idleTimer.beginRequest();
      },
      beginRequestLease: requestLeases.begin,
      endRequest: () => {
        world.idleTimer.endRequest();
      },
      requestDrain: control.requestDrain,
      decideLegacyShutdown: control.decideLegacyShutdown,
      probeKbDaemon: () => kbDaemonSupervisor.probe(),
      restartKbDaemon: (reason, signal) => kbDaemonSupervisorWithTrackedShutdown.restart(reason, signal),
    },
    health: {
      read: createCoordinatorHealthReader({
        runtime,
        world,
        options,
        runtimeState,
        lifecycleController: () => state.lifecycleController,
        retentionStatus: () => state.retentionStatus,
        strictHealthIdentity,
        strictHealthBundleDir,
        readSelfIncarnation,
        kbDaemonSupervisor,
        settlementRefusalRecordingFailures,
        providerOperationAdoptionRefusals,
        readIpcOpenSockets: () => state.readIpcOpenSockets(),
        eventStreamResponseCount: () => streamResponses.size,
        launchPermitReportAgeMs: launchPermitReportAgeMs,
        providerOperationStartupStatus: execution.services.providerOperationStartupStatus,
      }),
    },
    events: createCoordinatorEventStreamPorts({
      runtime,
      world,
      streamResponses,
      eventStreamSubscriptions,
      maxConnections: maxEventStreamConnections,
    }),
    ...rpcPorts,
  };

  const handleRequest = createHttpHandler(httpHandlerDeps);
  const ipcServer = createIpcServer(httpHandlerDeps);
  state.readIpcOpenSockets = () => ipcServer.sockets.size;

  const server = defaults.createServerFn((req, res) => {
    void handleRequest(req, res).catch((error) => {
      world.log(`Backend request error: ${formatError(error)}\n`);
      if (!res.headersSent) {
        const response = buildTransportErrorResponse(error);
        sendJson(res, response.statusCode, response.body);
        return;
      }
      res.destroy();
    });
  });

  return { requestLeases, handleRequest, ipcServer, server };
}
