import type { JsonValue } from '../../../infra/json-value.js';
import { inspectCurrentStore, encodeResolvedStoreEpoch } from '../../../store/epoch.js';
import {
  dischargeDurableCliRecoveryGrants,
  prepareDurableCliTransfer,
  prepareDurableCliRecoveryGrant,
} from '../../services/durable-cli-transfer.js';
import type { SuccessionOwner } from '../../succession/obligations.js';
import type { SuccessionOwnersInput } from './index.js';

export function createLaunchSuccessionOwners(input: SuccessionOwnersInput): SuccessionOwner[] {
  const { runtime, world, getProgressStore, readSuccessionJobs } = input;
  const identity = world.identity;
  return [
    {
      id: 'launch-admission',
      classify: async () => {
        const pending = world.launchCoordinator.pendingLaunchJobIds();
        const acquiring = world.launchCoordinator
          .activeLaunchPermits()
          .filter(
            (permit) =>
              permit.holder.kind === 'local-execution' &&
              getProgressStore().readRuntimeProjection(permit.jobId) === null,
          )
          .map((permit) => permit.jobId);
        const jobIds = [...new Set([...pending, ...acquiring])];
        const unidentified =
          world.launchCoordinator.pendingDurableLaunchCount() > world.launchCoordinator.pendingDurableJobIds().length;
        return jobIds.length === 0 && !unidentified
          ? { kind: 'completed', reason: 'no queued or carrier-acquiring launches' }
          : { kind: 'blocking', reason: 'launch admission still owns queued or carrier-acquiring work', jobIds };
      },
    },
    {
      id: 'durable-cli',
      recordsGrants: true,
      dischargeGrants: (retained) =>
        dischargeDurableCliRecoveryGrants(runtime, runtime.paths.coral.coordinator.runDir, retained),
      classify: async (attemptId) => {
        const jobIds = readSuccessionJobs().filter(
          (jobId) => getProgressStore().readRuntimeProjection(jobId)?.transport === 'durable-cli',
        );
        if (jobIds.length === 0) return { kind: 'completed', reason: 'no live durable-cli carrier' };
        const inspected = inspectCurrentStore(runtime);
        if (inspected.kind !== 'current') {
          return { kind: 'blocking', reason: 'exact durable-cli epoch is unavailable', jobIds };
        }
        const transfer = prepareDurableCliTransfer(
          runtime,
          getProgressStore().getDb(),
          getProgressStore(),
          runtime.paths.coral.coordinator.runDir,
          inspected.epoch,
          jobIds,
        );
        if (transfer === null) {
          return { kind: 'blocking', reason: 'durable-cli runtime or custody evidence is incomplete', jobIds };
        }
        const recoveryGrantId = prepareDurableCliRecoveryGrant(runtime, runtime.paths.coral.coordinator.runDir, {
          version: 'v1',
          attemptId,
          epochKey: encodeResolvedStoreEpoch(runtime, inspected.epoch),
          incumbentInstanceId: identity.instanceId,
          incumbentBuildSetId: identity.buildSetId,
          transfer,
        });
        return {
          kind: 'transferable',
          reason: 'durable-cli runtime and custody evidence is recorded',
          jobIds,
          receipt: {
            owner: 'durable-cli',
            generation: 1,
            attemptId,
            receiptId: `durable-cli:${attemptId}`,
            recoveryGrantId,
            payload: JSON.parse(JSON.stringify(transfer)) as JsonValue,
          },
        };
      },
    },
  ];
}
