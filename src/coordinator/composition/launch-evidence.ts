import { formatError } from '../../infra/error-format.js';
import { isTerminalPhase } from '../../jobs/phase.js';
import type { LaunchReclamationProbeResult } from '../../jobs/contracts/admission.js';
import {
  observeProviderOperationRecord,
  providerOperationRecordKeyPrefix,
  readProviderOperations,
} from '../../store/provider-operation-journal.js';
import type { HealthSnapshot } from '../../transport/server-ports.js';
import { createSettledUnboundStatusPort } from '../services/recovery/settled-unbound-status.js';
import { LAUNCH_RECLAMATION_SWEEP_INTERVAL_MS } from '../live/admission.js';
import type { createCoordinatorCoreContext } from './core-context.js';

type CoreContext = ReturnType<typeof createCoordinatorCoreContext>;

type SettlementFailure = NonNullable<
  NonNullable<HealthSnapshot['diagnostics']>['settlementRefusalRecordingFailures']
>[number];
type RecoveryDb = ReturnType<ReturnType<CoreContext['getProgressStore']>['getDb']>;

function connectSettledUnboundStatus(
  core: CoreContext,
  recoveryDb: () => RecoveryDb,
  settlementRefusalRecordingFailures: Map<string, SettlementFailure>,
  recordSettlementRefusalFailure: (key: string, failure: SettlementFailure) => void,
): void {
  const { runtime, world } = core;
  const settledUnboundStatus = createSettledUnboundStatusPort(recoveryDb, runtime.time);
  world.launchCoordinator.connectSettledUnboundStatus({
    rebind: (subject) => settledUnboundStatus.rebind(subject),
    record(identity) {
      const result = settledUnboundStatus.record(identity);
      const diagnosticKey = JSON.stringify(['settled-unbound', identity.jobId, identity.operationId]);
      if (result.kind === 'refused') {
        recordSettlementRefusalFailure(diagnosticKey, {
          jobId: identity.jobId,
          operationId: identity.operationId,
          cause: 'settled-unbound-status-persist-failed',
          error: result.reason,
          observedAtMs: runtime.time.now(),
        });
      } else {
        settlementRefusalRecordingFailures.delete(diagnosticKey);
      }
      return result;
    },
    clear(identity, ownership) {
      const cleared = settledUnboundStatus.clear(identity, ownership);
      if (cleared) {
        settlementRefusalRecordingFailures.delete(
          JSON.stringify(['settled-unbound', identity.jobId, identity.operationId]),
        );
      }
      return cleared;
    },
    clearAbsent(identity) {
      const cleared = settledUnboundStatus.clearAbsent(identity);
      if (cleared) {
        settlementRefusalRecordingFailures.delete(
          JSON.stringify(['settled-unbound', identity.jobId, identity.operationId]),
        );
      }
      return cleared;
    },
    clearRefusal(identity) {
      settlementRefusalRecordingFailures.delete(
        JSON.stringify(['settled-unbound', identity.jobId, identity.operationId]),
      );
    },
  });
}

export function connectLaunchEvidence(core: CoreContext, maxDiagnostics: number) {
  const { runtime, world, getProgressStore } = core;
  const recoveryDb = () => getProgressStore().getDb();
  const settlementRefusalRecordingFailures = new Map<
    string,
    NonNullable<NonNullable<HealthSnapshot['diagnostics']>['settlementRefusalRecordingFailures']>[number]
  >();
  const recordSettlementRefusalFailure = (
    key: string,
    failure: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['settlementRefusalRecordingFailures']>[number],
  ): void => {
    settlementRefusalRecordingFailures.delete(key);
    settlementRefusalRecordingFailures.set(key, failure);
    if (settlementRefusalRecordingFailures.size <= maxDiagnostics) return;
    const oldest = settlementRefusalRecordingFailures.keys().next().value;
    if (oldest !== undefined) settlementRefusalRecordingFailures.delete(oldest);
  };
  connectSettledUnboundStatus(core, recoveryDb, settlementRefusalRecordingFailures, recordSettlementRefusalFailure);
  world.launchCoordinator.connectProviderOperationBindingJournal((identity) => {
    try {
      const scan = readProviderOperations(recoveryDb());
      if (
        scan.records.some(
          (record) =>
            record.operation.jobId === identity.jobId && record.operation.operationId === identity.operationId,
        )
      ) {
        return { kind: 'present' };
      }
      const keyPrefix = `${providerOperationRecordKeyPrefix(identity.jobId)}${identity.operationId}:`;
      return scan.unreadableKeys.some((key) => key.startsWith(keyPrefix)) ? { kind: 'present' } : { kind: 'absent' };
    } catch (error: unknown) {
      return { kind: 'unknown', reason: formatError(error) };
    }
  });
  const readJobReclamation = (jobId: string): LaunchReclamationProbeResult<'local-execution'> => {
    const status = getProgressStore().readStatus(jobId);
    if (status === null) return { kind: 'job-absent' };
    return isTerminalPhase(status.phase) ? { kind: 'job-terminal', phase: status.phase } : { kind: 'job-live' };
  };
  world.launchCoordinator.connectLaunchReclamationOracle('local-execution', (permit) =>
    readJobReclamation(permit.jobId),
  );
  world.launchCoordinator.connectLaunchReclamationOracle('recovery', (permit) => readJobReclamation(permit.jobId));
  world.launchCoordinator.connectLaunchReclamationOracle('proxy-operation', (permit) => {
    const evidence = readJobReclamation(permit.jobId);
    if (evidence.kind === 'job-live') return evidence;
    const scan = readProviderOperations(recoveryDb());
    if (
      scan.records.some(
        (record) =>
          record.operation.jobId === permit.jobId && record.operation.operationId === permit.holder.operationId,
      )
    ) {
      return { kind: 'job-live' };
    }
    const keyPrefix = `${providerOperationRecordKeyPrefix(permit.jobId)}${permit.holder.operationId}:`;
    return scan.unreadableKeys.some((key) => key.startsWith(keyPrefix))
      ? { kind: 'job-live' }
      : {
          kind: 'provider-operation-absent',
          operationId: permit.holder.operationId,
          jobEvidence: evidence,
        };
  });
  world.launchCoordinator.connectLaunchReclamationOracle('undecided-provider-operation', (permit) => {
    const evidence = readJobReclamation(permit.jobId);
    if (evidence.kind === 'job-live') return evidence;
    return permit.holder.recordKeys.some((key) => observeProviderOperationRecord(recoveryDb(), key).kind !== 'absent')
      ? { kind: 'job-live' }
      : {
          kind: 'provider-operation-records-absent',
          recordKeys: permit.holder.recordKeys,
          jobEvidence: evidence,
        };
  });
  const launchReclamationTimer = runtime.time.setInterval(() => {
    try {
      world.launchCoordinator.sweepStaleLaunchPermits();
    } catch {
      // A maintenance timer must not terminate a coordinator that booted successfully.
    }
  }, LAUNCH_RECLAMATION_SWEEP_INTERVAL_MS);
  launchReclamationTimer.unref?.();
  return { recoveryDb, settlementRefusalRecordingFailures, recordSettlementRefusalFailure, launchReclamationTimer };
}
