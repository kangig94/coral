import { createStorageRetentionScheduler } from './storage-retention-scheduler.js';
import { createHandoffRoutingReconciler } from '../handoff-routing/reconciler.js';
import { handoffRoutingStatusStoreSchema } from '../handoff-routing/status.js';
import { handoffRoutingStatusGeneration } from '../../store/handoff-routing-status-store/index.js';
import { handoffRoutingStatusPathForRunDir } from '../../infra/path/index.js';
import { dirname } from 'node:path';
import { knownDiscussSources } from '../../discuss/shell/session-read-service.js';
import { readOrCreateEpochKey } from '../../store/epoch/index.js';
import { encodeResolvedStoreEpoch, type ResolvedStoreEpoch } from '../../store/epoch/index.js';
import { closeIpcServer, listenIpcServer } from '../../transport/ipc/server.js';
import { createLifecycle, type LifecycleDeps, type RunStartupRecoveryOrchestratorFn } from '../lifecycle.js';
import type { KbDaemonSupervisor } from '../live/kb-daemon-supervisor/index.js';
import { createKbDaemonHealthComponent } from '../runtime-components/kb-health-component.js';
import { currentSuccessionAttemptChild } from '../succession/attempt-child.js';
import { NO_SUCCESSION_INTERPOSITION } from '../succession/interposition.js';
import type { createCoordinatorCoreContext } from './core-context.js';
import type { createCoordinatorExecutionAssembly } from './execution-assembly.js';
import type { connectLaunchEvidence } from './launch-evidence.js';
import { createLifecycleRecoveryDependencies } from './lifecycle-recovery-dependencies.js';
import type { createProviderProxyContainment } from './provider-proxy-containment.js';
import { createStoreEpochSweepScheduler } from './store-epoch-sweep-scheduler.js';
import type { createCoordinatorSuccessionAssembly, createSuccessionJobView } from './succession-assembly.js';
import type { createCoordinatorTransportAssembly } from './transport-assembly.js';
import type { CoordinatorCoreOptions } from './types.js';

type LifecycleAssemblyInput = Readonly<{
  core: ReturnType<typeof createCoordinatorCoreContext>;
  options: CoordinatorCoreOptions & Readonly<{ onFatalShutdownError: (error: unknown) => void }>;
  runStartupRecovery: RunStartupRecoveryOrchestratorFn;
  execution: ReturnType<typeof createCoordinatorExecutionAssembly>;
  evidence: ReturnType<typeof connectLaunchEvidence>;
  jobView: ReturnType<typeof createSuccessionJobView>;
  successionAssembly: ReturnType<typeof createCoordinatorSuccessionAssembly>;
  transport: ReturnType<typeof createCoordinatorTransportAssembly>;
  closeProxySetForEpochClosure: ReturnType<typeof createProviderProxyContainment>['closeProxySetForEpochClosure'];
  hostedKb: Readonly<{
    kbDaemonSupervisorWithTrackedShutdown: KbDaemonSupervisor;
    disposeChildPrincipalTerminalListeners: () => void;
    disposeKbDaemonExitListener: () => void;
    disposeDaemonJobTerminalListeners: () => void;
  }>;
}>;

function recordRecoveredStoreEpoch(
  core: ReturnType<typeof createCoordinatorCoreContext>,
  openStore: ResolvedStoreEpoch,
): void {
  const { runtime, world, state } = core;
  state.selectedStoreEpochKey = openStore.path === ':memory:' ? null : readOrCreateEpochKey(runtime, openStore);
  state.selectedJobEpochKey = openStore.path === ':memory:' ? null : encodeResolvedStoreEpoch(runtime, openStore);
  state.selectedStoreEpochPath = openStore.path === ':memory:' ? null : dirname(openStore.path);
  state.openedStoreEpoch = openStore.path === ':memory:' ? null : openStore;
  if (state.selectedStoreEpochPath !== null)
    world.launchCoordinator.bindActiveEpochPath(state.selectedStoreEpochPath, state.selectedStoreEpochKey);
}

async function disposeCoordinatorLifecycleReactor(input: LifecycleAssemblyInput): Promise<void> {
  const { core, options, evidence, successionAssembly, hostedKb } = input;
  successionAssembly.succession.reconciler.dispose();
  core.runtime.time.clearInterval(evidence.launchReclamationTimer);
  hostedKb.disposeChildPrincipalTerminalListeners();
  hostedKb.disposeKbDaemonExitListener();
  hostedKb.disposeDaemonJobTerminalListeners();
  await options.disposeLifecycleReactor?.();
}

