import { errorMessage } from '../../../infra/error-format.js';
import type { SettlementRefusalRecorder } from '../../../jobs/contracts/admission.js';
import type { SettledUnboundStatusAbsence } from '../../../jobs/contracts/provider-operation-lifecycle.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import type { UnreadableProviderOperationAttribution } from '../../../store/provider-operation-journal.js';
import type { Database } from '../../../store/db.js';
import { RecoveryContainment } from '../../../recovery/containment.js';
import type {
  RecoveryObligationId,
  RecoveryQuarantinePort,
  RecoveryQuarantineWrite,
  RecoverySource,
} from '../../../recovery/containment.js';
import {
  COORDINATOR_JOB_RECOVERY_BOUNDARY,
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
  type RecoveryRetryPolicy,
} from '../../../recovery/source-registry.js';
import type { ProviderOperationAdoptionRemedy } from '../../../recovery/unreadable-provider-operation.js';
import { unreadableProviderOperationSubject } from '../../../recovery/unreadable-provider-operation.js';
import { formatProviderOperationRemedy } from '../../../recovery/provider-operation-remedy.js';
import type { RawCoordinatorJobRecoveryEnvelope } from './coordinator-job-source.js';
import type { RawUnreadableProviderOperationRecoveryRow } from './unreadable-provider-operation-recovery-source.js';
import type { RawSettledUnboundStatusRecovery } from './settled-unbound-status-recovery-source.js';
import { settledUnboundStatusDetail } from './settled-unbound-status.js';
import type { CoordinatorRecoveryItem } from './snapshot.js';

const REPAIRED_PROVIDER_OPERATION_ADOPTION_OBLIGATION = 'repaired-provider-operation-adoption' as RecoveryObligationId;

export type RepairedProviderOperationAdoption =
  | Readonly<{ kind: 'accepted'; owner: 'provider-operation-reconciler' }>
  | Readonly<{ kind: 'refused'; reason: string; remedy: ProviderOperationAdoptionRemedy }>;

export type UnreadableProviderOperationQuarantineReport = Readonly<{
  materialized: number;
  retained: number;
  failed: readonly Readonly<{ key: string; error: string }>[];
}>;

function providerOperationAdoptionRefusalRetryAdvice(remedy: ProviderOperationAdoptionRemedy): string {
  return formatProviderOperationRemedy(remedy);
}

export async function quarantineUnreadableProviderOperations(
  quarantine: RecoveryQuarantinePort,
  rows: readonly UnreadableProviderOperationAttribution[],
): Promise<UnreadableProviderOperationQuarantineReport> {
  let materialized = 0;
  let retained = 0;
  const failed: { key: string; error: string }[] = [];

  for (const row of rows) {
    const subject = unreadableProviderOperationSubject(row.key, row.revision);
    const write = {
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject,
      state: 'active' as const,
      stage: 'hydrate' as const,
      errorMessage: 'Provider operation row is unreadable by this build.',
      detail: 'Repair or remove the raw provider operation row, then retry this exact quarantine coordinate.',
      remedy: { kind: 'discard-provider-operation' as const, allowReadable: false },
    };
    let persisted = false;
    let writeFailure: unknown = null;
    try {
      persisted = await quarantine.upsert(write);
    } catch (error: unknown) {
      writeFailure = error;
    }
    if (persisted) {
      materialized += 1;
      continue;
    }

    try {
      const current = await quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, row.key);
      if (current !== null) {
        retained += 1;
        continue;
      }
    } catch (error: unknown) {
      failed.push({ key: row.key, error: errorMessage(error) });
      continue;
    }

    const failureDetail = writeFailure === null ? 'the quarantine write did not persist' : errorMessage(writeFailure);
    try {
      persisted = await quarantine.upsert({
        ...write,
        errorMessage: 'Provider operation quarantine materialization failed during startup.',
        detail: `${failureDetail}. The raw row remains unreadable; repair or remove it, then retry this exact coordinate.`,
      });
    } catch (error: unknown) {
      failed.push({ key: row.key, error: `${failureDetail}; durable status retry failed: ${errorMessage(error)}` });
      continue;
    }
    if (persisted) {
      materialized += 1;
    } else {
      failed.push({ key: row.key, error: `${failureDetail}; durable status retry did not persist` });
    }
  }

  return Object.freeze({ materialized, retained, failed: Object.freeze(failed) });
}

export function createUnreadableProviderOperationRetryPolicy(
  adopt: (
    record: ProviderOperationRecord,
    recordKey: string,
  ) => RepairedProviderOperationAdoption | Promise<RepairedProviderOperationAdoption>,
): RecoveryRetryPolicy<RawUnreadableProviderOperationRecoveryRow, RawUnreadableProviderOperationRecoveryRow> {
  return {
    processLocalCleanup: { kind: 'not-required' },
    hydrate: (raw) => raw,
    requiredObligations: (item) => (item.kind === 'readable' ? [REPAIRED_PROVIDER_OPERATION_ADOPTION_OBLIGATION] : []),
    settle: async (item) => {
      if (item.kind === 'unreadable') {
        return {
          kind: 'quarantine',
          detail: `Provider operation row ${item.key} remains unreadable at revision ${item.currentRevision}.`,
        };
      }

      const adoption = await adopt(item.record, item.key);
      if (adoption.kind === 'refused') {
        return {
          kind: 'quarantine',
          detail:
            `Provider operation row ${item.key} is readable, but this coordinator did not accept ownership: ` +
            `${adoption.reason}. ${providerOperationAdoptionRefusalRetryAdvice(adoption.remedy)}`,
          ...(adoption.remedy.kind === 'recovery-quarantine-discard'
            ? {
                remedy: {
                  kind: 'discard-provider-operation' as const,
                  allowReadable:
                    adoption.remedy.command.kind === 'discard-provider-operation'
                      ? adoption.remedy.command.allowReadable
                      : true,
                },
              }
            : {}),
        };
      }
      return {
        kind: 'advanced',
        outcome: 'settled',
        facts: [
          {
            obligation: REPAIRED_PROVIDER_OPERATION_ADOPTION_OBLIGATION,
            outcome: 'done',
            authorityRef: adoption.owner,
          },
        ],
        detail: `Provider operation row ${item.key} was accepted by ${adoption.owner}.`,
      };
    },
    onFault: (fault) => ({
      kind: 'quarantine',
      detail: `Provider operation unreadable-row retry failed during ${fault.stage}.`,
    }),
  };
}

