import { hintHistoricalHydration } from '../../jobs/historical-reader.js';
import { join } from 'node:path';
import { deriveLaunchReadiness } from '../../jobs/launch-readiness.js';
import { JobAddressing } from '../../jobs/addressing.js';
import { historicalSourceReader } from '../../jobs/historical-reader.js';
import { canonicalWorkDirWireSchema, type CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { RpcPorts } from '../../transport/rpc/ports.js';
import type { ExpansionRequestPort } from '../../expansion/rpc-contract.js';
import { createCoordinatorRpcPorts } from './rpc-ports.js';
import type { createCoordinatorCoreContext } from './core-context.js';
import type { createCoordinatorExecutionAssembly } from './execution-assembly.js';
import type { createRecoveryAssembly } from './recovery-assembly.js';
import type { createProviderHostOwners } from './provider-host-owners.js';
import type { createProviderProxyContainment } from './provider-proxy-containment.js';

type CoreContext = ReturnType<typeof createCoordinatorCoreContext>;
type ExecutionAssembly = ReturnType<typeof createCoordinatorExecutionAssembly>;

export function createCoordinatorRequestPorts(input: {
  core: CoreContext;
  execution: ExecutionAssembly;
  readOnlyProjectRoot: CanonicalWorkDir;
  readOnlyInvocationContext: InvocationContext;
  recoveryQuarantine: ReturnType<typeof createRecoveryAssembly>['recoveryQuarantine'];
  providerHostAdministration: ReturnType<typeof createProviderHostOwners>['providerHostAdministration'];
  containProviderProxySet: ReturnType<typeof createProviderProxyContainment>['containProviderProxySet'];
  kbRpcPort: RpcPorts['kb'];
  expansion: ExpansionRequestPort;
  probeHistoricalClosure: (epochKey: string) => 'pending' | 'decided';
}) {
  const {
    core,
    execution,
    readOnlyProjectRoot,
    readOnlyInvocationContext,
    recoveryQuarantine,
    providerHostAdministration,
    containProviderProxySet,
    kbRpcPort,
    expansion,
    probeHistoricalClosure,
  } = input;
  const {
    runtime,
    world,
    state,
    jobLocationIndex,
    currentJobEpochKey,
    getProgressStore,
    createSystemInvocationContext,
  } = core;
  const { services, control, discuss } = execution;
  const activeJobDetail = (jobId: string) => {
    const progressStore = getProgressStore();
    const detail = progressStore.loadJobProjectionDetail(jobId);
    if (!detail.status) return null;
    return {
      status: detail.status,
      events: progressStore.readJobEvents(jobId),
      readiness: deriveLaunchReadiness(detail),
      exit: detail.exit,
    };
  };
  const jobAddressing = new JobAddressing(
    jobLocationIndex.readOnlyView(),
    {
      epochKey: currentJobEpochKey,
      detail: activeJobDetail,
      readWaitAdmissions: (jobIds, epochKey) =>
        services.getExecutionService(readOnlyInvocationContext).readWaitAdmissions?.(jobIds, epochKey) ?? [],
      observeWaitCarriers: (jobIds, signal) =>
        services.getExecutionService(readOnlyInvocationContext).observeWaitCarriers?.(jobIds, signal) ??
        Promise.resolve({ unknownJobIds: [...jobIds], interrupted: [], frontier: 0 }),
      readWaitAdmission: (jobId, epochKey) =>
        services.getExecutionService(readOnlyInvocationContext).readWaitAdmission?.(jobId, epochKey) ?? null,
      abort: control.abortJobs,
      waitStream: (request) =>
        services
          .getExecutionService(
            createSystemInvocationContext(
              request.projectRoot === undefined
                ? readOnlyProjectRoot
                : canonicalWorkDirWireSchema.parse(request.projectRoot),
              'coordinator-readonly',
              readOnlyInvocationContext.coralEnv,
            ),
          )
          .waitStream(request),
    },
    () =>
      [
        join(runtime.paths.coral.store.dbDir, 'store.db'),
        join(runtime.paths.coral.generation.legacyDataRoot, 'store', 'store.db'),
      ].some((path) => runtime.storage.existsSync(path)),
    (epochKey) => probeHistoricalClosure(epochKey),
    historicalSourceReader(jobLocationIndex),
    (jobId) => getProgressStore().getResultExportOwner().observeResultAvailability(jobId),
    (jobId) => {
      hintHistoricalHydration(jobLocationIndex, jobId);
      getProgressStore().getResultExportOwner().hintRepair(jobId);
    },
    (jobId) => getProgressStore().getResultExportOwner().progressRetentionExpired(jobId),
  );

  const rpcPorts = createCoordinatorRpcPorts({
    services,
    jobAddressing,
    waitHandoverSignal: () => state.waitHandover.signal,
    getProgressStore,
    world,
    recoveryQuarantine,
    providerHostAdministration,
    containProviderProxySet,
    kbRpcPort,
    discuss,
    expansion,
  });
  return { jobAddressing, rpcPorts };
}