function createCoordinatorLifecycleDeps(
  input: LifecycleAssemblyInput,
  storeEpochSweep: ReturnType<typeof createStoreEpochSweepScheduler>,
  storageRetention: ReturnType<typeof createStorageRetentionScheduler>,
  routingReconciler: ReturnType<typeof createHandoffRoutingReconciler>,
): LifecycleDeps {
  const { core, options, execution, jobView, successionAssembly, transport, hostedKb } = input;
  const {
    runtime,
    world,
    state,
    identity,
    runtimeState,
    storeServicesRef,
    jobLocationIndex,
    getProgressStore,
    startupRecoveryBarrier,
  } = core;
  const { defaults, createStoreServicesFromDbFn, streamResponses, services, discuss } = execution;
  const { readSelfIncarnation, armCustodyReconciliation, readSuccessionJobs } = jobView;
  const { providerHostTransfer, successionIncumbent, successionCommitter, succession } = successionAssembly;
  const { server, ipcServer } = transport;
  const { kbDaemonSupervisorWithTrackedShutdown } = hostedKb;
  const successionInterposition = options.successionInterposition ?? NO_SUCCESSION_INTERPOSITION;
  const lifecycleDeps: LifecycleDeps = {
    identity,
    storeFormat: options.storeFormat,
    runtime,
    backendPid: world.backendPid,
    runtimeState: {
      ...runtimeState,
      setLifecycle: (phase) => {
        runtimeState.setLifecycle(phase);
        if (phase === 'kernel-ready' || phase === 'running') routingReconciler.start();
        if (phase === 'draining' || phase === 'stopped') routingReconciler.stop();
      },
    },
    idleTimer: world.idleTimer,
    storeServicesRef,
    createStoreServicesFromDbFn,
    ...createLifecycleRecoveryDependencies({
      runtime,
      identity,
      jobLocationIndex,
      providerHostTransfer,
      getProgressStore,
      readSuccessionJobs,
      world,
      onOpenedStore: (openStore) => recordRecoveredStoreEpoch(core, openStore),
    }),
    streamResponses,
    discussStores: discuss.discussStores,
    eventBus: world.eventBus,
    launchCoordinator: world.launchCoordinator,
    providerRegistry: world.providerRegistry,
    ...(world.systemProviderScope === undefined ? {} : { systemProviderScope: world.systemProviderScope }),
    server,
    getExecutionService: services.getExecutionService,
    getRecoveryService: services.getRecoveryService,
    listExecutionServices: services.listExecutionServices,
    connectProviderOperationRecovery: services.connectProviderOperationRecovery,
    reconcileProviderOperationsAtStartup: services.reconcileProviderOperationsAtStartup,
    reconcileCustodyAtStartup: () => armCustodyReconciliation(),
    startProviderOperationReconciler: services.startProviderOperationReconciler,
    wakeProviderOperationReconciler: services.wakeProviderOperationReconciler,
    stopProviderOperationReconciler: services.stopProviderOperationReconciler,
    startupRecoveryBarrierPublisher: startupRecoveryBarrier.publication,
    scheduleStoreEpochSweepFn: storeEpochSweep.schedule,
    startStorageRetentionFn: storageRetention.start,
    stopStoreEpochSweepFn: async () => {
      await storageRetention.stop();
      await storeEpochSweep.stop();
    },
    getDiscussStoreForSource: discuss.getDiscussStoreForSource,
    knownDiscussSources: () => knownDiscussSources(discuss.readHelpersDeps),
    getDiscussContext: discuss.getDiscussContext,
    writeBackendInfoFn: defaults.writeBackendInfoFn,
    removeBackendInfoIfOwnerFn: defaults.removeBackendInfoIfOwnerFn,
    cleanupStaleJobsFn: defaults.cleanupStaleJobsFn,
    readSelfIncarnationFn: readSelfIncarnation,
    successionIncumbent,
    markJobsAsErrorFn: defaults.markJobsAsErrorFn,
    settlePendingLaunchesFn: defaults.settlePendingLaunchesFn,
    terminateRegisteredChildrenFn: defaults.terminateRegisteredChildrenFn,
    providerHostManager: world.providerHostManager,
    onRecoverySettlement: () => state.notifySuccessionObligationChange(),
    ...(world.providerProxyAuthority === undefined ? {} : { providerProxyAuthority: world.providerProxyAuthority }),
    kbDaemonSupervisor: kbDaemonSupervisorWithTrackedShutdown,
    disposeLifecycleReactor: () => disposeCoordinatorLifecycleReactor(input),
    handoffQuiescePorts: () =>
      services
        .listExecutionServices()
        .filter(
          (svc): svc is typeof svc & { quiesceAppServerJobsForHandoff: () => Promise<void> } =>
            typeof (svc as { quiesceAppServerJobsForHandoff?: unknown }).quiesceAppServerJobsForHandoff === 'function',
        ),
    createKbHealthComponentFn: () => createKbDaemonHealthComponent(kbDaemonSupervisorWithTrackedShutdown),
    registerBuiltInProvidersFn: defaults.registerBuiltInProvidersFn,
    recoverPersistedDiscussFn: defaults.recoverPersistedDiscussFn,
    hooks: discuss.hooks,
    closeServerFn: defaults.closeServerFn,
    listenFn: defaults.listenFn,
    ipcServer,
    closeIpcServerFn: closeIpcServer,
    handoffDrainBudgetMs: options.handoffDrainBudgetMs,
    listenIpcFn:
      options.listenIpcFn ??
      ((listener, additionalCompatibilitySocketPaths = [], publishedCompatibilitySocketAddresses = []) =>
        listenIpcServer(
          listener,
          runtime.paths.coral.coordinator.socketPath,
          additionalCompatibilitySocketPaths,
          publishedCompatibilitySocketAddresses,
        )),
    onStopped: options.onStopped,
    onSuccessionServing: (attemptId) =>
      successionCommitter.publishServing(attemptId, currentSuccessionAttemptChild()?.recovery === true),
    wakeSuccessionReconciler: () => succession.reconciler.notifyObligationChange(),
    succession: successionCommitter.shutdown,
    successionInterposition,
    ...(options.acceptProcessExitRemainder === undefined
      ? {}
      : { acceptProcessExitRemainder: options.acceptProcessExitRemainder }),
    onFatalShutdownError: options.onFatalShutdownError,
  };

  return lifecycleDeps;
}

