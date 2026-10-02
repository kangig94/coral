import type { RetentionRunStatus } from '../../store/retention-outcome.js';
import { JobLocationIndex } from '../../jobs/location-index.js';
import { resolveRunningBundleDir, resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { RecoveryQuarantineStore } from '../../recovery/quarantine.js';
import type { ProcessIncarnation } from '../../infra/node-process.js';
import type { KbJobRecorder } from '../../jobs/kb/recorder.js';
import { encodeResolvedStoreEpoch, inspectCurrentStore, type ResolvedStoreEpoch } from '../../store/epoch/index.js';
import { createRuntimeState, type LifecycleController } from '../lifecycle.js';
import { createRuntimeComponentRegistry } from '../runtime-components/registry.js';
import { resolveCoordinatorDefaults } from './defaults.js';
import type { createExecutionServices } from './execution-services.js';
import { createCoordinatorWorld, createStartupRecoveryBarrier } from './world.js';
import { storeServicesStartupNotReadyError } from './store-services-ref.js';
import type { CoordinatorCoreOptions } from './types.js';
import { canonicalizeWorkDir, type CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';

export function createCoordinatorCoreContext(options: CoordinatorCoreOptions) {
  const runtime = options.runtime;

  const defaultsPlan = resolveCoordinatorDefaults(options, runtime);
  const startupRecoveryBarrier = createStartupRecoveryBarrier();
  const world = createCoordinatorWorld(options, runtime, defaultsPlan, startupRecoveryBarrier.read);
  const components = createRuntimeComponentRegistry();
  const runtimeState = createRuntimeState(world.now(), components);
  const kbDaemonSupervisor = options.kbDaemonSupervisor;
  const identity = world.identity;
  const strictHealthIdentity = resolveStrictBundleIdentity();
  const strictHealthBundleDir = strictHealthIdentity.ok ? resolveRunningBundleDir(world.pluginRoot) : null;
  const storeServicesRef = world.storeServicesRef;
  const getStoreServices = () => {
    const storeServices = storeServicesRef.tryGet();
    if (storeServices === null) {
      throw storeServicesStartupNotReadyError();
    }
    return storeServices;
  };
  const getProgressStore = () => getStoreServices().progressStore;
  const jobLocationIndex = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  const state = {
    retentionStatus: null as RetentionRunStatus | null,
    selectedStoreEpochKey: null as string | null,
    selectedJobEpochKey: null as string | null,
    selectedStoreEpochPath: null as string | null,
    openedStoreEpoch: null as ResolvedStoreEpoch | null,
    lifecycleController: null as LifecycleController | null,
    readIpcOpenSockets: () => 0,
    notifySuccessionObligationChange: (): void => {},
    adoptRepairedProviderOperation: (async () => ({
      kind: 'refused',
      reason: 'the coordinator execution services are not composed',
      remedy: { kind: 'restart-coordinator' },
    })) as ReturnType<typeof createExecutionServices>['adoptRepairedProviderOperation'],
    releaseUnreadableProviderOperationStartupOwnership: (async () => ({
      kind: 'completed',
      releasedLaunchPermits: 0,
    })) as ReturnType<typeof createExecutionServices>['releaseUnreadableProviderOperationStartupOwnership'],
    waitHandover: new AbortController(),
    rememberedSelfIncarnation: null as ProcessIncarnation | null,
    kbJobRecorder: null as KbJobRecorder | null,
  };
  const currentJobEpochKey = (): string | null => {
    if (state.selectedJobEpochKey !== null) return state.selectedJobEpochKey;
    const inspection = inspectCurrentStore(runtime);
    return inspection.kind === 'current' ? encodeResolvedStoreEpoch(runtime, inspection.epoch) : null;
  };
  const getRecoveryQuarantineStore = () => new RecoveryQuarantineStore(getProgressStore().getDb(), runtime.time);
  const createSystemInvocationContext = (
    projectRoot: CanonicalWorkDir,
    credentialId: string,
    coralEnv: Record<string, string> = {},
  ): InvocationContext => ({
    projectRoot,
    pluginRoot: identity.pluginRoot,
    coralEnv,
    principal: {
      subject: 'system',
      transport: 'internal',
      credential: { kind: 'internal', id: credentialId },
      binding: { kind: 'project', root: projectRoot },
    },
  });
  const createRecoveryInvocationContext = (rawProjectRoot: string): InvocationContext => {
    const projectRoot = canonicalizeWorkDir(rawProjectRoot, runtime.env.cwd());
    return createSystemInvocationContext(projectRoot, 'recovery-retry');
  };
  return {
    runtime,
    defaultsPlan,
    startupRecoveryBarrier,
    world,
    runtimeState,
    kbDaemonSupervisor,
    identity,
    strictHealthIdentity,
    strictHealthBundleDir,
    storeServicesRef,
    getStoreServices,
    getProgressStore,
    jobLocationIndex,
    state,
    currentJobEpochKey,
    getRecoveryQuarantineStore,
    createSystemInvocationContext,
    createRecoveryInvocationContext,
  };
}
