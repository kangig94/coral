import { resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import type { Runtime } from '../../runtime/ports.js';
import { seedHistoricalEpoch } from '../../jobs/historical-reader.js';
import type { JobLocationIndex } from '../../jobs/location-index.js';
import { createStartupMintAuthorizer, prepareRetainedControllerHandoff } from '../services/startup-retirement.js';
import { recordControllerOpen, recordControllerServing } from '../succession/controller-open.js';
import { controllerRecoveryTarget } from '../services/retained-epoch-executor.js';
import { readOrCreateEpochKey } from '../../store/epoch/index.js';
import {
  decodeResolvedStoreEpoch,
  encodeResolvedStoreEpoch,
  listStoreEpochs,
  type ResolvedStoreEpoch,
} from '../../store/epoch/index.js';
import { observeSuccessionWriterGeneration } from '../../store/succession-writer-generation.js';
import { currentSuccessionAttemptChild } from '../succession/attempt-child.js';
import {
  PROVIDER_OPERATIONS_OWNER,
  PROVIDER_PROXY_SETS_OWNER,
  type createProviderHostTransfer,
} from '../succession/provider-host-transfer.js';
import {
  decodeDurableCliTransfer,
  recordDurableCliControllerReceipts,
  verifyDurableCliRecoveryGrant,
  verifyUnsettledDurableCliTransfer,
} from '../services/durable-cli-transfer.js';
import { isTerminalPhase } from '../../jobs/phase.js';
import type { JobStore } from '../../jobs/store.js';
import type { CoordinatorIdentity, LifecycleDeps } from '../lifecycle.js';
import type { CoordinatorWorld } from './world.js';

type LifecycleRecoveryInput = {
  runtime: Runtime;
  identity: CoordinatorIdentity;
  jobLocationIndex: JobLocationIndex;
  providerHostTransfer: ReturnType<typeof createProviderHostTransfer>;
  getProgressStore: () => JobStore;
  readSuccessionJobs: () => readonly string[];
  world: Pick<CoordinatorWorld, 'launchCoordinator' | 'childPrincipalRegistry'>;
  onOpenedStore: (openStore: ResolvedStoreEpoch) => void;
};

function createStoreOpenedObserver(input: LifecycleRecoveryInput): NonNullable<LifecycleDeps['onStoreOpened']> {
  const { runtime, identity, jobLocationIndex, onOpenedStore } = input;
  return (openStore) => {
    if (openStore.path !== ':memory:') {
      const runningBuild = resolveStrictBundleIdentity();
      if (runningBuild.ok && runningBuild.manifest.buildSetId === identity.buildSetId) {
        const writerGeneration = observeSuccessionWriterGeneration(runtime);
        const generation =
          writerGeneration !== null &&
          writerGeneration.epoch === openStore.epoch &&
          writerGeneration.storeRoot === (openStore.canonicalStoreRoot ?? openStore.storeRoot)
            ? writerGeneration.generation
            : 0;
        recordControllerOpen(
          runtime,
          encodeResolvedStoreEpoch(runtime, openStore),
          identity.instanceId,
          currentSuccessionAttemptChild()?.attemptId ?? null,
          identity.pluginRoot,
          runningBuild.manifest,
          generation,
        );
      }
    }
    onOpenedStore(openStore);
    if (openStore.path !== ':memory:') {
      for (const historical of listStoreEpochs(runtime)) {
        if (
          historical.role !== 'protected' ||
          historical.resolved === null ||
          historical.epochKey === null ||
          historical.epochKey === undefined
        )
          continue;
        const historicalKey = encodeResolvedStoreEpoch(runtime, historical.resolved);
        const fingerprint =
          historical.epochJson.kind === 'valid' ? historical.epochJson.value.build.storeFormatFingerprint : '';
        void seedHistoricalEpoch(
          runtime,
          jobLocationIndex,
          historical.resolved,
          historicalKey,
          fingerprint,
          runtime.paths.coral.exports.jobsRoot,
          runtime.storage,
        );
      }
    }
  };
}

function createSuccessionReceiptVerifier(
  input: LifecycleRecoveryInput,
): NonNullable<LifecycleDeps['verifySuccessionReceipts']> {
  const { runtime, providerHostTransfer, getProgressStore, readSuccessionJobs, jobLocationIndex } = input;
  return (preparation, epoch, committedSuccessorInstanceId) => {
    const accepted = new Set<string>();
    for (const receipt of preparation.receipts) {
      if (receipt.owner === 'durable-cli') {
        const verified = verifyUnsettledDurableCliTransfer(
          runtime,
          receipt.payload,
          getProgressStore().getDb(),
          getProgressStore(),
          runtime.paths.coral.coordinator.runDir,
          epoch,
          (jobId) => {
            if (committedSuccessorInstanceId === null) return false;
            const status = getProgressStore().readStatus(jobId);
            return status === null || isTerminalPhase(status.phase);
          },
        );
        if (verified === null) throw new Error('Durable-cli receipt no longer matches runtime and custody.');
        if (
          (committedSuccessorInstanceId === null || verified.liveJobIds.length > 0) &&
          !verifyDurableCliRecoveryGrant(
            runtime,
            runtime.paths.coral.coordinator.runDir,
            receipt.attemptId,
            receipt.recoveryGrantId,
            preparation.epochKey,
            preparation.incumbentInstanceId,
            verified.transfer,
          )
        )
          throw new Error('Durable-cli recovery grant is unavailable or changed.');
        for (const jobId of verified.liveJobIds) accepted.add(jobId);
      } else if (receipt.owner !== PROVIDER_PROXY_SETS_OWNER && receipt.owner !== PROVIDER_OPERATIONS_OWNER) {
        throw new Error(`Unsupported succession receipt owner: ${receipt.owner}`);
      }
    }
    for (const jobId of providerHostTransfer.verifyReceipts(preparation, committedSuccessorInstanceId !== null))
      accepted.add(jobId);
    const live = readSuccessionJobs();
    const admittedByCommittedSuccessor = (jobId: string): boolean =>
      committedSuccessorInstanceId !== null &&
      jobLocationIndex.read(jobId)?.controller?.instanceId === committedSuccessorInstanceId;
    if (
      live.some((jobId) => !accepted.has(jobId) && !admittedByCommittedSuccessor(jobId)) ||
      (committedSuccessorInstanceId === null && live.length !== accepted.size)
    ) {
      throw new Error('Accepted receipts do not cover every live job.');
    }
    return [...accepted];
  };
}

function createSuccessionReceiptAdopter(
  input: LifecycleRecoveryInput,
): NonNullable<LifecycleDeps['adoptSuccessionReceipts']> {
  const { providerHostTransfer, getProgressStore, world } = input;
  return (preparation, acceptedJobIds) => {
    const accepted = new Set(acceptedJobIds);
    providerHostTransfer.adoptReceipts(preparation);
    const hostTransferredJobIds = new Set(providerHostTransfer.transferredJobIds(preparation));
    for (const jobId of accepted) {
      if (hostTransferredJobIds.has(jobId)) continue;
      const status = getProgressStore().readStatus(jobId);
      if (status !== null && isTerminalPhase(status.phase)) continue;
      const permit = world.launchCoordinator.activeLaunchPermits().find((entry) => entry.jobId === jobId);
      if (permit?.holder.kind !== 'recovery') {
        throw new Error(`Durable-cli job ${jobId} was not adopted with a launch permit.`);
      }
    }
  };
}

function createSuccessionControllerReceiptRecorder(
  input: LifecycleRecoveryInput,
): NonNullable<LifecycleDeps['recordSuccessionControllerReceipts']> {
  const { runtime, providerHostTransfer, identity } = input;
  return (preparation, epochKey, generation, recordedAt) => {
    const epoch = decodeResolvedStoreEpoch(runtime, epochKey);
    if (epoch === undefined) throw new Error('Committed epoch is invalid.');
    if (providerHostTransfer.transfersHosts(preparation)) void providerHostTransfer.completeTransfers();
    for (const receipt of preparation.receipts) {
      if (receipt.owner !== 'durable-cli') continue;
      const transfer = decodeDurableCliTransfer(receipt.payload, epoch);
      if (transfer === null) throw new Error('Durable-cli receipt is invalid at controller acknowledgment.');
      recordDurableCliControllerReceipts(runtime, runtime.paths.coral.coordinator.runDir, transfer, {
        epochKey,
        lineageEpochKey: readOrCreateEpochKey(runtime, epoch),
        attemptId: preparation.attemptId,
        instanceId: identity.instanceId,
        buildSetId: identity.buildSetId,
        generation,
        nowMs: Date.parse(recordedAt),
      });
    }
  };
}

export function createLifecycleRecoveryDependencies(
  input: LifecycleRecoveryInput,
): Pick<
  LifecycleDeps,
  | 'onStoreOpened'
  | 'onStoreServing'
  | 'authorizeStartupMint'
  | 'prepareNoIncumbentHandoff'
  | 'prepareRecoveryGrantHandoff'
  | 'onRetiredEpochOpened'
  | 'verifySuccessionReceipts'
  | 'transferredHostJobIds'
  | 'adoptSuccessionReceipts'
  | 'recordSuccessionControllerReceipts'
> {
  const { runtime, identity, jobLocationIndex, providerHostTransfer } = input;
  return {
    onStoreOpened: createStoreOpenedObserver(input),
    onStoreServing: (attemptId, epochKey, instanceId, controlGeneration) =>
      recordControllerServing(runtime, attemptId, epochKey, instanceId, controlGeneration),
    authorizeStartupMint: createStartupMintAuthorizer(runtime, jobLocationIndex, identity.instanceId),
    prepareNoIncumbentHandoff: () => prepareRetainedControllerHandoff(runtime, jobLocationIndex),
    prepareRecoveryGrantHandoff: (epochKey, incumbentInstanceId) =>
      controllerRecoveryTarget(runtime, epochKey, incumbentInstanceId),
    onRetiredEpochOpened: (epoch, disposition) => {
      const seeded = seedHistoricalEpoch(
        runtime,
        jobLocationIndex,
        epoch,
        disposition.incumbentEpochKey,
        disposition.incumbentFingerprint,
        runtime.paths.coral.exports.jobsRoot,
        runtime.storage,
        [],
        true,
      );
      if (seeded.kind !== 'complete') throw new Error(`Retired epoch history is ${seeded.kind}.`);
    },
    verifySuccessionReceipts: createSuccessionReceiptVerifier(input),
    transferredHostJobIds: (preparation) => providerHostTransfer.transferredJobIds(preparation),
    adoptSuccessionReceipts: createSuccessionReceiptAdopter(input),
    recordSuccessionControllerReceipts: createSuccessionControllerReceiptRecorder(input),
  };
}