export function createSettledUnboundStatusRetryPolicy(
  quarantine: RecoveryQuarantinePort,
  releaseAbsent: (absence: SettledUnboundStatusAbsence) => boolean,
): RecoveryRetryPolicy<RawSettledUnboundStatusRecovery, RawSettledUnboundStatusRecovery> {
  return {
    processLocalCleanup: {
      kind: 'boundary-required',
      release: async (item) => {
        if (item.kind === 'present') return { kind: 'released' };
        const retained = await quarantine.read(item.subject.boundary, item.subject.key);
        if (retained !== null || releaseAbsent(item.absence)) return { kind: 'released' };
        return {
          kind: 'incomplete',
          error: new Error('The rehydrated settled-unbound ownership could not be released.'),
        };
      },
    },
    hydrate: (raw) => raw,
    requiredObligations: () => [],
    settle: (item) =>
      item.kind === 'absent'
        ? {
            kind: 'advanced',
            outcome: 'settled',
            facts: [],
            detail: 'The exact provider-operation identity is absent from the journal.',
          }
        : {
            kind: 'quarantine',
            detail: settledUnboundStatusDetail(item.recordKeys, null),
          },
    onFault: (fault) => ({
      kind: 'quarantine',
      detail: settledUnboundStatusDetail(null, errorMessage(fault.error)),
    }),
  };
}

const coordinatorJobRetryPolicies = new WeakMap<
  Database,
  (
    signal: AbortSignal,
    quarantine: RecoveryQuarantinePort,
  ) => RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem>
>();

export function createCoordinatorJobSettlementRefusalRecorderImplementation(
  deps: Readonly<{
    getDb(): Database;
    isBoundaryRegistered(boundary: string): boolean;
    upsert(write: RecoveryQuarantineWrite): boolean;
    source(jobId: string): RecoverySource<RawCoordinatorJobRecoveryEnvelope>;
  }>,
): SettlementRefusalRecorder {
  const untrackedQuarantine: RecoveryQuarantinePort = {
    read: () => null,
    upsert: () => false,
    delete: () => false,
  };

  return {
    async record(input): Promise<boolean> {
      if (!deps.isBoundaryRegistered(COORDINATOR_JOB_RECOVERY_BOUNDARY)) {
        throw new Error(`${COORDINATOR_JOB_RECOVERY_BOUNDARY} is not registered.`);
      }

      const report = await RecoveryContainment.each(deps.source(input.jobId), {
        signal: new AbortController().signal,
        quarantine: untrackedQuarantine,
        processLocalCleanup: { kind: 'not-required' },
        hydrate: (raw) => raw,
        requiredObligations: () => [],
        settle: (raw) => {
          const recorded = deps.upsert({
            boundary: COORDINATOR_JOB_RECOVERY_BOUNDARY,
            subject: raw.subject,
            state: 'active',
            stage: 'settle',
            errorMessage: input.failure,
            detail: `Job settlement refused after ${input.cause}.`,
          });
          if (!recorded) throw new Error('The recovery quarantine write did not persist.');
          return {
            kind: 'advanced',
            outcome: 'settled',
            facts: [],
            detail: 'Job settlement refusal was recorded for recovery.',
          };
        },
        onFault: (fault) => ({ kind: 'fatal', error: fault.error }),
      });
      return report.advanced === 1;
    },
  };
}

export function createCoordinatorJobRecoveryRetryPolicy(
  db: Database,
  signal: AbortSignal,
  quarantine: RecoveryQuarantinePort,
): RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem> {
  let resolvedPolicy: RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem> | undefined;
  const policy = (): RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem> => {
    if (resolvedPolicy === undefined) {
      const createPolicy = coordinatorJobRetryPolicies.get(db);
      if (createPolicy === undefined) throw new Error('Coordinator job recovery retry policy is not initialized.');
      resolvedPolicy = createPolicy(signal, quarantine);
    }
    return resolvedPolicy;
  };
  return {
    processLocalCleanup: {
      kind: 'boundary-required',
      release: (item) => {
        const cleanup = policy().processLocalCleanup;
        if (cleanup.kind !== 'boundary-required') {
          throw new Error('Coordinator job retry policy lost its cleanup contract.');
        }
        return cleanup.release(item);
      },
    },
    hydrate: (raw) => policy().hydrate(raw),
    requiredObligations: (item) => policy().requiredObligations(item),
    settle: (item) => policy().settle(item),
    onFault: (fault) => policy().onFault(fault),
  };
}

export function installCoordinatorJobRetryPolicy(
  db: Database,
  createPolicy: (
    signal: AbortSignal,
    quarantine: RecoveryQuarantinePort,
  ) => RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem>,
): void {
  coordinatorJobRetryPolicies.set(db, createPolicy);
}
