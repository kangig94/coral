import { assertNever, formatError } from '../../../infra/error-format.js';
import { backendLog } from '../../../infra/backend-log.js';
import type { ProcessLiveness } from '../../../infra/node-process.js';
import { isTerminalPhase, type JobPhase } from '../../../jobs/phase.js';
import { readProviderOperationJobLaunch } from '../../../jobs/provider-operation-state.js';
import type {
  JobAdmissionPort,
  JobLaunchRecoveryPort,
  LaunchPermit,
  LaunchRelease,
} from '../../../jobs/contracts/admission.js';
import type {
  ProviderOperationBindingPort,
  SettledUnboundStatusHydrationPort,
  SettledUnboundStatusSubject,
} from '../../../jobs/contracts/provider-operation-lifecycle.js';
import type { JobStore } from '../../../jobs/store.js';
import type {
  ProviderOperationSettlementDisposition,
  ProviderOperationStartupOwnership,
  ProviderOperationStartupRecordOwnership,
} from '../../../jobs/startup.js';
import { sha256Hex } from '../../../infra/hash.js';
import { unreadableProviderOperationSubject } from '../../../recovery/unreadable-provider-operation.js';
import { type ProviderOperationRemedy } from '../../../recovery/provider-operation-remedy.js';
import { RecoveryQuarantineStore } from '../../../recovery/quarantine.js';
import {
  SETTLED_UNBOUND_STATUS_BOUNDARY,
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
} from '../../../recovery/source-registry.js';
import {
  attributeUnreadableProviderOperations,
  compareAndSwapProviderOperation,
  providerOperationRecordKeyPrefix,
  readProviderOperation,
  readProviderOperations,
  readSupersededProviderOperations,
  retireSupersededProviderOperation,
  type UnreadableProviderOperationAttribution,
} from '../../../store/provider-operation-journal.js';
import {
  encodeProviderOperationRecord,
  providerOperationRecordSchema,
  type ProviderOperationRecord,
} from '../../../store/provider-operation-record.js';
import type { Runtime } from '../../../runtime/ports.js';

type StartupPermitOwnership =
  | Readonly<{ kind: 'operation'; permit: LaunchPermit; operationId: string }>
  | Readonly<{
      kind: 'undecided-provider-operation';
      permit: LaunchPermit;
      recordKeys: readonly string[];
    }>;

export type ProviderOperationStartupRelease = LaunchRelease | Readonly<{ kind: 'not-owned' }>;

export type ProviderOperationStartupSnapshot = Readonly<{
  records: readonly ProviderOperationRecord[];
  unreadable: readonly UnreadableProviderOperationAttribution[];
}>;

export type UnreadableProviderOperationStartupResolution = Readonly<{
  released: number;
  readableRecords: readonly Readonly<{ recordKey: string; record: ProviderOperationRecord }>[];
}>;

export type SupersededProviderOperationRetirementSummary = Readonly<{
  retired: number;
  retained: number;
}>;

type StartupHoldDisposition =
  | Readonly<{ kind: 'fenced'; record: ProviderOperationRecord }>
  | Readonly<{ kind: 'record-absent' }>
  | Readonly<{
      kind: 'settlement-pending';
      record: Extract<ProviderOperationRecord, { phase: 'settlement-pending' }>;
    }>;

type StartupPreparationRecord = Exclude<
  ProviderOperationRecord,
  { phase: 'settlement-pending' | 'local-recovery-pending' | 'prestart-cleanup-pending' }
>;

type StartupOwnershipBinding = Pick<
  JobLaunchRecoveryPort,
  'restoreActiveLaunch' | 'holdUndecidedProviderOperationLaunch' | 'reclaimLaunchPermit'
> &
  Pick<JobAdmissionPort, 'releaseLaunch'> &
  ProviderOperationBindingPort &
  SettledUnboundStatusHydrationPort;

