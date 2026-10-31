import { readSuccessionJobIdsByKind } from '../../../jobs/succession-coverage.js';
import { listProjectionConversationEntries } from '../../../jobs/conversation/read-queries.js';
import { knownDiscussSources } from '../../../discuss/shell/session-read-service.js';
import type { SuccessionOwner } from '../../succession/obligations.js';
import type { SuccessionOwnersInput } from './index.js';

export function createLocalAuthoritySuccessionOwners(input: SuccessionOwnersInput): SuccessionOwner[] {
  const {
    getProgressStore,
    getRecoveryQuarantineStore,
    lifecycleController,
    kbDaemonSupervisor,
    discuss,
    liveProviderHosts,
    isTerminalDiscussStatus,
  } = input;
  return [
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
        const superseded = await lifecycleController()?.settleSupersededProviderOperations();
        if (superseded?.kind === 'holding') {
          return {
            kind: 'blocking',
            reason: 'a superseded provider operation still fences its job',
            jobIds: superseded.pendingJobIds,
          };
        }
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
          (daemon.phase === 'failed' && daemon.childPresence === 'absent' && daemon.pendingRequests === 0) ||
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
      id: 'conversation-retention',
      classify: async () => {
        const sessions = listProjectionConversationEntries(getProgressStore().getDb());
        const held = sessions.filter((session) =>
          session.retentionDiscard.attempts.some((attempt) => attempt.status === 'requested'),
        );
        return held.length === 0
          ? { kind: 'completed', reason: 'no conversation retention hold' }
          : { kind: 'blocking', reason: 'conversation retention work needs an accepted receipt' };
      },
    },
  ];
}
