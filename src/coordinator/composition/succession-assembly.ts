import { formatError } from '../../infra/error-format.js';
import { type ProcessIncarnation } from '../../infra/node-process.js';
import { installedBuild } from '../../infra/installed-build-root.js';
import { localProviderHostRoot, resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { createForeignTargetValidator } from '../../infra/handoff-target.js';
import { readUpgradeIntent, type UpgradeIntent } from '../../infra/upgrade-intent.js';
import { recoverJobLocations } from '../../jobs/location-recovery.js';
import { isTerminalPhase } from '../../jobs/phase.js';
import { readSuccessionCustodyJobIds, readSuccessionLiveJobIds } from '../../jobs/succession-coverage.js';
import { createRealSuccessionAttemptPorts } from '../../runtime/succession-attempt.js';
import { readCustodyLedger } from '../../store/custody-ledger.js';
import {
  discardUnservedRetirementMint,
  encodeResolvedStoreEpoch,
  inspectCurrentStore,
} from '../../store/epoch/index.js';
import { readProviderOperations } from '../../store/provider-operation-journal.js';
import { observeSuccessionServing } from '../../store/succession-writer-generation.js';
import type { createIpcServer } from '../../transport/ipc/server.js';
import type { KbDaemonSupervisor } from '../live/kb-daemon-supervisor/index.js';
import { RetiringCustodyCertificate } from '../services/recovery/epoch-closure.js';
import { currentSuccessionAttemptChild, startSuccessionAttempt } from '../succession/attempt-child.js';
import { createSuccessionCommitter } from '../succession/commit/index.js';
import { createSuccessionCoordinator } from '../succession/index.js';
import { NO_SUCCESSION_INTERPOSITION } from '../succession/interposition.js';
import { createProviderHostTransfer } from '../succession/provider-host-transfer.js';
import type { createCoordinatorCoreContext } from './core-context.js';
import { createCustodyReconciliationScheduler } from './custody-reconciliation-scheduler.js';
import type { createCoordinatorExecutionAssembly } from './execution-assembly.js';
import type { createProviderHostOwners } from './provider-host-owners.js';
import { createSuccessionOwners } from './succession-owners/index.js';
import type { CoordinatorCoreOptions } from './types.js';

type CoreContext = ReturnType<typeof createCoordinatorCoreContext>;
type ProviderHostOwners = ReturnType<typeof createProviderHostOwners>;

export function createSuccessionJobView(core: CoreContext, providerHostOwners: ProviderHostOwners) {
  const { runtime, world, state, getProgressStore } = core;
  const { localProviderHosts, holdsProviderHost } = providerHostOwners;
  const readSelfIncarnation = (): ProcessIncarnation | null => {
    try {
      state.rememberedSelfIncarnation ??= runtime.process.readProcessIncarnation(
        world.backendPid,
        runtime.env.platform() as NodeJS.Platform,
      );
    } catch {
      return null;
    }
    return state.rememberedSelfIncarnation;
  };

  const { arm: armCustodyReconciliation } = createCustodyReconciliationScheduler({
    runtime,
    world,
    selectedStoreEpochPath: () => state.selectedStoreEpochPath,
  });

  const readSuccessionJobs = () => {
    const db = getProgressStore().getDb();
    const operationIds = [
      ...readProviderOperations(db).records.map((record) => record.operation.jobId),
      ...world.operationRegistry.liveJobIds(),
    ];
    const hostIds =
      localProviderHosts
        .listProviderHosts?.()
        .filter(holdsProviderHost)
        .map((record) => record.host.ownerJobId)
        .filter((jobId): jobId is string => typeof jobId === 'string') ?? [];
    const recoveryIds = [...(state.lifecycleController?.getRecoveryRegistry() ?? [])].map(([jobId]) => jobId);
    const custodyIds =
      state.selectedStoreEpochPath === null
        ? []
        : readSuccessionCustodyJobIds(readCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir), {
            epochPath: state.selectedStoreEpochPath,
            lineageKey: state.selectedStoreEpochKey,
          });
    // Only custody reconciliation binds or proves absent what keeps these ids live, so it must be running.
    if (custodyIds.length > 0) armCustodyReconciliation();
    return readSuccessionLiveJobIds(
      db,
      world.launchCoordinator.pendingLaunchJobIds(),
      [
        ...world.launchCoordinator.activeLaunchPermits().map((permit) => permit.jobId),
        ...operationIds,
        ...hostIds,
        ...recoveryIds,
      ],
      custodyIds,
    );
  };
  const liveProviderHosts = () => {
    if (localProviderHosts.listProviderHosts === undefined) throw new Error('provider host inventory unavailable');
    return localProviderHosts.listProviderHosts().filter(holdsProviderHost);
  };
  return { readSelfIncarnation, armCustodyReconciliation, readSuccessionJobs, liveProviderHosts };
}