export interface ProviderOperationStartupOwnershipService {
  retireAbsentSupersededProviderOperations(): SupersededProviderOperationRetirementSummary;
  snapshot(): ProviderOperationStartupSnapshot;
  hydrate(snapshot: ProviderOperationStartupSnapshot): ProviderOperationStartupOwnership;
  adoptRepaired(record: ProviderOperationRecord, recordKey?: string): ProviderOperationStartupRecordOwnership;
  release(operation: ProviderOperationRecord['operation']): ProviderOperationStartupRelease;
  releaseUnreadable(recordKey: string): UnreadableProviderOperationStartupResolution;
  reclaimTerminalUndecided(input: Readonly<{ jobId: string; phase: JobPhase; previousPhase: JobPhase }>): void;
  completeRecovery(jobId: string): void;
  holdRecoveryFailure(record: ProviderOperationRecord, reason: string): ProviderOperationStartupRecordOwnership;
  releaseAll(): void;
}

function phaseRestoresPermit(phase: ProviderOperationRecord['phase']): boolean {
  return (
    phase === 'prepare-pending' ||
    phase === 'guardian-activation-pending' ||
    phase === 'proxy-activation-pending' ||
    phase === 'activation-resolution-pending' ||
    phase === 'executing' ||
    phase === 'prestart-cleanup-pending'
  );
}

export function providerOperationStartupIdentityKey(operation: ProviderOperationRecord['operation']): string {
  return (
    `${operation.jobId}\u0000${operation.operationId}\u0000` +
    `${operation.proxyInstanceId}\u0000${operation.buildSetId}`
  );
}

function recordKey(operation: ProviderOperationRecord['operation']): string {
  return (
    `${providerOperationRecordKeyPrefix(operation.jobId)}${operation.operationId}:` +
    `${operation.proxyInstanceId}:${operation.buildSetId}`
  );
}

function recordFingerprint(record: ProviderOperationRecord): string {
  return `sha256:${sha256Hex(encodeProviderOperationRecord(record))}`;
}

function observeSupersededProviderOperationTargets(
  processTargets: readonly number[],
  observeLiveness: Runtime['process']['observeLiveness'],
): ProcessLiveness {
  for (const target of processTargets) {
    const observation = observeLiveness(target);
    if (observation !== 'absent') return observation;
  }
  return 'absent';
}

