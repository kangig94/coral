import type { Runtime } from '../../runtime/ports.js';
import type { JobStore } from '../../jobs/store.js';
import type { JsonValue } from '../../infra/json-value.js';
import { inspectCurrentStore, encodeResolvedStoreEpoch } from '../../store/epoch.js';
import {
  dischargeDurableCliRecoveryGrants,
  prepareDurableCliTransfer,
  prepareDurableCliRecoveryGrant,
} from '../services/durable-cli-transfer.js';
import { readSuccessionJobIdsByKind, readJobLaunchOriginNamespace } from '../../jobs/succession-coverage.js';
import { createDefaultStoreReadContext } from '../../read-model/read-context.js';
import { listProjectionSessionEntries } from '../../sessions/projections.js';
import { knownDiscussSources } from '../../discuss/shell/session-read-service.js';
import { type createDiscussRuntime } from '../../discuss/shell/runtime-services.js';
import { type RecoveryQuarantineStore } from '../../recovery/quarantine.js';
import type { LifecycleController } from '../lifecycle.js';
import type { KbDaemonSupervisor } from '../live/kb-daemon-supervisor.js';
import type { ProviderHostAdministrationAuthority } from '../live/provider-hosts/index.js';
import type { SuccessionOwner } from '../succession/obligations.js';
import { type createProviderHostTransfer } from '../succession/provider-host-transfer.js';
import { type createCoordinatorWorld } from './world.js';

export function createSuccessionOwners({
  runtime,
  world,
  getProgressStore,
  getRecoveryQuarantineStore,
  lifecycleController,
  kbDaemonSupervisor,
  discuss,
  providerHostTransfer,
  liveProviderHosts,
  readSuccessionJobs,
  isTerminalDiscussStatus,
}: {
  runtime: Runtime;
  world: ReturnType<typeof createCoordinatorWorld>;
  getProgressStore: () => JobStore;
  getRecoveryQuarantineStore: () => RecoveryQuarantineStore;
  lifecycleController: () => LifecycleController | null;
  kbDaemonSupervisor: KbDaemonSupervisor;
  discuss: ReturnType<typeof createDiscussRuntime>;
  providerHostTransfer: ReturnType<typeof createProviderHostTransfer>;
  liveProviderHosts: () => ReturnType<ProviderHostAdministrationAuthority['listProviderHosts']>;
  readSuccessionJobs: () => readonly string[];
  isTerminalDiscussStatus: (status: string) => boolean;
}): readonly SuccessionOwner[] {
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
    ...providerHostTransfer.owners,
    {
      id: 'provider-hosts',
      classify: async () => {
        const hosts = liveProviderHosts();
        const jobIds = hosts
          .map((host) => host.host.ownerJobId)
          .filter((jobId): jobId is string => typeof jobId === 'string');
        return hosts.length === 0
          ? { kind: 'completed', reason: 'no live local provider host' }
          : { kind: 'blocking', reason: 'local provider host cannot survive coordinator exit', jobIds };
      },
    },
    {
      id: 'recovery',
      classify: async () => {
        const quarantines = getRecoveryQuarantineStore().list();
        const registry = lifecycleController()?.getRecoveryRegistry();
        const jobIds = [...(registry ?? [])]
          .map(([jobId]) => jobId)
          .filter((jobId) => getProgressStore().readRuntimeProjection(jobId) === null);
        return quarantines.length === 0 && jobIds.length === 0
          ? { kind: 'completed', reason: 'no recovery hold' }
          : { kind: 'blocking', reason: 'recovery registry or quarantine retains authority', jobIds };
      },
    },
    {
      id: 'workflow',
      classify: async () => {
        const jobIds = readSuccessionJobIdsByKind(getProgressStore().getDb(), 'workflow');
        return jobIds.length === 0
          ? { kind: 'completed', reason: 'no live workflow execution' }
          : { kind: 'blocking', reason: 'workflow execution is coordinator-local', jobIds };
      },
    },
    {
      id: 'kb-daemon',
      classify: async () => {
        const daemon = kbDaemonSupervisor.read();
        const active =
          daemon.phase === 'online'
            ? await kbDaemonSupervisor.listActiveKbJobsForSuccession?.()
            : { active: [] as string[] };
        if (active === undefined) throw new Error('KB daemon work inventory is unavailable');
        const jobIds = [
          ...new Set([...readSuccessionJobIdsByKind(getProgressStore().getDb(), 'kb'), ...active.active]),
        ];
        const daemonIdle =
          daemon.phase === 'disabled' ||
          daemon.phase === 'stopped' ||
          (daemon.phase === 'online' && daemon.pendingRequests === 0);
        return jobIds.length === 0 && daemonIdle
          ? { kind: 'completed', reason: 'no KB daemon work' }
          : { kind: 'blocking', reason: 'KB daemon work has not been transferred', jobIds };
      },
    },
    {
      id: 'discuss',
      classify: async () => {
        const liveSnapshots = [...knownDiscussSources(discuss.readHelpersDeps)]
          .flatMap((source) => discuss.getDiscussStoreForSource(source).listSummaries())
          .filter((summary) => !isTerminalDiscussStatus(summary.status));
        return discuss.hooks.onIdleCheck() || liveSnapshots.length > 0
          ? { kind: 'blocking', reason: 'live discuss session retains coordinator-local state' }
          : { kind: 'completed', reason: 'no live discuss session' };
      },
    },
    {
      id: 'session-continuation',
      classify: async () => {
        const sessions = listProjectionSessionEntries(getProgressStore().getDb());
        const held = sessions.filter(
          (session) =>
            session.continuationLease?.status === 'pending' ||
            session.continuationLease?.status === 'claimed' ||
            session.retentionDiscard.attempts.some((attempt) => attempt.status !== 'completed'),
        );
        return held.length === 0
          ? { kind: 'completed', reason: 'no continuation lease or retention hold' }
          : { kind: 'blocking', reason: 'session continuation or retention work needs an accepted receipt' };
      },
    },
    {
      id: 'child-principals',
      recordsGrants: true,
      dischargeGrants: (retained) => world.childPrincipalRegistry.dischargeGrants(retained),
      classify: async (attemptId) => {
        const snapshot = world.childPrincipalRegistry.transferSnapshot(runtime.time.now());
        if (snapshot.entries.length === 0) return { kind: 'completed', reason: 'no live child handle' };
        const transfer = world.childPrincipalRegistry.prepareTransfer(attemptId, runtime.time.now());
        if (transfer?.recoveryGrantId === undefined) {
          return { kind: 'blocking', reason: 'child nonce recovery grant could not be recorded' };
        }
        const liveJobs = new Set(readSuccessionJobs());
        if (transfer.entries.some((entry) => !liveJobs.has(entry.parentJobId))) {
          return { kind: 'blocking', reason: 'child handle has no accepted live parent job' };
        }
        if (
          transfer.entries.some(
            (entry) =>
              readJobLaunchOriginNamespace(
                getProgressStore().getDb(),
                entry.parentJobId,
                createDefaultStoreReadContext(),
              ) !== entry.authorization.namespace,
          )
        )
          return { kind: 'blocking', reason: 'child origin launch evidence is missing or conflicting' };
        return {
          kind: 'transferable',
          reason: 'handles and consumed nonces are recorded for fenced adoption',
          receipt: {
            owner: 'child-principals',
            generation: 1,
            attemptId,
            receiptId: `child-principals:${attemptId}`,
            recoveryGrantId: transfer.recoveryGrantId,
            payload: JSON.parse(JSON.stringify(transfer)) as JsonValue,
          },
        };
      },
    },
  ];
}
