import { createDiscussionCandidateRetryPlan, createDiscussionSourceRetryPlan } from '../../discuss/shell/recovery.js';
import type { createDiscussRuntime } from '../../discuss/shell/runtime-services.js';
import { formatError } from '../../infra/error-format.js';
import { createJobLocationRecoveryRetryPlan } from '../../jobs/location-recovery.js';
import {
  assertRecoverySourceRegistryComplete,
  COORDINATOR_JOB_RECOVERY_BOUNDARY,
  createRecoveryQuarantineRetryService,
  type createRecoverySourceRegistry,
  EPOCH_CLOSURE_BOUNDARY,
  SETTLED_UNBOUND_STATUS_BOUNDARY,
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
  type RecoveryRetryQuarantinePort,
} from '../../recovery/source-registry.js';
import {
  createRetentionReleasePairRetryPlan,
  createRetentionWorkRetryPlan,
  createSessionContinuationLeaseRetryPlan,
  createSessionProjectionRetryPlan,
  createTerminalRetentionOutcomeRetryPlan,
} from '../../sessions/lifecycle-reactor.js';
import type { HealthSnapshot } from '../../transport/server-ports.js';
import { createWorkflowRecoveryRetryPlan } from '../../workflow/recover.js';
import { createCrashedJobTerminalizationRetryPlan, createStaleJobCleanupRetryPlan } from '../lifecycle.js';
import { MAX_LAUNCH_RELEASE_DIAGNOSTICS } from '../live/admission.js';
import { createEpochClosureRetryPlan } from '../services/recovery/epoch-closure-retry-plan.js';
import {
  createCoordinatorJobRecoveryRetryPlan,
  createCoordinatorJobSettlementRefusalRecorder,
  createSettledUnboundStatusRetryPlan,
  createUnreadableProviderOperationRetryPlan,
} from '../services/recovery/index.js';
import type { createCoordinatorCoreContext } from './core-context.js';
import type { connectLaunchEvidence } from './launch-evidence.js';
import type { createProviderProxyContainment } from './provider-proxy-containment.js';
import { createRecoveryQuarantinePorts } from './recovery-quarantine-ports.js';
import { storeServicesStartupNotReadyError } from './store-services-ref.js';

type CoreContext = ReturnType<typeof createCoordinatorCoreContext>;
type LaunchEvidence = ReturnType<typeof connectLaunchEvidence>;
type RecoverySources = ReturnType<typeof createRecoverySourceRegistry>;
type RecoveryAssemblyInput = Readonly<{
  core: CoreContext;
  evidence: LaunchEvidence;
  recoverySources: RecoverySources;
  recoveryQuarantineStore: RecoveryRetryQuarantinePort;
  getDiscuss: () => ReturnType<typeof createDiscussRuntime>;
  getCloseProxySetForEpochClosure: () => ReturnType<
    typeof createProviderProxyContainment
  >['closeProxySetForEpochClosure'];
}>;

