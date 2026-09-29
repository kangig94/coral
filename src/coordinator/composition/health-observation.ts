import { monitorEventLoopDelay } from 'node:perf_hooks';

import { type resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { readUpgradeIntent, upgradeIntentProblem, visibleUpgradeIntent } from '../../infra/upgrade-intent.js';
import type { ProcessIncarnation } from '../../infra/node-process.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { Runtime } from '../../runtime/ports.js';
import { listAttachedSessions } from '../../discuss/shell/live-registry.js';
import { isLivePhase } from '../../jobs/phase.js';
import type { LaunchPermitReclamationDiagnostic, LaunchReleaseDiagnostic } from '../../jobs/contracts/admission.js';
import type { HealthSnapshot } from '../../transport/server-ports.js';
import { type createRuntimeState, type LifecycleController } from '../lifecycle.js';
import type { KbDaemonSupervisor } from '../live/kb-daemon-supervisor/index.js';
import { admittedByThisCoordinator, classifyLocalCarriers } from './carrier-observation.js';
import { type createCoordinatorWorld } from './world.js';
import type { CoordinatorCoreOptions } from './types.js';

let eventLoopDelayMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null;

function readEventLoopLagMs(): number {
  if (eventLoopDelayMonitor === null) {
    eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelayMonitor.enable();
    return 0;
  }

  const meanNs = eventLoopDelayMonitor.mean;
  if (!Number.isFinite(meanNs)) {
    return 0;
  }
  return Math.max(0, Math.round(meanNs / 1_000_000));
}

function readFdCount(storage: Pick<StoragePort, 'readdirSync'>): number | undefined {
  try {
    return storage.readdirSync('/proc/self/fd').length;
  } catch {
    return undefined;
  }
}

function readResourceSnapshot(
  storage: Pick<StoragePort, 'readdirSync'>,
  ipcOpenSockets: number,
  eventStreamResponses: number,
): NonNullable<HealthSnapshot['resources']> {
  const memory = process.memoryUsage();
  const fdCount = readFdCount(storage);
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    eventLoopLagMs: readEventLoopLagMs(),
    ipcOpenSockets,
    eventStreamResponses,
    ...(fdCount === undefined ? {} : { fdCount }),
  };
}

function readCarrierHealth(
  world: ReturnType<typeof createCoordinatorWorld>,
  platform: NodeJS.Platform,
  storeServices: ReturnType<ReturnType<typeof createCoordinatorWorld>['storeServicesRef']['tryGet']>,
) {
  let activeJobs = 0;
  let carrierLivenessByJobId = new Map<string, 'live' | 'absent' | 'unknown'>();
  let carrierDiagnostics: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['carriers']>;
  if (storeServices === null) {
    carrierDiagnostics = {
      coverage: 'unknown',
      liveJobs: 0,
      unknownJobs: activeJobs,
      recoveryDefectJobs: 0,
    };
  } else {
    const progressStore = storeServices.progressStore;
    try {
      const jobIds = progressStore.listStoredNonterminalJobIds();
      const observedMaxJournalSeq =
        progressStore.getDb().prepare<[], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()
          ?.seq ?? 0;
      const observations = classifyLocalCarriers(
        jobIds,
        {
          getDb: () => progressStore.getDb(),
          loadJobProjectionDetail: (jobId) => progressStore.loadJobProjectionDetail(jobId),
          platform,
          hasStartupRecoveryPassed: () => world.startupRecoveryBarrier.hasPassed(),
          isAdmittedByThisCoordinator: (jobId) => admittedByThisCoordinator(world.launchCoordinator, jobId),
          registryStateForJob: (jobId) => world.operationRegistry.stateForJob(jobId),
        },
        observedMaxJournalSeq,
      );
      if (
        observations.length !== jobIds.length ||
        observations.some(({ observation }) => !isLivePhase(observation.storedPhase))
      ) {
        throw new Error('carrier_health_projection_mapping_incomplete');
      }
      const liveJobs = observations.filter(({ observation }) => observation.liveness === 'live').length;
      const unknownJobs = observations.filter(({ observation }) => observation.liveness === 'unknown').length;
      const recoveryDefectJobs = observations.filter(
        ({ observation }) => observation.defect === 'local-unknown-after-recovery-decision',
      ).length;
      carrierLivenessByJobId = new Map(observations.map(({ jobId, observation }) => [jobId, observation.liveness]));
      activeJobs = liveJobs + unknownJobs;
      carrierDiagnostics = { coverage: 'complete', liveJobs, unknownJobs, recoveryDefectJobs };
    } catch {
      try {
        activeJobs = progressStore.liveJobCount();
      } catch {
        activeJobs = 0;
      }
      carrierDiagnostics = {
        coverage: 'unknown',
        liveJobs: 0,
        unknownJobs: activeJobs,
        recoveryDefectJobs: 0,
      };
    }
  }

  return { activeJobs, carrierLivenessByJobId, carrierDiagnostics };
}