export function createProviderOperationStartupOwnership(
  deps: Readonly<{
    progressStore: Pick<JobStore, 'getDb' | 'readStatus' | 'readLaunchProjection'>;
    runtime: Runtime;
    log(message: string): void;
    binding: StartupOwnershipBinding;
  }>,
): ProviderOperationStartupOwnershipService {
  const { progressStore, runtime, log, binding } = deps;
  const permits = new Map<string, StartupPermitOwnership>();
  const quarantine = new RecoveryQuarantineStore(progressStore.getDb(), runtime.time);

  for (const entry of quarantine.list().filter(({ boundary }) => boundary === SETTLED_UNBOUND_STATUS_BOUNDARY)) {
    if (entry.subject.revision.kind !== 'fingerprint') {
      log(`Settled-unbound startup ownership has no fingerprint revision: ${entry.subject.key}.\n`);
      continue;
    }
    const subject: SettledUnboundStatusSubject = {
      boundary: SETTLED_UNBOUND_STATUS_BOUNDARY,
      key: entry.subject.key,
      revision: entry.subject.revision.value,
      state: 'active',
    };
    const hydration = binding.hydrateSettledUnboundStatus(subject);
    if (hydration.kind === 'refused') {
      log(`Settled-unbound startup ownership was refused for ${entry.subject.key}: ${hydration.reason}.\n`);
    }
  }

  const restorePermit = (
    jobId: string,
    ownership:
      | Readonly<{ kind: 'operation'; operationId: string }>
      | Readonly<{ kind: 'undecided-provider-operation'; recordKeys: readonly string[] }>,
  ): LaunchPermit | null => {
    const existing = permits.get(jobId);
    if (existing !== undefined) {
      if (
        existing.kind === 'operation' &&
        ownership.kind === 'operation' &&
        existing.operationId !== ownership.operationId
      ) {
        log(`Provider operation startup ownership conflict for ${jobId}: more than one operation claims its permit.\n`);
        return null;
      }
      if (existing.kind === 'undecided-provider-operation' && ownership.kind === 'operation') {
        permits.set(jobId, {
          kind: 'operation',
          permit: existing.permit,
          operationId: ownership.operationId,
        });
      } else if (ownership.kind === 'undecided-provider-operation') {
        const existingRecordKeys =
          existing.permit.holder.kind === 'undecided-provider-operation' ? existing.permit.holder.recordKeys : [];
        const recordKeys = [...new Set([...existingRecordKeys, ...ownership.recordKeys])];
        const permit = binding.holdUndecidedProviderOperationLaunch(existing.permit, recordKeys);
        if (permit === null) return null;
        permits.set(jobId, {
          kind: 'undecided-provider-operation',
          permit,
          recordKeys,
        });
        return permit;
      }
      return existing.permit;
    }

    const status = progressStore.readStatus(jobId);
    if (status === null) return null;
    try {
      const launch = readProviderOperationJobLaunch(progressStore, jobId);
      const permit = binding.restoreActiveLaunch(
        jobId,
        launch.provider,
        launch.owner,
        launch.pool,
        ownership.kind === 'operation'
          ? { kind: 'recovery' }
          : { kind: 'undecided-provider-operation', recordKeys: ownership.recordKeys },
      );
      permits.set(
        jobId,
        ownership.kind === 'operation'
          ? { kind: 'operation', permit, operationId: ownership.operationId }
          : { kind: 'undecided-provider-operation', permit, recordKeys: ownership.recordKeys },
      );
      return permit;
    } catch (error: unknown) {
      log(`Provider operation startup permit restoration failed for ${jobId}: ${formatError(error)}\n`);
      return null;
    }
  };

  const settleBinding = (operation: ProviderOperationRecord['operation']): ProviderOperationSettlementDisposition => {
    const disposition = binding.settleProviderOperationBinding(operation);
    if (disposition.kind === 'refused') return { ...disposition, remedy: { kind: 'remote-settlement' } };
    return disposition;
  };

  const releasePermitThroughSettlement = (
    permit: LaunchPermit,
    operation: ProviderOperationRecord['operation'],
  ): ProviderOperationSettlementDisposition => {
    const preparation = binding.prepareProviderOperationBinding(permit, operation);
    if (preparation.kind === 'refused') {
      return { ...preparation, remedy: { kind: 'remote-settlement' } };
    }
    const settlement = settleBinding(operation);
    if (settlement.kind === 'refused') return settlement;
    permits.delete(operation.jobId);
    return { kind: 'already-settled' };
  };

  const hold = (record: ProviderOperationRecord, reason: string): StartupHoldDisposition => {
    const message = (reason.trim() || 'Provider operation startup ownership was refused.').slice(0, 4096);
    let current: ProviderOperationRecord | null = record;
    while (current !== null) {
      if (current.phase === 'settlement-pending') return { kind: 'settlement-pending', record: current };
      const next = providerOperationRecordSchema.parse({
        ...current,
        revision: current.revision + 1,
        retryNotBeforeMs: Number.MAX_SAFE_INTEGER,
        retryCount: current.retryCount + 1,
        lastError: {
          observedAtMs: runtime.time.now(),
          code: 'provider_operation_startup_ownership_refused',
          message,
        },
      });
      const result = compareAndSwapProviderOperation(progressStore.getDb(), current, next);
      if (result.kind === 'updated') return { kind: 'fenced', record: next };
      current = result.current;
    }
    return { kind: 'record-absent' };
  };

  const settleOwnership = (
    record: Extract<ProviderOperationRecord, { phase: 'settlement-pending' }>,
    restoredPermit: LaunchPermit | null,
  ): ProviderOperationStartupRecordOwnership => {
    const bindingDisposition =
      restoredPermit === null
        ? settleBinding(record.operation)
        : releasePermitThroughSettlement(restoredPermit, record.operation);
    return { phase: record.phase, operation: record.operation, restoredPermit, bindingDisposition };
  };

  const releaseAbsent = (
    record: ProviderOperationRecord,
    restoredPermit: LaunchPermit | null,
  ): ProviderOperationStartupRecordOwnership => {
    let transferredHolder: LaunchPermit['holder'] | null = null;
    let bindingCanRetire = true;
    if (restoredPermit !== null) {
      const disposition = releasePermitThroughSettlement(restoredPermit, record.operation);
      if (disposition.kind === 'refused') {
        permits.delete(record.operation.jobId);
        const release = binding.releaseLaunch(restoredPermit);
        if (release.kind === 'transferred') transferredHolder = release.holder;
      }
    } else {
      bindingCanRetire = settleBinding(record.operation).kind !== 'refused';
    }
    if (bindingCanRetire && transferredHolder === null && !permits.has(record.operation.jobId)) {
      const retirement = binding.retireProviderOperationBinding(record.operation);
      if (retirement.kind === 'refused') {
        return {
          phase: record.phase,
          operation: record.operation,
          restoredPermit: null,
          bindingDisposition: {
            kind: 'refused',
            reason: `Provider operation binding retirement was refused: ${retirement.reason}`,
            remedy: { kind: 'recovery-quarantine-clear', command: { kind: 'list' } },
          },
        };
      }
    }
    return {
      phase: record.phase,
      operation: record.operation,
      restoredPermit: null,
      bindingDisposition:
        transferredHolder === null
          ? {
              kind: 'not-reconciled',
              reason: 'record-absent',
              owner: { kind: 'generic-job-recovery' },
            }
          : {
              kind: 'not-reconciled',
              reason: 'record-absent',
              owner: { kind: 'transferred-launch', holder: transferredHolder },
            },
    };
  };

  const resolveHold = (
    record: ProviderOperationRecord,
    restoredPermit: LaunchPermit | null,
    disposition: StartupHoldDisposition,
    refusal: Extract<ProviderOperationStartupRecordOwnership['bindingDisposition'], { kind: 'refused' }>,
  ): ProviderOperationStartupRecordOwnership => {
    switch (disposition.kind) {
      case 'fenced':
        return {
          phase: disposition.record.phase,
          operation: disposition.record.operation,
          restoredPermit,
          bindingDisposition: refusal,
        };
      case 'record-absent':
        return releaseAbsent(record, restoredPermit);
      case 'settlement-pending':
        return settleOwnership(disposition.record, restoredPermit);
    }
    return assertNever(disposition);
  };

  const quarantineAmbiguousReadable = (record: ProviderOperationRecord): ProviderOperationRemedy => {
    const key = recordKey(record.operation);
    const revision = recordFingerprint(record);
    const subject = unreadableProviderOperationSubject(key, revision);
    const remedy = {
      kind: 'recovery-quarantine-discard' as const,
      command: {
        kind: 'discard-provider-operation' as const,
        key,
        revision: `fingerprint:${revision}`,
        allowReadable: true,
      },
    };
    const persisted = quarantine.upsert({
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject,
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'More than one readable provider operation row claims this job.',
      detail: 'More than one readable provider operation row claims this job.',
      remedy,
    });
    if (!persisted && quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, key) === null) {
      log(`Provider operation ambiguity quarantine failed for ${key}.\n`);
    }
    return remedy;
  };

  const clearResolvedReadableAmbiguity = (record: ProviderOperationRecord): void => {
    const key = recordKey(record.operation);
    const entry = quarantine
      .list()
      .find(
        (candidate) =>
          candidate.boundary === UNREADABLE_PROVIDER_OPERATION_BOUNDARY &&
          candidate.subject.key === key &&
          candidate.errorMessage === 'More than one readable provider operation row claims this job.',
      );
    if (entry?.state !== 'active') return;
    quarantine.delete({ boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY, subject: entry.subject });
  };

  const prepareBinding = (
    permit: LaunchPermit,
    record: StartupPreparationRecord,
  ): ProviderOperationStartupRecordOwnership => {
    const disposition = binding.prepareProviderOperationBinding(permit, record.operation);
    if (disposition.kind !== 'refused') {
      permits.delete(record.operation.jobId);
      return {
        phase: record.phase,
        operation: record.operation,
        restoredPermit: permit,
        bindingDisposition: disposition,
      };
    }
    const dispositionHold = hold(record, disposition.reason);
    return resolveHold(record, permit, dispositionHold, {
      kind: 'refused',
      reason: disposition.reason,
      remedy: { kind: 'restart-coordinator' },
    });
  };

  const hydrateRecord = (snapshotRecord: ProviderOperationRecord): ProviderOperationStartupRecordOwnership => {
    const snapshotRestoresPermit = phaseRestoresPermit(snapshotRecord.phase);
    let existingPermit = permits.get(snapshotRecord.operation.jobId);
    if (snapshotRecord.phase === 'local-recovery-pending' && existingPermit?.kind === 'undecided-provider-operation') {
      permits.delete(snapshotRecord.operation.jobId);
      const release = binding.releaseLaunch(existingPermit.permit);
      if (release.kind === 'transferred') {
        return {
          phase: snapshotRecord.phase,
          operation: snapshotRecord.operation,
          restoredPermit: null,
          bindingDisposition: {
            kind: 'refused',
            reason: `Launch ownership transferred to ${JSON.stringify(release.holder)}.`,
            remedy: { kind: 'remote-settlement' },
          },
        };
      }
      existingPermit = undefined;
    }
    if (!snapshotRestoresPermit && existingPermit?.kind === 'undecided-provider-operation') {
      permits.set(snapshotRecord.operation.jobId, {
        kind: 'operation',
        permit: existingPermit.permit,
        operationId: snapshotRecord.operation.operationId,
      });
    }
    const reusableExistingPermit =
      existingPermit !== undefined &&
      (existingPermit.kind === 'undecided-provider-operation' ||
        existingPermit.operationId === snapshotRecord.operation.operationId);
    const restoredPermit = snapshotRestoresPermit
      ? restorePermit(snapshotRecord.operation.jobId, {
          kind: 'operation',
          operationId: snapshotRecord.operation.operationId,
        })
      : reusableExistingPermit && existingPermit !== undefined
        ? existingPermit.permit
        : null;
    const current = readProviderOperation(progressStore.getDb(), snapshotRecord.operation);
    if (current === null) return releaseAbsent(snapshotRecord, restoredPermit);
    clearResolvedReadableAmbiguity(current);

    if (current.phase === 'settlement-pending') return settleOwnership(current, restoredPermit);
    if (current.phase === 'local-recovery-pending') {
      return {
        phase: current.phase,
        operation: current.operation,
        restoredPermit,
        bindingDisposition: { kind: 'not-required', owner: 'generic-job-recovery' },
      };
    }
    if (current.phase === 'prestart-cleanup-pending') {
      if (restoredPermit === null) {
        const reason = 'The provider prestart cleanup has no restored recovery permit.';
        return resolveHold(current, restoredPermit, hold(current, reason), {
          kind: 'refused',
          reason,
          remedy: { kind: 'restart-coordinator' },
        });
      }
      return {
        phase: current.phase,
        operation: current.operation,
        restoredPermit,
        bindingDisposition: { kind: 'not-required', owner: 'prestart-cleanup' },
      };
    }
    if (restoredPermit === null) {
      const reason = 'The provider operation has no restored recovery permit.';
      return resolveHold(current, restoredPermit, hold(current, reason), {
        kind: 'refused',
        reason,
        remedy: { kind: 'restart-coordinator' },
      });
    }

    return prepareBinding(restoredPermit, current);
  };

  const refuseAmbiguous = (
    snapshotRecord: ProviderOperationRecord,
    reason: string,
  ): ProviderOperationStartupRecordOwnership => {
    const current = readProviderOperation(progressStore.getDb(), snapshotRecord.operation);
    if (current === null) {
      const restoredPermit = permits.get(snapshotRecord.operation.jobId)?.permit ?? null;
      return {
        phase: snapshotRecord.phase,
        operation: snapshotRecord.operation,
        restoredPermit,
        bindingDisposition: {
          kind: 'not-reconciled',
          reason: 'record-absent',
          owner:
            restoredPermit === null
              ? { kind: 'generic-job-recovery' }
              : { kind: 'provider-operation-recovery', holder: restoredPermit.holder },
        },
      };
    }
    const disposition = hold(current, reason);
    const restoredPermit = permits.get(current.operation.jobId)?.permit ?? null;
    switch (disposition.kind) {
      case 'record-absent':
        return {
          phase: current.phase,
          operation: current.operation,
          restoredPermit,
          bindingDisposition: {
            kind: 'not-reconciled',
            reason: 'record-absent',
            owner:
              restoredPermit === null
                ? { kind: 'generic-job-recovery' }
                : { kind: 'provider-operation-recovery', holder: restoredPermit.holder },
          },
        };
      case 'settlement-pending':
        return {
          phase: disposition.record.phase,
          operation: disposition.record.operation,
          restoredPermit,
          bindingDisposition: settleBinding(disposition.record.operation),
        };
      case 'fenced': {
        const remedy = quarantineAmbiguousReadable(disposition.record);
        return {
          phase: disposition.record.phase,
          operation: disposition.record.operation,
          restoredPermit,
          bindingDisposition: {
            kind: 'refused',
            reason,
            remedy,
          },
        };
      }
    }
    return assertNever(disposition);
  };

  const holdReadableBesideUnreadable = (
    snapshotRecord: ProviderOperationRecord,
  ): ProviderOperationStartupRecordOwnership => {
    const current = readProviderOperation(progressStore.getDb(), snapshotRecord.operation);
    if (current === null) {
      const restoredPermit = permits.get(snapshotRecord.operation.jobId)?.permit ?? null;
      return {
        phase: snapshotRecord.phase,
        operation: snapshotRecord.operation,
        restoredPermit,
        bindingDisposition: {
          kind: 'not-reconciled',
          reason: 'record-absent',
          owner:
            restoredPermit === null
              ? { kind: 'generic-job-recovery' }
              : { kind: 'provider-operation-recovery', holder: restoredPermit.holder },
        },
      };
    }
    if (current.phase === 'settlement-pending') {
      const owned = permits.get(current.operation.jobId);
      const restoredPermit = owned?.kind === 'undecided-provider-operation' ? owned.permit : null;
      return {
        phase: current.phase,
        operation: current.operation,
        restoredPermit,
        bindingDisposition:
          restoredPermit === null
            ? settleBinding(current.operation)
            : releasePermitThroughSettlement(restoredPermit, current.operation),
      };
    }
    return refuseAmbiguous(current, 'The job is also named by an unreadable provider operation record.');
  };

  const snapshot = (): ProviderOperationStartupSnapshot => {
    const scan = readProviderOperations(progressStore.getDb());
    return Object.freeze({
      records: Object.freeze([...scan.records]),
      unreadable: Object.freeze(attributeUnreadableProviderOperations(progressStore.getDb(), scan.unreadableKeys)),
    });
  };

  const hydrate = (ownershipSnapshot: ProviderOperationStartupSnapshot): ProviderOperationStartupOwnership => {
    const readableSnapshotJobIds = new Set(ownershipSnapshot.records.map((record) => record.operation.jobId));
    const settlementSnapshotJobIds = new Set(
      ownershipSnapshot.records
        .filter((record) => record.phase === 'settlement-pending')
        .map((record) => record.operation.jobId),
    );
    const unreadableSubjects = ownershipSnapshot.unreadable.flatMap((attribution) =>
      attribution.jobs.kind === 'known'
        ? attribution.jobs.values.map((jobId) => ({
            recordKey: attribution.key,
            revision: attribution.revision,
            jobId,
          }))
        : [],
    );
    const undecidedRecordKeysByJob = new Map<string, string[]>();
    for (const { jobId, recordKey: unreadableRecordKey } of unreadableSubjects) {
      const recordKeys = undecidedRecordKeysByJob.get(jobId) ?? [];
      recordKeys.push(unreadableRecordKey);
      undecidedRecordKeysByJob.set(jobId, recordKeys);
    }
    for (const record of ownershipSnapshot.records) {
      const recordKeys = undecidedRecordKeysByJob.get(record.operation.jobId);
      if (recordKeys === undefined) continue;
      recordKeys.push(recordKey(record.operation));
    }
    const restoreUnreadablePermit = (jobId: string): LaunchPermit | null => {
      const status = progressStore.readStatus(jobId);
      if (
        settlementSnapshotJobIds.has(jobId) ||
        (status !== null && isTerminalPhase(status.phase) && !readableSnapshotJobIds.has(jobId))
      ) {
        return null;
      }
      const recordKeys = undecidedRecordKeysByJob.get(jobId);
      if (recordKeys === undefined) throw new Error(`Unreadable provider-operation ownership lost job ${jobId}.`);
      return restorePermit(jobId, { kind: 'undecided-provider-operation', recordKeys });
    };
    const unreadable = unreadableSubjects.map(({ recordKey: unreadableRecordKey, revision, jobId }) => ({
      recordKey: unreadableRecordKey,
      revision,
      jobId,
      restoredPermit: restoreUnreadablePermit(jobId),
    }));
    const unreadableJobIds = new Set(unreadable.map(({ jobId }) => jobId));
    const readableRecordCounts = new Map<string, number>();
    for (const record of ownershipSnapshot.records) {
      readableRecordCounts.set(record.operation.jobId, (readableRecordCounts.get(record.operation.jobId) ?? 0) + 1);
    }
    for (const [jobId, count] of readableRecordCounts) {
      if (
        count > 1 &&
        ownershipSnapshot.records.some(
          (record) => record.operation.jobId === jobId && phaseRestoresPermit(record.phase),
        )
      ) {
        const recordKeys = ownershipSnapshot.records
          .filter((record) => record.operation.jobId === jobId)
          .map((record) => recordKey(record.operation));
        restorePermit(jobId, { kind: 'undecided-provider-operation', recordKeys });
      }
    }
    const records = ownershipSnapshot.records.map((record) =>
      (readableRecordCounts.get(record.operation.jobId) ?? 0) > 1
        ? refuseAmbiguous(record, 'The job has more than one readable provider operation record.')
        : unreadableJobIds.has(record.operation.jobId)
          ? holdReadableBesideUnreadable(record)
          : hydrateRecord(record),
    );
    const readableJobIds = records.flatMap((record) =>
      record.bindingDisposition.kind === 'not-reconciled' ? [] : [record.operation.jobId],
    );
    const holds = records.flatMap((record) =>
      record.bindingDisposition.kind === 'refused'
        ? [
            {
              kind: 'operation' as const,
              jobId: record.operation.jobId,
              operationId: record.operation.operationId,
              reason: record.bindingDisposition.reason,
              remedy: record.bindingDisposition.remedy,
            },
          ]
        : [],
    );
    const unreadableHolds = unreadable.flatMap((ownership) =>
      ownership.restoredPermit === null
        ? []
        : [
            {
              kind: 'unreadable-record' as const,
              jobId: ownership.jobId,
              recordKey: ownership.recordKey,
              reason: 'The provider operation record is unreadable, so its live ownership cannot be decided.',
              remedy: {
                kind: 'recovery-quarantine-discard' as const,
                command: {
                  kind: 'discard-provider-operation' as const,
                  key: ownership.recordKey,
                  revision: `fingerprint:${ownership.revision}`,
                  allowReadable: false,
                },
              },
            },
          ],
    );
    const startupHolds = [...holds, ...unreadableHolds];
    return Object.freeze({
      completion:
        startupHolds.length === 0
          ? Object.freeze({ kind: 'complete' as const })
          : Object.freeze({ kind: 'held' as const, holds: Object.freeze(startupHolds) }),
      jobIds: Object.freeze([
        ...new Set([
          ...readableJobIds,
          ...unreadable.flatMap(({ jobId }) => {
            const status = progressStore.readStatus(jobId);
            return status !== null && isTerminalPhase(status.phase) ? [] : [jobId];
          }),
        ]),
      ]),
      records: Object.freeze(records),
      unreadable: Object.freeze(unreadable),
    });
  };

  const adoptRepaired = (
    record: ProviderOperationRecord,
    repairedRecordKey?: string,
  ): ProviderOperationStartupRecordOwnership => {
    const owned = permits.get(record.operation.jobId);
    if (owned?.kind === 'undecided-provider-operation' && repairedRecordKey !== undefined) {
      permits.set(record.operation.jobId, {
        ...owned,
        recordKeys: owned.recordKeys.filter((candidate) => candidate !== repairedRecordKey),
      });
    }
    const scan = readProviderOperations(progressStore.getDb());
    const unreadable = attributeUnreadableProviderOperations(progressStore.getDb(), scan.unreadableKeys).filter(
      (attribution) => attribution.jobs.kind === 'known' && attribution.jobs.values.includes(record.operation.jobId),
    );
    const readableForJob = scan.records.filter((candidate) => candidate.operation.jobId === record.operation.jobId);
    const readableRecordKeys = readableForJob.map((candidate) => recordKey(candidate.operation));
    if (unreadable.length > 0) {
      restorePermit(record.operation.jobId, {
        kind: 'undecided-provider-operation',
        recordKeys: [...unreadable.map((attribution) => attribution.key), ...readableRecordKeys],
      });
    }
    if (unreadable.length > 0) return holdReadableBesideUnreadable(record);
    if (readableForJob.length > 1) {
      restorePermit(record.operation.jobId, {
        kind: 'undecided-provider-operation',
        recordKeys: readableRecordKeys,
      });
      return refuseAmbiguous(record, 'The job has more than one readable provider operation record.');
    }
    return hydrateRecord(record);
  };

  const release = (operation: ProviderOperationRecord['operation']): ProviderOperationStartupRelease => {
    const owned = permits.get(operation.jobId);
    if (owned?.kind !== 'operation' || owned.operationId !== operation.operationId) return { kind: 'not-owned' };
    permits.delete(operation.jobId);
    return binding.releaseLaunch(owned.permit);
  };

  const releaseUnreadable = (repairedRecordKey: string): UnreadableProviderOperationStartupResolution => {
    let released = 0;
    const readableRecords: Array<Readonly<{ recordKey: string; record: ProviderOperationRecord }>> = [];
    for (const [jobId, owned] of permits) {
      if (owned.kind !== 'undecided-provider-operation' || !owned.recordKeys.includes(repairedRecordKey)) continue;
      const retainRecordKeys = (recordKeys: readonly string[]): boolean => {
        const permit = binding.holdUndecidedProviderOperationLaunch(owned.permit, recordKeys);
        if (permit === null) return false;
        permits.set(jobId, { ...owned, permit, recordKeys });
        return true;
      };
      const scan = readProviderOperations(progressStore.getDb());
      const remainingUnreadableKeys = attributeUnreadableProviderOperations(
        progressStore.getDb(),
        scan.unreadableKeys,
      ).flatMap((attribution) =>
        attribution.jobs.kind === 'known' && attribution.jobs.values.includes(jobId) ? [attribution.key] : [],
      );
      const readableForJob = scan.records.filter((record) => record.operation.jobId === jobId);
      const readableRecordKeys = readableForJob.map((record) => recordKey(record.operation));
      if (remainingUnreadableKeys.length > 0) {
        retainRecordKeys([...remainingUnreadableKeys, ...readableRecordKeys]);
        continue;
      }
      const soleReadable = readableForJob.length === 1 ? readableForJob[0] : undefined;
      if (soleReadable !== undefined) {
        retainRecordKeys(readableRecordKeys);
        readableRecords.push({ recordKey: recordKey(soleReadable.operation), record: soleReadable });
        continue;
      }
      if (readableForJob.length > 1) {
        retainRecordKeys(readableRecordKeys);
        continue;
      }
      permits.delete(jobId);
      const disposition = binding.releaseLaunch(owned.permit);
      switch (disposition.kind) {
        case 'released':
          released += 1;
          continue;
        case 'already-released':
        case 'transferred':
          continue;
      }
      assertNever(disposition);
    }
    return Object.freeze({ released, readableRecords: Object.freeze(readableRecords) });
  };

  return {
    retireAbsentSupersededProviderOperations: () => {
      let retired = 0;
      let retained = 0;
      for (const row of readSupersededProviderOperations(progressStore.getDb())) {
        if (row.processTargets === null || row.processTargets.length === 0) {
          retained += 1;
          continue;
        }
        if (
          observeSupersededProviderOperationTargets(row.processTargets, runtime.process.observeLiveness) !== 'absent'
        ) {
          retained += 1;
          continue;
        }
        retireSupersededProviderOperation(progressStore.getDb(), row.key);
        retired += 1;
        backendLog.warn(
          `Retired a provider operation record this build cannot read whose processes are all absent: ${row.key}`,
        );
      }
      return Object.freeze({ retired, retained });
    },
    snapshot,
    hydrate,
    adoptRepaired,
    release,
    releaseUnreadable,
    reclaimTerminalUndecided: ({ jobId, phase }) => {
      if (!isTerminalPhase(phase)) return;
      const owned = permits.get(jobId);
      if (owned?.kind !== 'undecided-provider-operation') return;
      if (binding.reclaimLaunchPermit(owned.permit)) permits.delete(jobId);
    },
    completeRecovery: (jobId) => {
      const owned = permits.get(jobId);
      if (owned === undefined) return;
      permits.delete(jobId);
      const disposition = binding.releaseLaunch(owned.permit);
      if (disposition.kind === 'transferred') {
        throw new Error(`Launch ownership transferred to ${JSON.stringify(disposition.holder)}.`);
      }
    },
    holdRecoveryFailure: (record, reason) =>
      resolveHold(record, null, hold(record, reason), {
        kind: 'refused',
        reason,
        remedy: { kind: 'restart-coordinator' },
      }),
    releaseAll: () => {
      for (const { permit } of permits.values()) void binding.releaseLaunch(permit);
      permits.clear();
    },
  };
}