function registerRecoverySources(input: RecoveryAssemblyInput): void {
  const { core, evidence, recoverySources, getDiscuss, getCloseProxySetForEpochClosure } = input;
  const {
    runtime,
    world,
    state,
    jobLocationIndex,
    getProgressStore,
    currentJobEpochKey,
    createRecoveryInvocationContext,
  } = core;
  const { recoveryDb } = evidence;
  recoverySources.register(COORDINATOR_JOB_RECOVERY_BOUNDARY, (subject, signal, quarantine) =>
    createCoordinatorJobRecoveryRetryPlan(recoveryDb(), subject, signal, quarantine),
  );
  recoverySources.register('discussion-source', (subject, signal) =>
    createDiscussionSourceRetryPlan(
      {
        getDiscussContext: getDiscuss().getDiscussContext,
        createInvocationContext: createRecoveryInvocationContext,
        signal,
      },
      subject,
    ),
  );
  recoverySources.register('discussion-candidate', (subject, signal, quarantine) =>
    createDiscussionCandidateRetryPlan(
      {
        getDiscussContext: getDiscuss().getDiscussContext,
        createInvocationContext: createRecoveryInvocationContext,
        signal,
      },
      subject,
      quarantine,
    ),
  );
  recoverySources.register('session-projection', (subject, _signal, quarantine) =>
    createSessionProjectionRetryPlan(recoveryDb(), subject, quarantine),
  );
  recoverySources.register('session-continuation-lease', (subject, _signal, quarantine) =>
    createSessionContinuationLeaseRetryPlan(recoveryDb(), subject, quarantine),
  );
  recoverySources.register('terminal-retention-outcome', (subject, _signal, quarantine) =>
    createTerminalRetentionOutcomeRetryPlan(recoveryDb(), subject, quarantine),
  );
  recoverySources.register('retention-release-pair', (subject, _signal, quarantine) =>
    createRetentionReleasePairRetryPlan(recoveryDb(), subject, quarantine),
  );
  recoverySources.register('session-retention-work', (subject, signal, quarantine) =>
    createRetentionWorkRetryPlan(recoveryDb(), subject, signal, quarantine),
  );
  recoverySources.register('workflow-recovery', (subject) => createWorkflowRecoveryRetryPlan(recoveryDb(), subject));
  recoverySources.register('stale-job-cleanup', (subject) => createStaleJobCleanupRetryPlan(recoveryDb(), subject));
  recoverySources.register('crashed-job-terminalization', (subject) =>
    createCrashedJobTerminalizationRetryPlan(recoveryDb(), subject),
  );
  recoverySources.register('job-location-write-through', (subject) => {
    const epochKey = currentJobEpochKey();
    if (epochKey === null) throw storeServicesStartupNotReadyError();
    return createJobLocationRecoveryRetryPlan(jobLocationIndex, epochKey, getProgressStore(), subject);
  });
  recoverySources.register(EPOCH_CLOSURE_BOUNDARY, (subject, signal) =>
    createEpochClosureRetryPlan(
      runtime,
      jobLocationIndex,
      subject,
      signal,
      state.selectedStoreEpochKey,
      getCloseProxySetForEpochClosure(),
    ),
  );
  recoverySources.register(SETTLED_UNBOUND_STATUS_BOUNDARY, (subject, _signal, quarantine) =>
    createSettledUnboundStatusRetryPlan(recoveryDb(), subject, quarantine, (absence) =>
      world.launchCoordinator.releaseSettledUnboundStatusAfterObservedAbsence(absence),
    ),
  );
  recoverySources.register(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, (subject) =>
    createUnreadableProviderOperationRetryPlan(recoveryDb(), subject, state.adoptRepairedProviderOperation),
  );
  assertRecoverySourceRegistryComplete(recoverySources);
}

export function createRecoveryAssembly(input: RecoveryAssemblyInput) {
  const { core, evidence, recoverySources, recoveryQuarantineStore } = input;
  const { runtime, world, state, runtimeState, getRecoveryQuarantineStore } = core;
  const { recoveryDb, settlementRefusalRecordingFailures, recordSettlementRefusalFailure } = evidence;
  registerRecoverySources(input);
  const providerOperationAdoptionRefusals = new Map<
    string,
    NonNullable<NonNullable<HealthSnapshot['diagnostics']>['providerOperationAdoptionRefusals']>[number]
  >();
  const durableSettlementRefusalRecorder = createCoordinatorJobSettlementRefusalRecorder({
    getDb: recoveryDb,
    isBoundaryRegistered: (boundary) => recoverySources.has(boundary),
    upsert: (write) => getRecoveryQuarantineStore().upsert(write),
  });
  const settlementRefusalRecorder = {
    async record(input: Parameters<typeof durableSettlementRefusalRecorder.record>[0]): Promise<boolean> {
      try {
        const recorded = await durableSettlementRefusalRecorder.record(input);
        if (recorded) {
          settlementRefusalRecordingFailures.delete(input.jobId);
          return true;
        }
        recordSettlementRefusalFailure(input.jobId, {
          jobId: input.jobId,
          cause: input.cause,
          error: 'The recovery quarantine write did not persist.',
          observedAtMs: runtime.time.now(),
        });
        return false;
      } catch (error: unknown) {
        recordSettlementRefusalFailure(input.jobId, {
          jobId: input.jobId,
          cause: input.cause,
          error: formatError(error),
          observedAtMs: runtime.time.now(),
        });
        throw error;
      }
    },
  };
  const recoveryQuarantineRetry = createRecoveryQuarantineRetryService({
    instanceId: world.identity.instanceId,
    ids: runtime.ids,
    quarantine: recoveryQuarantineStore,
    sources: recoverySources,
  });
  const recoveryQuarantine = createRecoveryQuarantinePorts({
    runtime,
    instanceId: world.identity.instanceId,
    runtimeState,
    recoveryQuarantineRetry,
    recoveryDb,
    releaseUnreadableProviderOperationStartupOwnership: (key) =>
      state.releaseUnreadableProviderOperationStartupOwnership(key),
    providerOperationAdoptionRefusals,
    notifySuccessionObligationChange: () => state.notifySuccessionObligationChange(),
    maxAdoptionRefusals: MAX_LAUNCH_RELEASE_DIAGNOSTICS,
  });

  return { providerOperationAdoptionRefusals, settlementRefusalRecorder, recoveryQuarantine };
}