type HealthDiagnosticInput = Pick<
  Parameters<typeof createCoordinatorHealthReader>[0],
  | 'world'
  | 'options'
  | 'settlementRefusalRecordingFailures'
  | 'providerOperationAdoptionRefusals'
  | 'launchPermitReportAgeMs'
> & {
  storeServices: ReturnType<ReturnType<typeof createCoordinatorWorld>['storeServicesRef']['tryGet']>;
  kbDaemon: ReturnType<KbDaemonSupervisor['read']>;
  carrier: ReturnType<typeof readCarrierHealth>;
};

function readHealthDiagnostics(input: HealthDiagnosticInput) {
  const {
    world,
    options,
    storeServices,
    kbDaemon,
    settlementRefusalRecordingFailures,
    providerOperationAdoptionRefusals,
    launchPermitReportAgeMs,
  } = input;
  const { carrierDiagnostics, carrierLivenessByJobId } = input.carrier;
  const consumerStuck: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['consumerStuck']> =
    storeServices === null ? [] : (options.getConsumerStuck() ?? []);
  const mutationBlocked = kbDaemon.kbWrite?.mutationBlocked;
  const diagnostics: {
    carriers?: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['carriers']>;
    mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
    consumerStuck?: NonNullable<HealthSnapshot['diagnostics']>['consumerStuck'];
    providerProxySets?: NonNullable<HealthSnapshot['diagnostics']>['providerProxySets'];
    providerProxyDispositionSkips?: NonNullable<
      NonNullable<HealthSnapshot['diagnostics']>['providerProxyDispositionSkips']
    >;
    settlementRefusalRecordingFailures?: NonNullable<
      NonNullable<HealthSnapshot['diagnostics']>['settlementRefusalRecordingFailures']
    >;
    providerOperationAdoptionRefusals?: NonNullable<
      NonNullable<HealthSnapshot['diagnostics']>['providerOperationAdoptionRefusals']
    >;
    launchPermits?: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['launchPermits']>;
    launchReleaseDispositions?: LaunchReleaseDiagnostic[];
    launchReclamations?: LaunchPermitReclamationDiagnostic[];
  } = { carriers: carrierDiagnostics };
  if (mutationBlocked !== undefined) {
    diagnostics.mutationBlocked = mutationBlocked;
  }
  if (consumerStuck.length > 0) {
    diagnostics.consumerStuck = consumerStuck;
  }
  const providerProxySnapshot = world.providerProxyLifecycleRef.get()?.snapshot();
  const providerProxySets = [...(providerProxySnapshot?.operatorSets ?? [])] satisfies NonNullable<
    NonNullable<HealthSnapshot['diagnostics']>['providerProxySets']
  >;
  if (providerProxySets.length > 0) {
    diagnostics.providerProxySets = providerProxySets;
  }
  const providerProxyDispositionSkips = providerProxySnapshot?.skippedDurableOperatorDispositions ?? [];
  if (providerProxyDispositionSkips.length > 0) {
    diagnostics.providerProxyDispositionSkips = [...providerProxyDispositionSkips];
  }
  if (settlementRefusalRecordingFailures.size > 0) {
    diagnostics.settlementRefusalRecordingFailures = [...settlementRefusalRecordingFailures.values()];
  }
  if (providerOperationAdoptionRefusals.size > 0) {
    diagnostics.providerOperationAdoptionRefusals = [...providerOperationAdoptionRefusals.values()];
  }
  const launchPermits = world.launchCoordinator
    .activeLaunchPermits()
    .filter(
      ({ jobId, heldForMs }) => heldForMs > launchPermitReportAgeMs || carrierLivenessByJobId.get(jobId) !== 'live',
    );
  if (launchPermits.length > 0) {
    diagnostics.launchPermits = launchPermits;
  }
  const launchReleaseDispositions = world.launchCoordinator.launchReleaseDiagnostics();
  if (launchReleaseDispositions.length > 0) {
    diagnostics.launchReleaseDispositions = launchReleaseDispositions;
  }
  const launchReclamations = world.launchCoordinator.launchReclamationDiagnostics();
  if (launchReclamations.length > 0) {
    diagnostics.launchReclamations = launchReclamations;
  }
  const hasDiagnostics =
    diagnostics.carriers !== undefined ||
    diagnostics.mutationBlocked !== undefined ||
    diagnostics.consumerStuck !== undefined ||
    diagnostics.providerProxySets !== undefined ||
    diagnostics.providerProxyDispositionSkips !== undefined ||
    diagnostics.settlementRefusalRecordingFailures !== undefined ||
    diagnostics.providerOperationAdoptionRefusals !== undefined ||
    diagnostics.launchPermits !== undefined ||
    diagnostics.launchReleaseDispositions !== undefined ||
    diagnostics.launchReclamations !== undefined;

  return { diagnostics, hasDiagnostics };
}