type SuccessionAssemblyInput = Readonly<{
  core: CoreContext;
  options: CoordinatorCoreOptions;
  execution: ReturnType<typeof createCoordinatorExecutionAssembly>;
  jobView: ReturnType<typeof createSuccessionJobView>;
  kbDaemonSupervisorWithTrackedShutdown: KbDaemonSupervisor;
  getIpcServer: () => ReturnType<typeof createIpcServer>;
  subscribeObligationChanges: (notify: () => void) => () => void;
  isTerminalDiscussStatus: (status: string) => boolean;
}>;

function assembleSuccessionCommitter(
  input: SuccessionAssemblyInput,
  providerHostTransfer: ReturnType<typeof createProviderHostTransfer>,
  readSuccessionJobs: ReturnType<typeof createSuccessionJobView>['readSuccessionJobs'],
  getReconciler: () => ReturnType<typeof createSuccessionCoordinator>['reconciler'],
) {
  const { core, options, kbDaemonSupervisorWithTrackedShutdown, getIpcServer } = input;
  const {
    runtime,
    world,
    state,
    identity,
    strictHealthIdentity,
    strictHealthBundleDir,
    runtimeState,
    jobLocationIndex,
    getProgressStore,
    getStoreServices,
  } = core;
  const successionInterposition = options.successionInterposition ?? NO_SUCCESSION_INTERPOSITION;
  const successionCommitter = createSuccessionCommitter({
    runtime,
    log: world.log,
    listener: () => getIpcServer(),
    incumbent: {
      instanceId: identity.instanceId,
      pluginRoot: identity.pluginRoot,
      storeFormatFingerprint: options.storeFormat.fingerprint,
      build:
        strictHealthIdentity.ok && strictHealthBundleDir !== null
          ? { manifest: strictHealthIdentity.manifest, bundleDir: strictHealthBundleDir }
          : null,
    },
    reconciler: getReconciler,
    writers: () => state.lifecycleController,
    kbDaemon: kbDaemonSupervisorWithTrackedShutdown,
    launchCoordinator: world.launchCoordinator,
    providerHosts: providerHostTransfer,
    setLaunchFenceActive: (active) => runtimeState.setLaunchFenceActive(active),
    waitHandover: {
      abort: () => state.waitHandover.abort(),
      renew: () => {
        state.waitHandover = new AbortController();
      },
    },
    liveJobIds: readSuccessionJobs,
    retiringEpoch: {
      certificate: (epochKey) => jobLocationIndex.certificate(epochKey),
      resultsReleased: (epochKey) => jobLocationIndex.resultsReleased(epochKey),
      recoverLocations: (epochKey) => recoverJobLocations(jobLocationIndex, epochKey, getProgressStore()),
      certifyCustody: (epochKey, signal) =>
        RetiringCustodyCertificate.certify(runtime, jobLocationIndex, epochKey, signal),
      confirmCustody: (certificate, signal) => certificate.confirm(runtime, jobLocationIndex, signal),
    },
    storeDb: () => getStoreServices().storeDb,
    startAttempt: ({ intent, preparation, recoveryBundleDir }) =>
      startSuccessionAttempt({
        ports: createRealSuccessionAttemptPorts(),
        intent,
        preparation,
        listener: getIpcServer(),
        bootToken: identity.bootToken,
        ...(recoveryBundleDir === undefined ? {} : { recoveryBundleDir }),
      }),
    interposition: successionInterposition,
  });
  return successionCommitter;
}