export function createCoordinatorLifecycleAssembly(input: LifecycleAssemblyInput) {
  const { core, runStartupRecovery, transport, closeProxySetForEpochClosure } = input;
  const { runtime, world, state, jobLocationIndex } = core;
  const { ipcServer } = transport;
  const storeEpochSweep = createStoreEpochSweepScheduler({
    runtime,
    world,
    jobLocationIndex,
    selectedStoreEpochKey: () => state.selectedStoreEpochKey,
    onOpen: (openStore) => {
      state.selectedStoreEpochKey = openStore.path === ':memory:' ? null : readOrCreateEpochKey(runtime, openStore);
      state.selectedStoreEpochPath = openStore.path === ':memory:' ? null : dirname(openStore.path);
      state.openedStoreEpoch = openStore.path === ':memory:' ? null : openStore;
    },
    closeProxySetForEpochClosure,
  });

  const storageRetention = createStorageRetentionScheduler({
    runtime,
    getProgressStore: () => core.storeServicesRef.tryGet()?.progressStore ?? null,
    openEpoch: () => state.openedStoreEpoch,
    activeEpochKey: () => state.selectedJobEpochKey,
    jobLocations: jobLocationIndex,
    log: world.log,
    publish: (status) => {
      state.retentionStatus = { ...status, outcomes: [...status.outcomes] };
    },
    cleanupScratch: (signal, budget) =>
      input.execution.defaults.cleanupStaleJobsFn(core.identity.bundleHash, signal, budget),
  });
  const routingReconciler = createHandoffRoutingReconciler(
    runtime,
    handoffRoutingStatusPathForRunDir(
      runtime.paths.coral.coordinator.runDir,
      handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema()),
    ),
    () => world.log('Routing reconciliation failed; retained selections will be retried.\n'),
  );
  const lifecycleDeps = createCoordinatorLifecycleDeps(input, storeEpochSweep, storageRetention, routingReconciler);
  state.lifecycleController = createLifecycle(lifecycleDeps, runStartupRecovery);
  const resolvedLifecycleController = state.lifecycleController;
  ipcServer.onShutdownRecoveryAccepted = () => {
    resolvedLifecycleController.requestShutdownRetry();
  };

  return resolvedLifecycleController;
}