export function createCoordinatorHealthReader({
  runtime,
  world,
  options,
  runtimeState,
  lifecycleController,
  strictHealthIdentity,
  strictHealthBundleDir,
  readSelfIncarnation,
  kbDaemonSupervisor,
  settlementRefusalRecordingFailures,
  providerOperationAdoptionRefusals,
  readIpcOpenSockets,
  eventStreamResponseCount,
  launchPermitReportAgeMs,
}: {
  runtime: Runtime;
  world: ReturnType<typeof createCoordinatorWorld>;
  options: CoordinatorCoreOptions;
  runtimeState: ReturnType<typeof createRuntimeState>;
  lifecycleController: () => LifecycleController | null;
  strictHealthIdentity: ReturnType<typeof resolveStrictBundleIdentity>;
  strictHealthBundleDir: string | null;
  readSelfIncarnation: () => ProcessIncarnation | null;
  kbDaemonSupervisor: KbDaemonSupervisor;
  settlementRefusalRecordingFailures: ReadonlyMap<
    string,
    NonNullable<NonNullable<HealthSnapshot['diagnostics']>['settlementRefusalRecordingFailures']>[number]
  >;
  providerOperationAdoptionRefusals: ReadonlyMap<
    string,
    NonNullable<NonNullable<HealthSnapshot['diagnostics']>['providerOperationAdoptionRefusals']>[number]
  >;
  readIpcOpenSockets: () => number;
  eventStreamResponseCount: () => number;
  launchPermitReportAgeMs: number;
}): () => HealthSnapshot {
  const identity = world.identity;
  const storeServicesRef = world.storeServicesRef;
  return () => {
    const env = { ...world.coralEnvSnapshot };
    delete env.CORAL_SYSTEM_PROVIDER_SCOPE;
    const storeServices = storeServicesRef.tryGet();
    const lifecycleState = runtimeState.getLifecycle();
    const shutdownObservation = lifecycleController()?.observeShutdown();
    const upgrade = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    const succession = upgrade.kind === 'readable' ? visibleUpgradeIntent(upgrade.intent) : null;
    const successionProblem = upgradeIntentProblem(upgrade);
    let coarseStatus: 'starting' | 'ok' | 'draining';
    if (world.idleTimer.isDraining || lifecycleState === 'draining' || lifecycleState === 'stopped') {
      coarseStatus = 'draining';
    } else if (lifecycleState === 'running' && storeServices !== null) {
      coarseStatus = 'ok';
    } else {
      coarseStatus = 'starting';
    }
    const platform = runtime.env.platform() as NodeJS.Platform;
    const incarnation = readSelfIncarnation();

    const components = runtimeState.components.list().map((entry) => ({ ...entry, id: entry.id as string }));
    const kbDaemon = kbDaemonSupervisor.read();
    const systemProviderScope = world.systemProviderScope;
    const carrier = readCarrierHealth(world, platform, storeServices);
    const { activeJobs } = carrier;

    const { diagnostics, hasDiagnostics } = readHealthDiagnostics({
      world,
      options,
      storeServices,
      kbDaemon,
      carrier,
      settlementRefusalRecordingFailures,
      providerOperationAdoptionRefusals,
      launchPermitReportAgeMs,
    });

    const sentinelId = runtime.env.get('CORAL_SENTINEL_ID');
    return {
      status: coarseStatus,
      ...(succession === null ? {} : { succession }),
      ...(successionProblem === null ? {} : { successionProblem }),
      kernel: {
        phase: lifecycleState,
        readyAt: lifecycleState === 'starting' ? null : runtimeState.getStartedAt(),
      },
      version: identity.version,
      bundleHash: identity.bundleHash,
      ...(strictHealthIdentity.ok && strictHealthBundleDir !== null
        ? { manifest: strictHealthIdentity.manifest, bundleDir: strictHealthBundleDir }
        : {}),
      flavor: identity.flavor,
      namespace: identity.namespace,
      instanceId: identity.instanceId,
      pid: world.backendPid,
      ...(sentinelId === undefined ? {} : { sentinel: { version: 1 as const, id: sentinelId } }),
      ...(incarnation !== null ? { incarnation } : {}),
      uptimeMs: identity.now() - runtimeState.getStartedAt(),
      active: world.launchCoordinator.active,
      activeJobs,
      liveDiscuss: listAttachedSessions(world.discussRegistry).length,
      queueDepth: world.launchCoordinator.queueDepth(),
      inflightRequests: world.idleTimer.inflightRequests,
      textProjectionState: options.getTextProjectionState?.() ?? 'idle',
      resources: readResourceSnapshot(runtime.storage, readIpcOpenSockets(), eventStreamResponseCount()),
      components,
      kbDaemon,
      ...(shutdownObservation === undefined ? {} : { shutdown: shutdownObservation }),
      ...(hasDiagnostics ? { diagnostics } : {}),
      env,
      ...(systemProviderScope === undefined
        ? {}
        : {
            systemProviderScope: {
              name: systemProviderScope.name,
              providers: systemProviderScope.profiles.map((profile) => profile.provider).sort(),
            },
          }),
    };
  };
}