export function createCoordinatorSuccessionAssembly(input: SuccessionAssemblyInput) {
  const {
    core,
    options,
    execution,
    jobView,
    kbDaemonSupervisorWithTrackedShutdown,
    subscribeObligationChanges,
    isTerminalDiscussStatus,
  } = input;
  const {
    runtime,
    world,
    state,
    identity,
    getProgressStore,
    getRecoveryQuarantineStore,
    storeServicesRef,
    kbDaemonSupervisor,
  } = core;
  const { discuss } = execution;
  const { readSelfIncarnation, readSuccessionJobs, liveProviderHosts } = jobView;
  const providerHostTransfer = createProviderHostTransfer({
    runtime,
    flavor: identity.flavor,
    buildSetId: identity.buildSetId,
    lifecycle: () => world.providerProxyLifecycleRef.get(),
    db: () => getProgressStore().getDb(),
    jobSettled: (jobId) => {
      const status = getProgressStore().readStatus(jobId);
      return status !== null && isTerminalPhase(status.phase);
    },
    localOperationJobIds: () => world.operationRegistry.liveJobIds(),
    hostInstalledRootAvailable: (buildSetId) => {
      if (buildSetId !== identity.buildSetId) return installedBuild(buildSetId) !== null;
      const running = resolveStrictBundleIdentity();
      return (
        running.ok &&
        running.manifest.buildSetId === buildSetId &&
        createForeignTargetValidator()(localProviderHostRoot(), running.manifest).kind === 'validated'
      );
    },
    attemptId: () => currentSuccessionAttemptChild()?.attemptId ?? null,
    targetChangesStoreFormat: () => {
      const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
      return (
        observed.kind !== 'readable' ||
        observed.intent.target.build.storeFormatFingerprint !== options.storeFormat.fingerprint
      );
    },
    log: world.log,
  });
  const successionOwners = createSuccessionOwners({
    runtime,
    world,
    getProgressStore,
    getRecoveryQuarantineStore,
    lifecycleController: () => state.lifecycleController,
    kbDaemonSupervisor,
    discuss,
    providerHostTransfer,
    liveProviderHosts,
    readSuccessionJobs,
    isTerminalDiscussStatus,
  });
  const successionIncumbent = (): UpgradeIntent['incumbent'] => ({
    instanceId: identity.instanceId,
    pid: world.backendPid,
    incarnation: readSelfIncarnation(),
    version: identity.version,
    bundleHash: identity.bundleHash,
    flavor: identity.flavor,
  });
  const successionCommitter = assembleSuccessionCommitter(
    input,
    providerHostTransfer,
    readSuccessionJobs,
    () => succession.reconciler,
  );
  const succession = createSuccessionCoordinator({
    runtime,
    runDir: runtime.paths.coral.coordinator.runDir,
    incumbent: successionIncumbent,
    runningBuildSetId: identity.buildSetId,
    owners: successionOwners,
    liveJobIds: readSuccessionJobs,
    storeFormatFingerprint: options.storeFormat.fingerprint,
    epochKey: () => {
      if (storeServicesRef.tryGet() === null) return null;
      const inspection = inspectCurrentStore(runtime);
      return inspection.kind === 'current' ? encodeResolvedStoreEpoch(runtime, inspection.epoch) : null;
    },
    admissionRevision: () => world.launchCoordinator.admissionRevision(),
    observeServing: (attemptId) => observeSuccessionServing(runtime, attemptId),
    retirementServing: successionCommitter.retirementServes,
    commitAvailable:
      kbDaemonSupervisorWithTrackedShutdown.parkWriterTurn !== undefined &&
      kbDaemonSupervisorWithTrackedShutdown.reclaimWriterTurn !== undefined,
    launchPrepared: successionCommitter.launchPrepared,
    discardUnservedMint: (incumbentEpochKey, attemptId) =>
      discardUnservedRetirementMint(runtime, incumbentEpochKey, attemptId),
    subscribeObligationChanges: (notify) => {
      state.notifySuccessionObligationChange = notify;
      const unsubscribe = subscribeObligationChanges(notify);
      return () => {
        state.notifySuccessionObligationChange = () => {};
        unsubscribe();
      };
    },
    onReconcileError: (error) => world.log(`Succession reconciliation failed: ${formatError(error)}\n`),
  });

  return { providerHostTransfer, successionIncumbent, successionCommitter, succession };
}
