import { AsyncLocalStorage } from 'node:async_hooks';

import type { TimePort, TimerHandle } from '../../infra/port-types.js';
import { assertNever, errorMessage } from '../../infra/error-format.js';
import type { AppServerProxyPlacementResult } from '../../jobs/contracts/app-server-proxy-route.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import { buildJobEventRefs } from '../../jobs/refs.js';
import {
  providerHostUnserviceableLastError,
  type ProviderOperationTerminalizationPort,
  type ProviderOperationTerminalizationResult,
} from '../../jobs/provider-operation-terminalization.js';
import { isAbortStopCause, type ProviderStopCause } from '../../providers/contract.js';
import { operationPrepareAttemptKey } from '../../provider-proxy/ledger.js';
import {
  providerOperationPreparePermanentRefusalSchema,
  type ProviderOperationPreparePermanentRefusal,
} from '../../provider-proxy/protocol.js';
import {
  providerOperationCleanupIdentity,
  readProviderOperationJobLaunch,
} from '../../jobs/provider-operation-state.js';
import {
  compareAndSwapProviderOperation,
  completeExecutingProviderOperationAttachment,
  deleteProviderOperation,
  finishProviderOperationDueSelection,
  insertProviderOperation,
  readProviderOperation,
  readProviderOperationDueSelections,
  readProviderOperationForJob,
  readProviderOperations,
  readProviderOperationsDue,
  ProviderOperationJournalError,
  type ProviderOperationDueSelection,
  type ProviderOperationRetryOwnership,
} from '../../store/provider-operation-journal.js';
import {
  providerOperationRecordSchema,
  type ProviderOperationAfterReleaseDirective,
  type ProviderOperationActivationAck,
  type ProviderOperationIdentity,
  type ProviderOperationNeverStartedDirective,
  type ProviderOperationRecord,
  type ProviderOperationTerminalDirective,
} from '../../store/provider-operation-record.js';
import type { DurableProviderProxyOperationAuthority } from '../live/provider-proxy/operation-route.js';
import type { LocalOperationRegistry } from './operation-registry.js';
import {
  providerOperationErrorCode,
  providerOperationErrorIsAmbiguous,
  providerOperationErrorReason,
  providerOperationPrepareAttempt,
  type ProviderOperationPrepareAttempt,
} from './provider-proxy-operation-activation.js';
import type { ProviderOperationPrepareMaterializationResult } from './provider-operation-prepare.js';
import {
  providerProxySetIdentitiesEqual,
  ProviderProxySetIdentityIndex,
  providerProxySetIdentityFromRecord,
  providerProxySetReference,
  type ProviderProxySetKey,
  type ProviderProxySetIdentity,
} from './provider-proxy-set/identity.js';
import type { ProviderOperationRecoveryAcceptance } from './recovery/index.js';
import {
  type ContainmentAbsenceAcceptance,
  type ContainmentAbsenceOperationalIncident,
} from './provider-proxy-set/index.js';
import {
  containmentDisappearanceNoticeSchema,
  type ContainmentDisappearanceAcceptance,
  type ContainmentDisappearanceNotice,
  type DisappearanceDeliveryAttemptOutcome,
  type ProviderContainmentDisappearanceConsumer,
} from './provider-containment-disappearance.js';
import {
  isProviderProxyRecoveryFatalError,
  type ProviderProxyRecoveryDispatcher,
} from './provider-proxy-recovery-policy.js';

export type ProviderOperationReconciliationEvidence =
  | Readonly<{ kind: 'unresolved' }>
  | Readonly<{
      kind: 'activation-ack-replayed';
      activationAck: ProviderOperationActivationAck;
      localRuntimeCommitCompleted: boolean;
    }>
  | Readonly<{
      kind: 'released-never-started';
      operation: ProviderOperationIdentity;
      prepareAttemptNumber: number;
      prepareAttemptKey: string;
    }>
  | Readonly<{ kind: 'released-after-terminal'; settledThroughProviderSeq: number }>;

export type StartupProviderSetWork = Readonly<{
  key: ProviderProxySetKey;
  identity: ProviderProxySetIdentity;
  operations: readonly ProviderOperationIdentity[];
}>;

export type StartupSetRecoveryResult =
  | Readonly<{ kind: 'authority'; authority: DurableProviderProxyOperationAuthority }>
  | Readonly<{ kind: 'absence-accepted'; acceptance: ContainmentAbsenceAcceptance }>
  | Readonly<{ kind: 'retry-scheduled'; reason: string; nextAttemptAtMs: number }>;

export type StartupOperationReconciliationResult =
  | Readonly<{ kind: 'pass-completed' }>
  | Readonly<{
      kind: 'retry-scheduled';
      operation: ProviderOperationIdentity;
      reason: string;
      nextAttemptAtMs: number;
    }>;

export type StartupReconciliationIncident =
  | Readonly<{
      kind: 'set-retry-scheduled';
      setIdentity: ProviderProxySetIdentity;
      operations: readonly ProviderOperationIdentity[];
      reason: string;
      nextAttemptAtMs: number;
    }>
  | Readonly<{
      kind: 'operation-retry-scheduled';
      setIdentity: ProviderProxySetIdentity;
      operation: ProviderOperationIdentity;
      reason: string;
      nextAttemptAtMs: number;
    }>
  | Readonly<{
      kind: 'absence-retry-owned';
      setIdentity: ProviderProxySetIdentity;
      disappearanceReceipt: string;
      incident: ContainmentAbsenceOperationalIncident;
    }>;

export type StartupReconciliationReport = Readonly<{
  setsVisited: number;
  operationsVisited: number;
  incidents: readonly StartupReconciliationIncident[];
}>;

export interface StartupSetRecoveryPort {
  recoverSetAtStartup(work: StartupProviderSetWork, signal: AbortSignal): Promise<StartupSetRecoveryResult>;
}

function groupStartupProviderSetWork(records: readonly ProviderOperationRecord[]): StartupProviderSetWork[] {
  const identityIndex = new ProviderProxySetIdentityIndex();
  const groups = new Map<ProviderProxySetKey, StartupProviderSetWork>();
  for (const record of records) {
    if (record.phase === 'local-recovery-pending') continue;
    const identity = providerProxySetIdentityFromRecord(record);
    const key = identityIndex.add(identity);
    const group = groups.get(key);
    groups.set(key, {
      key,
      identity,
      operations: group === undefined ? [record.operation] : [...group.operations, record.operation],
    });
  }
  return [...groups.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((group) => ({
      ...group,
      operations: [...group.operations].sort((left, right) => operationKey(left).localeCompare(operationKey(right))),
    }));
}

export class StartupSetRecoveryProducer implements StartupSetRecoveryPort {
  readonly #recoveries = new Map<ProviderProxySetKey, Promise<StartupSetRecoveryResult>>();
  readonly #recoverSet: (work: StartupProviderSetWork, signal: AbortSignal) => Promise<StartupSetRecoveryResult>;

  constructor(recoverSet: (work: StartupProviderSetWork, signal: AbortSignal) => Promise<StartupSetRecoveryResult>) {
    this.#recoverSet = recoverSet;
  }

  recoverSetAtStartup(work: StartupProviderSetWork, signal: AbortSignal): Promise<StartupSetRecoveryResult> {
    const existing = this.#recoveries.get(work.key);
    if (existing !== undefined) return existing;
    const started = this.#recover(work, signal);
    this.#recoveries.set(work.key, started);
    return started;
  }

  #recover(work: StartupProviderSetWork, signal: AbortSignal): Promise<StartupSetRecoveryResult> {
    return awaitStartup(this.#recoverSet(work, signal), signal);
  }
}

export type ProviderOperationTerminationVerdict =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'executing'; activationAck: ProviderOperationActivationAck }>
  | Readonly<{ kind: 'released-never-started' }>
  | Readonly<{ kind: 'released-after-terminal' }>;

const activationMayHaveBegun = (record: ProviderOperationRecord): boolean =>
  record.phase === 'proxy-activation-pending' || record.phase === 'activation-resolution-pending';

export function providerOperationTerminationVerdict(
  record: ProviderOperationRecord,
  evidence: ProviderOperationReconciliationEvidence,
): ProviderOperationTerminationVerdict {
  if (
    evidence.kind === 'activation-ack-replayed' &&
    evidence.localRuntimeCommitCompleted &&
    activationMayHaveBegun(record)
  ) {
    return { kind: 'executing', activationAck: evidence.activationAck };
  }
  if (
    evidence.kind === 'released-never-started' &&
    record.phase === 'prestart-cleanup-pending' &&
    operationKey(evidence.operation) === operationKey(record.operation) &&
    evidence.prepareAttemptNumber === record.prepareAttemptNumber &&
    evidence.prepareAttemptKey === record.prepareAttemptKey
  ) {
    return { kind: 'released-never-started' };
  }
  if (
    evidence.kind === 'released-after-terminal' &&
    record.phase === 'settlement-pending' &&
    evidence.settledThroughProviderSeq >= record.terminalProviderSeq
  ) {
    return { kind: 'released-after-terminal' };
  }
  return { kind: 'pending' };
}

type ActivePublication = Readonly<{
  operation: ProviderOperationIdentity;
  attempt: ProviderOperationPrepareAttempt;
  resolve: (result: AppServerProxyPlacementResult) => void;
  reject: (error: Error) => void;
  disposeAbort: () => void;
}>;

export type ProviderOperationAuthorityAcquisitionResult =
  | DurableProviderProxyOperationAuthority
  | null
  | Readonly<{ kind: 'temporarily-unavailable'; reason: string }>;

function isTemporarilyUnavailableAcquisition(
  value: ProviderOperationAuthorityAcquisitionResult,
): value is Extract<ProviderOperationAuthorityAcquisitionResult, { kind: 'temporarily-unavailable' }> {
  return value !== null && 'kind' in value && value.kind === 'temporarily-unavailable';
}

type ProviderOperationReconcilerDeps = Readonly<{
  getProgressStore: () => Pick<JobProgressStore, 'getDb' | 'commit' | 'readStatus' | 'readLaunchProjection'>;
  authorityFor: (record: ProviderOperationRecord) => DurableProviderProxyOperationAuthority | null;
  acquireAuthority?: (
    record: ProviderOperationRecord,
    signal: AbortSignal,
  ) => Promise<ProviderOperationAuthorityAcquisitionResult>;
  startupSetRecovery: StartupSetRecoveryPort;
  registry: Pick<LocalOperationRegistry, 'activate' | 'attach' | 'settled' | 'stop'>;
  materializePrepare: (
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
  ) => Promise<ProviderOperationPrepareMaterializationResult> | ProviderOperationPrepareMaterializationResult;
  recoverLocalJob(
    record: Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }>,
    signal: AbortSignal,
  ): Promise<unknown>;
  completeLocalRecovery(jobId: string): void;
  terminalization: ProviderOperationTerminalizationPort;
  recoveryDispatcher: ProviderProxyRecoveryDispatcher;
  backendNamespace: string;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  batchSize?: number;
  onFatal(error: ProviderOperationReconcilerFatalError): void;
  onError?: (message: string) => void;
}>;

export type BeginProviderOperationPublication = Readonly<{
  record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>;
  attempt: ProviderOperationPrepareAttempt;
  authority: DurableProviderProxyOperationAuthority;
  signal: AbortSignal;
}>;

type ProviderOperationSettlementListener = (identity: ProviderOperationIdentity) => void;
const settlementListeners = new Set<ProviderOperationSettlementListener>();

export function notifyProviderOperationSettlementPending(identity: ProviderOperationIdentity): void {
  for (const listener of settlementListeners) listener(identity);
}

const TIMER_MIN_MS = 25;
const TIMER_MAX_MS = 2_000;
const NEVER_ABORTS = new AbortController().signal;
const CONTAINMENT_DRIVE_FENCE = Symbol('provider-containment-drive-fence');

export class ProviderOperationReconcilerFatalError extends Error {
  readonly stage: 'due-index-corruption' | 'due-turn-repair';
  readonly operation?: ProviderOperationIdentity;
  readonly rawKey?: string;

  constructor(
    stage: ProviderOperationReconcilerFatalError['stage'],
    message: string,
    options?: ErrorOptions & { operation?: ProviderOperationIdentity; rawKey?: string },
  ) {
    super(message, options);
    this.name = 'ProviderOperationReconcilerFatalError';
    this.stage = stage;
    if (options?.operation !== undefined) this.operation = options.operation;
    if (options?.rawKey !== undefined) this.rawKey = options.rawKey;
    Object.setPrototypeOf(this, ProviderOperationReconcilerFatalError.prototype);
  }
}

function awaitStartup<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Provider operation startup reconciliation was aborted.', { cause: signal.reason }),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

class ContainmentDriveFencedError extends Error {
  readonly reason = CONTAINMENT_DRIVE_FENCE;

  constructor() {
    super('Provider authority drive was fenced by exact containment disappearance.');
    this.name = 'ContainmentDriveFencedError';
  }
}

type AuthorityDriveContext = Readonly<{
  key: string;
  epoch: number;
  abort: AbortController;
  signal: AbortSignal;
}>;

type ContainmentDisappearanceDeliveryState =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{
      kind: 'delivering';
      promise: Promise<DisappearanceDeliveryAttemptOutcome>;
    }>
  | Readonly<{
      kind: 'consumed';
      acceptance: ContainmentDisappearanceAcceptance;
    }>;

type LatchedContainmentDisappearance = {
  notice: ContainmentDisappearanceNotice;
  delivery: ContainmentDisappearanceDeliveryState;
};

type OperationSerializer = {
  epoch: number;
  activeAbort: AbortController | null;
  inFlight: Promise<void> | null;
  disappearance: LatchedContainmentDisappearance | null;
};

type ExecutingAttachmentAttempt =
  | Readonly<{
      kind: 'attached';
      record: Extract<ProviderOperationRecord, { phase: 'executing' }>;
    }>
  | Readonly<{ kind: 'operation-absent' }>
  | Readonly<{ kind: 'advanced'; current: ProviderOperationRecord | null }>
  | Readonly<{ kind: 'retry-recorded' }>;

function operationKey(identity: ProviderOperationIdentity): string {
  return `${identity.jobId}:${identity.operationId}:${identity.proxyInstanceId}:${identity.buildSetId}`;
}

function sameAuthority(record: ProviderOperationRecord, authority: DurableProviderProxyOperationAuthority): boolean {
  return providerProxySetIdentitiesEqual(authority.setIdentity, providerProxySetIdentityFromRecord(record));
}

function retryDelayMs(retryCount: number): number {
  return Math.min(TIMER_MIN_MS * 2 ** Math.min(retryCount, 6), TIMER_MAX_MS);
}

function isProviderOperationRecoveryAcceptance(
  value: unknown,
  jobId: string,
): value is ProviderOperationRecoveryAcceptance {
  if (typeof value !== 'object' || value === null) return false;
  const acceptance = value as Partial<ProviderOperationRecoveryAcceptance>;
  return acceptance.state === 'accepted' && acceptance.jobId === jobId && acceptance.owner === 'recovery-coordinator';
}

function boundedPrepareRefusalReason(error: unknown): string {
  const reason = providerOperationErrorReason(error).trim();
  return (reason.length === 0 ? 'Provider operation prepare was refused.' : reason).slice(0, 4096);
}

export class ProviderOperationReconciler implements ProviderContainmentDisappearanceConsumer {
  readonly #deps: ProviderOperationReconcilerDeps;
  readonly #batchSize: number;
  readonly #publications = new Map<string, ActivePublication>();
  readonly #attachments = new Map<string, ProviderOperationIdentity>();
  readonly #settlements = new Map<string, ProviderOperationIdentity>();
  readonly #serializers = new Map<string, OperationSerializer>();
  readonly #driveContext = new AsyncLocalStorage<AuthorityDriveContext>();
  #unsubscribeSettlement: (() => void) | null = null;
  #timer: TimerHandle | null = null;
  #started = false;
  #polling = false;
  #pollRequested = false;
  #fatal = false;

  constructor(deps: ProviderOperationReconcilerDeps) {
    const batchSize = deps.batchSize ?? 32;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive safe integer.');
    }
    this.#deps = deps;
    this.#batchSize = batchSize;
  }

  start(): void {
    if (this.#started || this.#fatal) return;
    this.#started = true;
    const listener = (identity: ProviderOperationIdentity): void => this.settlementPending(identity);
    settlementListeners.add(listener);
    this.#unsubscribeSettlement = () => settlementListeners.delete(listener);
    this.#schedule(TIMER_MIN_MS);
  }

  stop(): void {
    this.#started = false;
    this.#unsubscribeSettlement?.();
    this.#unsubscribeSettlement = null;
    if (this.#timer !== null) {
      this.#deps.time.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async reconcileAtStartup(signal: AbortSignal): Promise<StartupReconciliationReport> {
    const records = readProviderOperations(this.#deps.getProgressStore().getDb());
    const incidents: StartupReconciliationIncident[] = [];
    let setsVisited = 0;
    let operationsVisited = 0;
    for (const work of groupStartupProviderSetWork(records)) {
      signal.throwIfAborted();
      const currentRecords = this.#readCurrentStartupSet(work);
      if (currentRecords.length === 0) continue;

      setsVisited += 1;
      operationsVisited += currentRecords.length;
      incidents.push(...(await this.#reconcileStartupSet(work, currentRecords, signal)));
    }
    return { setsVisited, operationsVisited, incidents };
  }

  #readCurrentStartupSet(work: StartupProviderSetWork): ProviderOperationRecord[] {
    const currentRecords: ProviderOperationRecord[] = [];
    for (const operation of [...work.operations].sort((left, right) =>
      operationKey(left).localeCompare(operationKey(right)),
    )) {
      const current = readProviderOperation(this.#deps.getProgressStore().getDb(), operation);
      if (current === null || current.phase === 'local-recovery-pending') continue;
      if (!providerProxySetIdentitiesEqual(providerProxySetIdentityFromRecord(current), work.identity)) {
        throw new Error(`provider_proxy_startup_set_identity_changed:${operationKey(operation)}`);
      }
      currentRecords.push(current);
    }
    return currentRecords;
  }

  async #reconcileStartupSet(
    work: StartupProviderSetWork,
    currentRecords: readonly ProviderOperationRecord[],
    signal: AbortSignal,
  ): Promise<StartupReconciliationIncident[]> {
    const currentWork: StartupProviderSetWork = {
      ...work,
      operations: currentRecords.map((record) => record.operation),
    };
    const recovery = await awaitStartup(this.#deps.startupSetRecovery.recoverSetAtStartup(currentWork, signal), signal);
    if (recovery.kind === 'absence-accepted') {
      const disposition = await awaitStartup(recovery.acceptance.initialDisposition, signal);
      if (disposition.kind !== 'operational-retry-owned') return [];
      return disposition.incidents.map(
        (incident): StartupReconciliationIncident => ({
          kind: 'absence-retry-owned',
          setIdentity: work.identity,
          disappearanceReceipt: recovery.acceptance.disappearanceReceipt,
          incident,
        }),
      );
    }
    if (recovery.kind === 'retry-scheduled') {
      for (const record of currentRecords) {
        this.#scheduleStartupSetRetry(record, recovery.reason, recovery.nextAttemptAtMs);
      }
      return [
        {
          kind: 'set-retry-scheduled',
          setIdentity: work.identity,
          operations: currentRecords.map((record) => record.operation),
          reason: recovery.reason,
          nextAttemptAtMs: recovery.nextAttemptAtMs,
        },
      ];
    }

    const incidents: StartupReconciliationIncident[] = [];
    for (const record of currentRecords) {
      const result = await awaitStartup(this.#reconcileStartupOperation(record, recovery.authority, signal), signal);
      if (result.kind === 'retry-scheduled') {
        incidents.push({
          kind: 'operation-retry-scheduled',
          setIdentity: work.identity,
          operation: result.operation,
          reason: result.reason,
          nextAttemptAtMs: result.nextAttemptAtMs,
        });
      }
    }
    return incidents;
  }

  async #reconcileStartupOperation(
    record: ProviderOperationRecord,
    authority: DurableProviderProxyOperationAuthority,
    signal: AbortSignal,
  ): Promise<StartupOperationReconciliationResult> {
    await this.reconcile(record, authority, signal);
    const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
    if (current === null) return { kind: 'pass-completed' };
    if (!providerProxySetIdentitiesEqual(providerProxySetIdentityFromRecord(current), authority.setIdentity)) {
      throw new Error(`provider_proxy_startup_set_identity_changed:${operationKey(record.operation)}`);
    }
    if (current.retryCount <= record.retryCount || current.lastError === null) return { kind: 'pass-completed' };
    this.#verifyStartupRetry(current);
    return {
      kind: 'retry-scheduled',
      operation: current.operation,
      reason: current.lastError.message,
      nextAttemptAtMs: current.retryNotBeforeMs,
    };
  }

  #scheduleStartupSetRetry(record: ProviderOperationRecord, reason: string, nextAttemptAtMs: number): void {
    const now = this.#deps.time.now();
    const next = providerOperationRecordSchema.parse({
      ...record,
      revision: record.revision + 1,
      retryCount: record.retryCount + 1,
      retryNotBeforeMs: nextAttemptAtMs,
      lastError: {
        observedAtMs: now,
        code: 'provider_proxy_set_recovery_unavailable',
        message: reason,
      },
    });
    const result = compareAndSwapProviderOperation(this.#deps.getProgressStore().getDb(), record, next);
    if (result.kind !== 'updated') {
      throw new Error(`provider_proxy_startup_retry_mutation_conflict:${operationKey(record.operation)}`);
    }
    this.#verifyStartupRetry(result.record);
  }

  #verifyStartupRetry(record: ProviderOperationRecord): void {
    const db = this.#deps.getProgressStore().getDb();
    const current = readProviderOperation(db, record.operation);
    if (
      current === null ||
      current.revision !== record.revision ||
      current.retryNotBeforeMs !== record.retryNotBeforeMs ||
      current.lastError === null
    ) {
      throw new Error(`provider_proxy_startup_retry_record_missing:${operationKey(record.operation)}`);
    }
    const recordCount = readProviderOperations(db).length;
    const verificationCutoff = Math.min(record.retryNotBeforeMs + 1, Number.MAX_SAFE_INTEGER);
    const due = readProviderOperationsDue(db, verificationCutoff, Math.max(recordCount, 1));
    if (!due.some((candidate) => operationKey(candidate.operation) === operationKey(record.operation))) {
      throw new Error(`provider_proxy_startup_retry_due_index_missing:${operationKey(record.operation)}`);
    }
  }

  begin(input: BeginProviderOperationPublication): Promise<AppServerProxyPlacementResult> {
    const key = operationKey(input.record.operation);
    if (this.#publications.has(key)) {
      return Promise.reject(new Error('Provider operation publication is already active.'));
    }

    return new Promise<AppServerProxyPlacementResult>((resolve, reject) => {
      let inserted = false;
      let abortRequestedAt: string | null = null;
      const onAbort = (): void => {
        abortRequestedAt ??= new Date(this.#deps.time.now()).toISOString();
        if (!inserted) return;
        this.#requestControlIntent(input.record.operation, 'signal_abort', abortRequestedAt, input.authority);
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      this.#publications.set(key, {
        operation: input.record.operation,
        attempt: input.attempt,
        resolve,
        reject,
        disposeAbort: () => input.signal.removeEventListener('abort', onAbort),
      });
      if (input.signal.aborted) onAbort();
      try {
        insertProviderOperation(this.#deps.getProgressStore().getDb(), input.record);
      } catch (error: unknown) {
        this.#failPublication(
          input.record.operation,
          new Error(`Provider operation journal insert failed: ${providerOperationErrorReason(error)}`, {
            cause: error,
          }),
        );
        return;
      }
      inserted = true;
      if (abortRequestedAt !== null) {
        this.#requestControlIntent(input.record.operation, 'signal_abort', abortRequestedAt, input.authority);
        return;
      }
      void this.reconcile(input.record, input.authority);
    });
  }

  requestStop(jobId: string, cause: ProviderStopCause): void {
    try {
      const record = readProviderOperationForJob(this.#deps.getProgressStore().getDb(), jobId);
      if (record === null) {
        this.#deps.registry.stop(jobId, cause);
        return;
      }
      this.#requestControlIntent(record.operation, cause, new Date(this.#deps.time.now()).toISOString());
    } catch (error: unknown) {
      this.#deps.onError?.(
        `Provider operation stop intent failed for job '${jobId}': ${providerOperationErrorReason(error)}`,
      );
    }
  }

  onControlEstablished(authority: DurableProviderProxyOperationAuthority): void {
    void this.#reconcileActiveForAuthority(authority).catch((error: unknown) => {
      this.#deps.onError?.(
        `Provider operation control-established reconciliation failed: ${providerOperationErrorReason(error)}`,
      );
    });
  }

  settlementPending(identity: ProviderOperationIdentity): void {
    this.#settlements.set(operationKey(identity), identity);
    this.wake();
  }

  wake(): void {
    if (this.#fatal) return;
    if (this.#polling) {
      this.#pollRequested = true;
      return;
    }
    void this.#poll();
  }

  containmentDisappeared(notice: ContainmentDisappearanceNotice): Promise<DisappearanceDeliveryAttemptOutcome> {
    const parsed = containmentDisappearanceNoticeSchema.parse(notice);
    if (
      parsed.operation.buildSetId !== parsed.setIdentity.buildSetId ||
      parsed.operation.proxyInstanceId !== parsed.setIdentity.proxyInstanceId
    ) {
      return Promise.reject(new Error('containment_disappearance_identity_mismatch'));
    }
    const key = operationKey(parsed.operation);
    const serializer = this.#serializerFor(key);
    if (serializer.disappearance === null) {
      serializer.disappearance = { notice: parsed, delivery: { kind: 'ready' } };
      serializer.epoch += 1;
      serializer.activeAbort?.abort(new ContainmentDriveFencedError());
    } else if (!this.#sameDisappearanceNotice(serializer.disappearance.notice, parsed)) {
      return Promise.reject(new Error('containment_disappearance_conflict'));
    }

    const disappearance = serializer.disappearance;
    switch (disappearance.delivery.kind) {
      case 'consumed':
        return Promise.resolve({ kind: 'accepted', acceptance: disappearance.delivery.acceptance });
      case 'delivering':
        return disappearance.delivery.promise;
      case 'ready':
        break;
    }

    const active = serializer.inFlight ?? Promise.resolve();
    const consume = async (): Promise<DisappearanceDeliveryAttemptOutcome> => {
      const outcome = await this.#driveContext.exit(() => this.#consumeContainmentDisappearance(parsed));
      return outcome.kind === 'operational-failure' ? outcome : { kind: 'accepted', acceptance: outcome };
    };
    const promise = active.then(consume, consume);
    disappearance.delivery = { kind: 'delivering', promise };
    void promise.then(
      (outcome) => {
        if (disappearance.delivery.kind !== 'delivering' || disappearance.delivery.promise !== promise) return;
        if (outcome.kind === 'operational-failure') {
          disappearance.delivery = { kind: 'ready' };
          return;
        }
        disappearance.delivery = { kind: 'consumed', acceptance: outcome.acceptance };
        this.wake();
      },
      () => {
        if (disappearance.delivery.kind !== 'delivering' || disappearance.delivery.promise !== promise) return;
        disappearance.delivery = { kind: 'ready' };
      },
    );
    return promise;
  }

  reconcile(
    record: ProviderOperationRecord,
    preferredAuthority?: DurableProviderProxyOperationAuthority,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = operationKey(record.operation);
    const serializer = this.#serializerFor(key);
    if (serializer.disappearance !== null) {
      switch (serializer.disappearance.delivery.kind) {
        case 'ready':
          return Promise.resolve();
        case 'delivering':
          return serializer.disappearance.delivery.promise.then(() => undefined);
        case 'consumed':
          break;
      }
    }
    if (serializer.inFlight !== null) return serializer.inFlight;
    serializer.epoch += 1;
    const abort = new AbortController();
    serializer.activeAbort = abort;
    const context: AuthorityDriveContext = {
      key,
      epoch: serializer.epoch,
      abort,
      signal: signal === undefined ? abort.signal : AbortSignal.any([abort.signal, signal]),
    };
    const running = this.#driveContext
      .run(context, () => this.#drive(record, preferredAuthority, context.signal))
      .catch((error: unknown) => {
        if (error instanceof ContainmentDriveFencedError) return;
        throw error;
      })
      .finally(() => {
        if (serializer.inFlight === running) serializer.inFlight = null;
        if (serializer.activeAbort === abort) serializer.activeAbort = null;
        if (record.phase !== 'settlement-pending' && this.#settlements.has(key)) this.wake();
      });
    serializer.inFlight = running;
    return running;
  }

  #serializerFor(key: string): OperationSerializer {
    const existing = this.#serializers.get(key);
    if (existing !== undefined) return existing;
    const created: OperationSerializer = {
      epoch: 0,
      activeAbort: null,
      inFlight: null,
      disappearance: null,
    };
    this.#serializers.set(key, created);
    return created;
  }

  #sameDisappearanceNotice(left: ContainmentDisappearanceNotice, right: ContainmentDisappearanceNotice): boolean {
    return (
      operationKey(left.operation) === operationKey(right.operation) &&
      left.disappearanceReceipt === right.disappearanceReceipt &&
      providerProxySetIdentitiesEqual(left.setIdentity, right.setIdentity)
    );
  }

  async #awaitAuthority<T>(pending: Promise<T>): Promise<T> {
    const context = this.#driveContext.getStore();
    if (context === undefined) return pending;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(
          context.abort.signal.aborted
            ? new ContainmentDriveFencedError()
            : context.signal.reason instanceof Error
              ? context.signal.reason
              : new Error('Provider authority drive was aborted.'),
        );
      };
      if (context.signal.aborted) {
        onAbort();
        return;
      }
      context.signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (value) => {
          context.signal.removeEventListener('abort', onAbort);
          try {
            this.#assertActiveDrive();
            resolve(value);
          } catch (error: unknown) {
            reject(error instanceof Error ? error : new Error(errorMessage(error)));
          }
        },
        (error: unknown) => {
          context.signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(errorMessage(error)));
        },
      );
    });
  }

  #assertActiveDrive(): void {
    const context = this.#driveContext.getStore();
    if (context === undefined) return;
    const serializer = this.#serializers.get(context.key);
    if (
      context.abort.signal.aborted ||
      serializer === undefined ||
      serializer.epoch !== context.epoch ||
      serializer.activeAbort !== context.abort
    ) {
      throw new ContainmentDriveFencedError();
    }
  }

  async #drive(
    initial: ProviderOperationRecord,
    preferredAuthority?: DurableProviderProxyOperationAuthority,
    signal?: AbortSignal,
  ): Promise<void> {
    let record: ProviderOperationRecord | null = initial;
    if (initial.phase === 'executing') {
      this.#attachments.set(operationKey(initial.operation), initial.operation);
    }
    let authority =
      preferredAuthority !== undefined && sameAuthority(initial, preferredAuthority) ? preferredAuthority : null;

    for (let transitionCount = 0; transitionCount < 8 && record !== null; transitionCount += 1) {
      if (record.phase === 'local-recovery-pending') {
        record = await this.#driveLocalRecovery(record, signal ?? NEVER_ABORTS);
        continue;
      }
      authority = authority !== null && sameAuthority(record, authority) ? authority : this.#deps.authorityFor(record);
      if (authority === null && this.#deps.acquireAuthority !== undefined) {
        const acquired = await this.#awaitAuthority(this.#deps.acquireAuthority(record, signal ?? NEVER_ABORTS));
        if (isTemporarilyUnavailableAcquisition(acquired)) {
          await this.#recordRetry(record, new Error(acquired.reason));
          return;
        }
        authority = acquired;
      }
      if (authority === null) {
        await this.#recordRetry(record, new Error('No live control authority is available for this proxy set.'));
        return;
      }

      if (record.phase === 'executing') {
        record = await this.#driveExecuting(record, authority);
        continue;
      }
      if (record.phase === 'prepare-pending') {
        record = await this.#drivePrepare(record, authority);
        continue;
      }
      if (record.phase === 'guardian-activation-pending') {
        record = await this.#driveGuardianActivation(record, authority);
        continue;
      }
      if (record.phase === 'proxy-activation-pending') {
        record = await this.#driveProxyActivation(record, authority);
        continue;
      }
      if (record.phase === 'prestart-cleanup-pending') {
        record = await this.#drivePrestartCleanup(record, authority);
        continue;
      }
      if (record.phase === 'activation-resolution-pending') {
        record = await this.#driveActivationResolution(record, authority);
        continue;
      }
      if (record.phase === 'settlement-pending') {
        record = await this.#driveSettlement(record, authority);
        continue;
      }
      assertNever(record);
    }
    if (record !== null) this.#schedule(TIMER_MIN_MS);
  }

  async #driveLocalRecovery(
    record: Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }>,
    signal: AbortSignal,
  ): Promise<ProviderOperationRecord | null> {
    this.#assertActiveDrive();
    const publication = this.#publications.get(operationKey(record.operation));
    if (publication !== undefined) {
      let deleted: ReturnType<typeof deleteProviderOperation>;
      try {
        this.#assertActiveDrive();
        deleted = deleteProviderOperation(this.#deps.getProgressStore().getDb(), record);
      } catch (error: unknown) {
        const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
        if (current === null) {
          this.#complete(record.operation, { kind: 'local-authorized', reason: record.reason });
          return null;
        }
        if (current.revision !== record.revision) return current;
        await this.#recordRetry(record, error);
        return null;
      }
      if (deleted.kind === 'conflict' && deleted.current !== null) return deleted.current;
      this.#complete(record.operation, { kind: 'local-authorized', reason: record.reason });
      return null;
    }

    try {
      const acceptance = await this.#awaitAuthority(this.#deps.recoverLocalJob(record, signal));
      if (!isProviderOperationRecoveryAcceptance(acceptance, record.operation.jobId)) {
        throw new Error(`Exact recovery did not accept provider-operation job '${record.operation.jobId}'.`);
      }
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }

    let deleted: ReturnType<typeof deleteProviderOperation>;
    try {
      this.#assertActiveDrive();
      deleted = deleteProviderOperation(this.#deps.getProgressStore().getDb(), record);
    } catch (error: unknown) {
      const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
      if (current === null) {
        this.#deps.completeLocalRecovery(record.operation.jobId);
        return null;
      }
      if (current.revision !== record.revision) return current;
      await this.#recordRetry(record, error);
      return null;
    }
    if (deleted.kind === 'conflict' && deleted.current !== null) return deleted.current;
    this.#deps.completeLocalRecovery(record.operation.jobId);
    return null;
  }

  async #drivePrepare(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    const publication = this.#publications.get(operationKey(record.operation));
    if (publication === undefined || !this.#attemptMatchesRecord(record, publication.attempt)) {
      return this.#recoverPrepare(record, authority);
    }

    let result: Awaited<ReturnType<DurableProviderProxyOperationAuthority['prepareOperation']>>;
    try {
      result = await this.#sendJournaledPrepare(record, publication.attempt, authority);
    } catch (error: unknown) {
      if (!providerOperationErrorIsAmbiguous(error)) {
        return this.#transition(
          record,
          this.#prepareRefusalRecord(
            record,
            providerOperationPreparePermanentRefusalSchema.parse({
              state: 'permanent-refusal',
              code: 'proxy_prepare_refused',
              disposition: 'local-fallback',
              reason: boundedPrepareRefusalReason(error),
            }),
          ),
        );
      }
      try {
        const inspected = await this.#awaitAuthority(
          authority.inspectOperation(record.operation, record.prepareAttemptKey),
        );
        if (inspected.state === 'prepared') {
          return this.#acceptPreparedEvidence(record, inspected);
        }
        if (inspected.state === 'permanent-refusal') return this.#acceptPrepareResult(record, inspected);
        if (inspected.state === 'absent' || inspected.state === 'released-never-started') {
          return this.#recoverPrepare(record, authority, inspected);
        }
        await this.#recordRetry(
          record,
          new Error(
            `${providerOperationErrorReason(error)}; proxy reports '${inspected.state}' for the ambiguous prepare.`,
          ),
        );
        return null;
      } catch (inspectionError: unknown) {
        await this.#recordRetry(
          record,
          new Error(
            `${providerOperationErrorReason(error)}; inspect failed: ${providerOperationErrorReason(inspectionError)}`,
          ),
        );
        return null;
      }
    }
    try {
      return this.#acceptPrepareResult(record, result);
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }
  }

  #attemptMatchesRecord(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    attempt: ProviderOperationPrepareAttempt,
  ): boolean {
    return (
      attempt.request.prepareAttemptNumber === record.prepareAttemptNumber &&
      attempt.prepareAttemptKey === record.prepareAttemptKey &&
      operationPrepareAttemptKey(attempt.request) === record.prepareAttemptKey &&
      operationKey(attempt.request.operation) === operationKey(record.operation)
    );
  }

  async #sendJournaledPrepare(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    attempt: ProviderOperationPrepareAttempt,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<Awaited<ReturnType<DurableProviderProxyOperationAuthority['prepareOperation']>>> {
    if (!this.#attemptMatchesRecord(record, attempt)) {
      throw new Error('Provider operation prepare send is not backed by the committed journal attempt.');
    }
    await this.#awaitAuthority(authority.registerSuccessionOperation(record.operation));
    return this.#awaitAuthority(authority.prepareOperation(attempt));
  }

  #acceptPrepareResult(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    result: Awaited<ReturnType<DurableProviderProxyOperationAuthority['prepareOperation']>>,
  ): ProviderOperationRecord | null {
    if (result.state === 'permanent-refusal') {
      return this.#transition(record, this.#prepareRefusalRecord(record, result));
    }
    if (result.state === 'capacity') {
      return this.#transition(record, this.#toLocalRecoveryPending(record, result.reason, this.#deps.time.now()));
    }
    return this.#acceptPreparedEvidence(record, result);
  }

  #acceptPreparedEvidence(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    evidence: Readonly<{
      reservation: string;
      providerRoot: Readonly<{ pid: number; processStartedAtSeconds: number }>;
      jointContainmentReceipt: string;
    }>,
  ): ProviderOperationRecord | null {
    return this.#transition(
      record,
      providerOperationRecordSchema.parse({
        version: record.version,
        operation: record.operation,
        locator: record.locator,
        prepareAttemptNumber: record.prepareAttemptNumber,
        prepareAttemptKey: record.prepareAttemptKey,
        phase: 'guardian-activation-pending',
        reservation: evidence.reservation,
        providerRoot: evidence.providerRoot,
        jointContainmentReceipt: evidence.jointContainmentReceipt,
        revision: record.revision + 1,
        retryNotBeforeMs: this.#deps.time.now(),
        retryCount: 0,
        lastError: null,
      }),
    );
  }

  async #recoverPrepare(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
    knownInspection?: Extract<
      Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>,
      { state: 'absent' | 'released-never-started' }
    >,
  ): Promise<ProviderOperationRecord | null> {
    try {
      const inspected =
        knownInspection ??
        (await this.#awaitAuthority(authority.inspectOperation(record.operation, record.prepareAttemptKey)));
      if (inspected.state === 'prepared') return this.#acceptPreparedEvidence(record, inspected);
      if (inspected.state === 'permanent-refusal') return this.#acceptPrepareResult(record, inspected);
      if (inspected.state === 'preparing') {
        await this.#recordRetry(record, new Error('Proxy still reports the journaled prepare attempt as preparing.'));
        return null;
      }
      if (inspected.state !== 'absent' && inspected.state !== 'released-never-started') {
        await this.#recordRetry(
          record,
          new Error(`Proxy reported incompatible state '${inspected.state}' for a prepare-pending operation.`),
        );
        return null;
      }

      const released =
        inspected.state === 'released-never-started'
          ? inspected
          : await this.#awaitAuthority(
              authority.cancelOperation(record.operation, record.prepareAttemptNumber, record.prepareAttemptKey),
            );
      if (
        operationKey(released.operation) !== operationKey(record.operation) ||
        released.prepareAttemptNumber !== record.prepareAttemptNumber ||
        released.prepareAttemptKey !== record.prepareAttemptKey
      ) {
        throw new Error('Cancellation acknowledgement did not fence the journaled prepare attempt.');
      }

      const materialized = await this.#awaitAuthority(Promise.resolve(this.#deps.materializePrepare(record)));
      if (materialized.state === 'permanent-refusal') {
        return this.#transition(record, this.#prepareRefusalRecord(record, materialized));
      }
      const nextAttemptNumber = record.prepareAttemptNumber + 1;
      if (!Number.isSafeInteger(nextAttemptNumber))
        throw new Error('Provider operation prepare attempts are exhausted.');
      const attempt = providerOperationPrepareAttempt(
        authority,
        record.operation,
        materialized.prepared,
        nextAttemptNumber,
      );
      const rotated = providerOperationRecordSchema.parse({
        ...record,
        prepareAttemptNumber: nextAttemptNumber,
        prepareAttemptKey: attempt.prepareAttemptKey,
        revision: record.revision + 1,
        retryNotBeforeMs: this.#deps.time.now(),
        retryCount: 0,
        lastError: null,
      });
      if (rotated.phase !== 'prepare-pending') throw new Error('Prepare attempt rotation failed validation.');

      const rotation = compareAndSwapProviderOperation(this.#deps.getProgressStore().getDb(), record, rotated);
      if (rotation.kind === 'conflict') return rotation.current;

      try {
        const result = await this.#sendJournaledPrepare(rotated, attempt, authority);
        return this.#acceptPrepareResult(rotated, result);
      } catch (error: unknown) {
        if (!providerOperationErrorIsAmbiguous(error)) {
          return this.#transition(
            rotated,
            this.#prepareRefusalRecord(
              rotated,
              providerOperationPreparePermanentRefusalSchema.parse({
                state: 'permanent-refusal',
                code: 'proxy_prepare_refused',
                disposition: 'local-fallback',
                reason: boundedPrepareRefusalReason(error),
              }),
            ),
          );
        }
        await this.#recordRetry(rotated, error);
        return null;
      }
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }
  }

  #prepareRefusalRecord(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    refusal: ProviderOperationPreparePermanentRefusal,
  ): Extract<ProviderOperationRecord, { phase: 'prestart-cleanup-pending' }> {
    if (refusal.disposition !== 'terminal-failure') {
      return this.#prestartCleanupRecord(record, { kind: 'local-authorized', reason: refusal.reason });
    }
    const directive = { kind: 'terminal-failed', code: refusal.code, reason: refusal.reason } as const;
    return refusal.code === 'provider_host_unserviceable'
      ? this.#prestartCleanupRecord(
          record,
          directive,
          providerHostUnserviceableLastError(refusal, this.#deps.time.now()),
        )
      : this.#prestartCleanupRecord(record, directive);
  }

  async #driveGuardianActivation(
    record: Extract<ProviderOperationRecord, { phase: 'guardian-activation-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    try {
      const result = await this.#awaitAuthority(
        authority.authorizeOperation(record.operation, {
          reservation: record.reservation,
          providerRoot: record.providerRoot,
          jointContainmentReceipt: record.jointContainmentReceipt,
        }),
      );
      return this.#transition(
        record,
        providerOperationRecordSchema.parse({
          ...record,
          phase: 'proxy-activation-pending',
          jointActivationReceipt: result.jointActivationReceipt,
          revision: record.revision + 1,
          retryNotBeforeMs: this.#deps.time.now(),
          retryCount: 0,
          lastError: null,
        }),
      );
    } catch (error: unknown) {
      if (providerOperationErrorIsAmbiguous(error)) {
        await this.#recordRetry(record, error);
        return null;
      }
      return this.#transition(
        record,
        this.#prestartCleanupRecord(
          record,
          {
            kind: 'local-authorized',
            reason: 'Guardian authorization was refused before proxy activation.',
          },
          {
            observedAtMs: this.#deps.time.now(),
            code: providerOperationErrorCode(error),
            message: providerOperationErrorReason(error),
          },
        ),
      );
    }
  }

  async #driveProxyActivation(
    record: Extract<ProviderOperationRecord, { phase: 'proxy-activation-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    let activationOutcome: Awaited<ReturnType<DurableProviderProxyOperationAuthority['activatePreparedOperation']>>;
    try {
      activationOutcome = await this.#awaitAuthority(
        authority.activatePreparedOperation(record.operation, {
          reservation: record.reservation,
          jointContainmentReceipt: record.jointContainmentReceipt,
          jointActivationReceipt: record.jointActivationReceipt,
        }),
      );
    } catch (error: unknown) {
      if (providerOperationErrorIsAmbiguous(error)) {
        await this.#recordRetry(record, error);
        return null;
      }
      return this.#transition(
        record,
        this.#activationResolutionRecord(
          record,
          {
            kind: 'local-authorized',
            reason: 'The proxy proved that semantic execution never began.',
          },
          {
            observedAtMs: this.#deps.time.now(),
            code: providerOperationErrorCode(error),
            message: providerOperationErrorReason(error),
          },
        ),
      );
    }
    if (activationOutcome.state === 'released-never-started') {
      return this.#transition(
        record,
        this.#prestartCleanupRecord(record, {
          kind: 'local-authorized',
          reason: 'The proxy proved that semantic execution never began.',
        }),
      );
    }
    if (activationOutcome.state === 'released-activation-indeterminate') {
      return this.#transition(
        record,
        this.#activationResolutionRecord(
          record,
          {
            kind: 'local-authorized',
            reason: 'The proxy proved that semantic execution never began.',
          },
          {
            observedAtMs: this.#deps.time.now(),
            code: 'activation_indeterminate',
            message: 'The proxy released an activation whose start boundary could not be proven.',
          },
        ),
      );
    }
    try {
      return await this.#commitExecuting(record, activationOutcome);
    } catch (error: unknown) {
      const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
      if (current?.phase === 'executing') return current;
      if (current !== null && current.revision !== record.revision) return current;
      await this.#recordRetry(record, error);
      return null;
    }
  }

  async #driveActivationResolution(
    record: Extract<ProviderOperationRecord, { phase: 'activation-resolution-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    let inspected: Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>;
    try {
      inspected = await this.#awaitAuthority(authority.inspectOperation(record.operation, record.prepareAttemptKey));
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }

    if (
      inspected.state === 'prepared' ||
      inspected.state === 'released-never-started' ||
      (inspected.state === 'releasing' && inspected.releaseKind === 'never-started')
    ) {
      return this.#transition(record, this.#prestartCleanupRecord(record, record.onNeverStarted));
    }
    if (inspected.state === 'released-activation-indeterminate') {
      try {
        return this.#terminalize(record, record.activationIndeterminate);
      } catch (error: unknown) {
        await this.#recordRetry(record, error);
        return null;
      }
    }
    if (inspected.state === 'absent') {
      try {
        const released = await this.#awaitAuthority(
          authority.cancelOperation(record.operation, record.prepareAttemptNumber, record.prepareAttemptKey),
        );
        const cleanup = this.#prestartCleanupRecord(record, record.onNeverStarted);
        const verdict = providerOperationTerminationVerdict(cleanup, {
          kind: 'released-never-started',
          operation: released.operation,
          prepareAttemptNumber: released.prepareAttemptNumber,
          prepareAttemptKey: released.prepareAttemptKey,
        });
        if (verdict.kind !== 'released-never-started') {
          throw new Error('Cancellation acknowledgement did not match the journal attempt.');
        }
        return this.#transition(record, cleanup);
      } catch (error: unknown) {
        await this.#recordRetry(record, error);
        return null;
      }
    }
    if (inspected.state === 'released-after-terminal' || inspected.state === 'releasing') {
      await this.#recordRetry(record, new Error('Indeterminate remote activation requires operator recovery.'));
      return null;
    }
    if (inspected.state === 'preparing') {
      await this.#recordRetry(record, new Error('Proxy still reports the operation as preparing.'));
      return null;
    }

    try {
      const activationOutcome = await this.#awaitAuthority(
        authority.activatePreparedOperation(record.operation, {
          reservation: record.reservation,
          jointContainmentReceipt: record.jointContainmentReceipt,
          jointActivationReceipt: record.jointActivationReceipt,
        }),
      );
      if (activationOutcome.state === 'released-never-started') {
        return this.#transition(record, this.#prestartCleanupRecord(record, record.onNeverStarted));
      }
      if (activationOutcome.state === 'released-activation-indeterminate') {
        return this.#terminalize(record, record.activationIndeterminate);
      }
      return await this.#commitExecuting(record, activationOutcome);
    } catch (error: unknown) {
      const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
      if (current?.phase === 'executing') return current;
      if (current !== null && current.revision !== record.revision) return current;
      await this.#recordRetry(record, error);
      return null;
    }
  }

  async #drivePrestartCleanup(
    record: Extract<ProviderOperationRecord, { phase: 'prestart-cleanup-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    try {
      const released = await this.#awaitAuthority(
        authority.cancelOperation(record.operation, record.prepareAttemptNumber, record.prepareAttemptKey),
      );
      const verdict = providerOperationTerminationVerdict(record, {
        kind: 'released-never-started',
        operation: released.operation,
        prepareAttemptNumber: released.prepareAttemptNumber,
        prepareAttemptKey: released.prepareAttemptKey,
      });
      if (verdict.kind !== 'released-never-started') {
        await this.#recordRetry(record, new Error('Cancellation acknowledgement did not match the journal attempt.'));
        return null;
      }
      if (record.afterRelease.kind !== 'local-authorized') {
        return this.#terminalize(record, record.afterRelease);
      }
      return this.#transition(
        record,
        this.#toLocalRecoveryPending(record, record.afterRelease.reason, this.#deps.time.now()),
      );
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }
  }

  #terminalize(
    record: ProviderOperationRecord,
    directive: Extract<ProviderOperationAfterReleaseDirective, { kind: 'terminal-failed' | 'terminal-aborted' }>,
  ): ProviderOperationRecord | null {
    this.#assertActiveDrive();
    const result = this.#deps.terminalization.terminalize(record, directive);
    if (result.kind === 'conflict') return result.current;
    this.#complete(record.operation, { kind: 'terminalized' });
    return null;
  }

  async #driveSettlement(
    record: Extract<ProviderOperationRecord, { phase: 'settlement-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    try {
      const released = await this.#awaitAuthority(
        authority.settleOperation(record.operation, record.terminalProviderSeq),
      );
      const verdict = providerOperationTerminationVerdict(record, {
        kind: 'released-after-terminal',
        settledThroughProviderSeq: released.settledThroughProviderSeq,
      });
      if (verdict.kind !== 'released-after-terminal') {
        await this.#recordRetry(record, new Error('Settlement acknowledgement did not cover the terminal watermark.'));
        return null;
      }
      const deleted = this.#deleteSettledOperation(record);
      if (deleted.kind === 'conflict' && deleted.current !== null) return deleted.current;
      this.#settlements.delete(operationKey(record.operation));
      return null;
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }
  }

  async #consumeContainmentDisappearance(
    notice: ContainmentDisappearanceNotice,
  ): Promise<
    ContainmentDisappearanceAcceptance | Extract<DisappearanceDeliveryAttemptOutcome, { kind: 'operational-failure' }>
  > {
    for (;;) {
      const record = readProviderOperation(this.#deps.getProgressStore().getDb(), notice.operation);
      if (record === null) {
        return { kind: 'accepted', operation: notice.operation, disposition: 'record-absent' };
      }
      if (!providerProxySetIdentitiesEqual(providerProxySetIdentityFromRecord(record), notice.setIdentity)) {
        throw new Error('containment_disappearance_record_identity_mismatch');
      }
      if (record.phase === 'settlement-pending') {
        const deleted = this.#deleteSettledOperation(record);
        if (deleted.kind === 'conflict') continue;
        this.#settlements.delete(operationKey(record.operation));
        return { kind: 'accepted', operation: notice.operation, disposition: 'settlement-deleted' };
      }
      if (
        record.phase === 'proxy-activation-pending' ||
        record.phase === 'activation-resolution-pending' ||
        record.phase === 'executing'
      ) {
        const directive =
          record.phase === 'activation-resolution-pending'
            ? record.activationIndeterminate
            : record.phase === 'proxy-activation-pending'
              ? {
                  kind: 'terminal-failed' as const,
                  code: 'activation_indeterminate',
                  reason: `Provider containment disappeared after activation may have begun (${notice.disappearanceReceipt}).`,
                }
              : {
                  kind: 'terminal-failed' as const,
                  code: 'provider_lost',
                  reason: 'The provider became unavailable, so this job stopped before completion. Retry the job.',
                };
        const terminalized = await this.#terminalizeDisappearance(record, directive);
        if (terminalized.kind === 'operational-failure') return terminalized;
        if (terminalized.kind === 'conflict') continue;
        this.#complete(record.operation, { kind: 'terminalized' });
        return { kind: 'accepted', operation: notice.operation, disposition: 'terminalization-committed' };
      }
      if (record.phase === 'prestart-cleanup-pending' && record.afterRelease.kind !== 'local-authorized') {
        const terminalized = await this.#terminalizeDisappearance(record, record.afterRelease);
        if (terminalized.kind === 'operational-failure') return terminalized;
        if (terminalized.kind === 'conflict') continue;
        this.#complete(record.operation, { kind: 'terminalized' });
        return { kind: 'accepted', operation: notice.operation, disposition: 'terminalization-committed' };
      }
      if (record.phase === 'local-recovery-pending') {
        return { kind: 'accepted', operation: notice.operation, disposition: 'local-recovery-committed' };
      }
      const reason =
        record.phase === 'prestart-cleanup-pending' && record.afterRelease.kind === 'local-authorized'
          ? record.afterRelease.reason
          : `Remote start is impossible because the exact provider containment disappeared (${notice.disappearanceReceipt}).`;
      const transitioned = this.#transition(
        record,
        this.#toLocalRecoveryPending(record, reason, this.#deps.time.now()),
      );
      if (transitioned?.phase !== 'local-recovery-pending') continue;
      return { kind: 'accepted', operation: notice.operation, disposition: 'local-recovery-committed' };
    }
  }

  #terminalizeDisappearance(
    record: ProviderOperationRecord,
    directive: ProviderOperationTerminalDirective,
  ): Promise<
    | ProviderOperationTerminalizationResult
    | Extract<DisappearanceDeliveryAttemptOutcome, { kind: 'operational-failure' }>
  > {
    return new Promise((resolve, reject) => {
      const turn = this.#deps.recoveryDispatcher.begin(
        'disappearance-delivery',
        { operation: record.operation, setIdentity: providerProxySetIdentityFromRecord(record) },
        {
          evidence: (value) => resolve(value as ProviderOperationTerminalizationResult),
          retry: () =>
            resolve({
              kind: 'operational-failure',
              code: 'disappearance_consumer_unavailable',
              reason: 'Provider operation terminalization is temporarily unavailable.',
            }),
          fatal: reject,
          cancel: reject,
        },
      );
      turn.start({
        sourceId: 'terminalization',
        producerId: 'disappearance-terminalization',
        input: {
          record,
          directive: this.#withProviderProxySetReference(directive, providerProxySetIdentityFromRecord(record)),
        },
      });
    });
  }

  #withProviderProxySetReference(
    directive: ProviderOperationTerminalDirective,
    identity: ProviderProxySetIdentity,
  ): ProviderOperationTerminalDirective {
    if (directive.kind === 'terminal-aborted') return directive;
    const reference = providerProxySetReference(identity);
    if (directive.reason.includes(`Reference: ${reference}.`)) return directive;
    return { ...directive, reason: `${directive.reason} Reference: ${reference}.` };
  }

  async #commitExecuting(
    record: Extract<ProviderOperationRecord, { phase: 'proxy-activation-pending' | 'activation-resolution-pending' }>,
    activationAck: ProviderOperationActivationAck,
  ): Promise<Extract<ProviderOperationRecord, { phase: 'executing' }>> {
    this.#assertActiveDrive();
    if (activationAck.committedThroughProviderSeq !== 0) {
      throw new Error('A fresh activation acknowledgement must begin at provider watermark zero.');
    }
    const next = providerOperationRecordSchema.parse({
      version: record.version,
      operation: record.operation,
      locator: record.locator,
      prepareAttemptNumber: record.prepareAttemptNumber,
      prepareAttemptKey: record.prepareAttemptKey,
      reservation: record.reservation,
      providerRoot: record.providerRoot,
      jointContainmentReceipt: record.jointContainmentReceipt,
      jointActivationReceipt: record.jointActivationReceipt,
      phase: 'executing',
      activationAck,
      committedThroughProviderSeq: 0,
      controlIntent:
        record.phase === 'activation-resolution-pending' && record.onNeverStarted.kind === 'terminal-aborted'
          ? {
              kind: 'stop',
              cause: record.onNeverStarted.cause,
              requestedAt: record.onNeverStarted.requestedAt,
            }
          : { kind: 'run' },
      revision: record.revision + 1,
      retryNotBeforeMs: this.#deps.time.now(),
      retryCount: 0,
      lastError: null,
    });
    if (next.phase !== 'executing') throw new Error('Executing journal transition failed validation.');

    const progressStore = this.#deps.getProgressStore();
    const launch = readProviderOperationJobLaunch(progressStore, record.operation.jobId);
    const status = progressStore.readStatus(record.operation.jobId);
    if (status === null || status.sessionId === null || status.sessionId !== launch.sessionId) {
      throw new Error('Provider operation runtime publication lacks matching durable job metadata.');
    }
    if (launch.provider !== activationAck.hostRef.provider) {
      throw new Error('Activation acknowledgement provider does not match the durable job launch.');
    }
    let updated = false;
    progressStore.commit((commit) => {
      const result = compareAndSwapProviderOperation(progressStore.getDb(), record, next);
      if (result.kind === 'conflict') {
        return undefined;
      }
      updated = true;
      commit.append({
        type: 'job.runtime.started',
        stream: { kind: 'job', id: record.operation.jobId },
        namespace: status.backendNamespace,
        project: status.projectRoot,
        refs: buildJobEventRefs({ jobId: record.operation.jobId, sessionId: status.sessionId }),
        body: {
          transport: 'app-server',
          startedAt: activationAck.startedAt,
          providerMeta: {
            provider: activationAck.hostRef.provider,
            leaseState: 'acquired',
            hostRef: activationAck.hostRef,
          },
        },
      });
      return undefined;
    });

    if (!updated) {
      const current = readProviderOperation(progressStore.getDb(), record.operation);
      if (current?.phase === 'executing') {
        return current;
      }
      throw new Error('Provider operation journal changed before execution could be committed.');
    }

    return next;
  }

  async #driveExecuting(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    const key = operationKey(record.operation);
    this.#attachments.set(key, record.operation);
    const retryOwnership: ProviderOperationRetryOwnership = {
      retryCount: record.retryCount,
      retryNotBeforeMs: record.retryNotBeforeMs,
      lastError: record.lastError,
    };
    const attempt = await this.#attemptExecutingAttachment(record, authority);
    if (attempt.kind === 'retry-recorded') return null;
    if (attempt.kind === 'advanced') {
      this.#attachments.delete(key);
      this.#deps.registry.settled(record.operation);
      return attempt.current;
    }
    if (attempt.kind === 'operation-absent') {
      this.#attachments.delete(key);
      return this.#terminalize(record, {
        kind: 'terminal-failed',
        code: 'provider_lost',
        reason: 'The provider proxy proved that the committed operation is absent.',
      });
    }

    this.#registerExecuting(attempt.record, authority);
    return this.#completeExecutingAttachment(record, retryOwnership);
  }

  async #attemptExecutingAttachment(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ExecutingAttachmentAttempt> {
    const key = operationKey(record.operation);
    try {
      const result = await this.#awaitAuthority(
        authority.attachOperation(record.operation, record.committedThroughProviderSeq),
      );
      if (result.state === 'operation-absent') {
        if (operationKey(result.operation) !== key) {
          throw new Error('Operation-absent proof named a different operation.');
        }
        return { kind: 'operation-absent' };
      }
      if (result.replayFromProviderSeq !== record.committedThroughProviderSeq + 1) {
        throw new Error('Attachment reply named a different replay boundary.');
      }

      const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
      const attachedRecord = current?.phase === 'executing' ? current : record;
      if (attachedRecord.controlIntent.kind === 'stop') {
        await this.#awaitAuthority(
          authority.buildOperationControl(attachedRecord.operation).stop(attachedRecord.controlIntent.cause),
        );
      }
      return current?.phase === 'executing' || current === null
        ? { kind: 'attached', record: attachedRecord }
        : { kind: 'advanced', current };
    } catch (error: unknown) {
      const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
      if (current?.phase !== 'executing') {
        return { kind: 'advanced', current };
      }
      await this.#recordRetry(current, error);
      return { kind: 'retry-recorded' };
    }
  }

  #completeExecutingAttachment(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    retryOwnership: ProviderOperationRetryOwnership,
  ): ProviderOperationRecord | null {
    const result = completeExecutingProviderOperationAttachment(
      this.#deps.getProgressStore().getDb(),
      record.operation,
      retryOwnership,
      this.#deps.time.now(),
    );
    switch (result.kind) {
      case 'completed':
      case 'already-completed':
        this.#attachments.delete(operationKey(record.operation));
        this.#complete(record.operation, { kind: 'remote-executing' });
        return null;
      case 'advanced':
        this.#attachments.delete(operationKey(record.operation));
        this.#deps.registry.settled(record.operation);
        return result.current;
      case 'retry-superseded':
        return null;
    }
  }

  #registerExecuting(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): void {
    this.#assertActiveDrive();
    const launch = readProviderOperationJobLaunch(this.#deps.getProgressStore(), record.operation.jobId);
    const cleanup = providerOperationCleanupIdentity(launch);
    const control = authority.buildOperationControl(record.operation);
    if (this.#publications.has(operationKey(record.operation))) {
      this.#deps.registry.activate(record, control, cleanup);
    } else {
      this.#deps.registry.attach(record, control, cleanup);
    }
  }

  #prestartCleanupRecord(
    record: ProviderOperationRecord,
    afterRelease: ProviderOperationAfterReleaseDirective,
    lastError: ProviderOperationRecord['lastError'] = record.lastError,
  ): Extract<ProviderOperationRecord, { phase: 'prestart-cleanup-pending' }> {
    const next = providerOperationRecordSchema.parse({
      version: record.version,
      operation: record.operation,
      locator: record.locator,
      prepareAttemptNumber: record.prepareAttemptNumber,
      prepareAttemptKey: record.prepareAttemptKey,
      phase: 'prestart-cleanup-pending',
      cleanupIntent: 'release-never-started',
      afterRelease,
      revision: record.revision + 1,
      retryNotBeforeMs: this.#deps.time.now(),
      retryCount: 0,
      lastError,
    });
    if (next.phase !== 'prestart-cleanup-pending') {
      throw new Error('Prestart cleanup journal transition failed validation.');
    }
    return next;
  }

  #toLocalRecoveryPending(
    record: ProviderOperationRecord,
    reason: string,
    nowMs: number,
  ): Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }> {
    const boundedReason = reason.trim() || 'Provider operation authorized local recovery.';
    const next = providerOperationRecordSchema.parse({
      version: record.version,
      operation: record.operation,
      locator: record.locator,
      prepareAttemptNumber: record.prepareAttemptNumber,
      prepareAttemptKey: record.prepareAttemptKey,
      phase: 'local-recovery-pending',
      recoveryIntent: 'recover-local',
      reason: boundedReason.slice(0, 4_096),
      revision: record.revision + 1,
      retryNotBeforeMs: nowMs,
      retryCount: 0,
      lastError: null,
    });
    if (next.phase !== 'local-recovery-pending') {
      throw new Error('Local recovery journal transition failed validation.');
    }
    return next;
  }

  #activationResolutionRecord(
    record: Extract<ProviderOperationRecord, { phase: 'proxy-activation-pending' | 'activation-resolution-pending' }>,
    onNeverStarted: ProviderOperationNeverStartedDirective,
    lastError: ProviderOperationRecord['lastError'],
  ): Extract<ProviderOperationRecord, { phase: 'activation-resolution-pending' }> {
    const next = providerOperationRecordSchema.parse({
      ...record,
      phase: 'activation-resolution-pending',
      onNeverStarted,
      activationIndeterminate: {
        kind: 'terminal-failed',
        code: 'activation_indeterminate',
        reason: 'The provider activation boundary could not be proven after release.',
      },
      revision: record.revision + 1,
      retryNotBeforeMs: this.#deps.time.now(),
      retryCount: 0,
      lastError,
    });
    if (next.phase !== 'activation-resolution-pending') {
      throw new Error('Activation resolution journal transition failed validation.');
    }
    return next;
  }

  #requestControlIntent(
    identity: ProviderOperationIdentity,
    cause: ProviderStopCause,
    requestedAt: string,
    preferredAuthority?: DurableProviderProxyOperationAuthority,
  ): void {
    let current = readProviderOperation(this.#deps.getProgressStore().getDb(), identity);
    while (current !== null) {
      const aborted = isAbortStopCause(cause) ? ({ kind: 'terminal-aborted', cause, requestedAt } as const) : null;
      let next: ProviderOperationRecord;
      if (current.phase === 'prepare-pending' || current.phase === 'guardian-activation-pending') {
        if (aborted === null) return;
        next = this.#prestartCleanupRecord(current, aborted);
      } else if (current.phase === 'proxy-activation-pending') {
        if (aborted === null) return;
        next = this.#activationResolutionRecord(current, aborted, current.lastError);
      } else if (current.phase === 'activation-resolution-pending') {
        if (aborted === null || current.onNeverStarted.kind === 'terminal-aborted') return;
        next = providerOperationRecordSchema.parse({
          ...current,
          onNeverStarted: aborted,
          revision: current.revision + 1,
          retryNotBeforeMs: this.#deps.time.now(),
          retryCount: 0,
          lastError: current.lastError,
        });
      } else if (current.phase === 'prestart-cleanup-pending') {
        if (aborted === null || current.afterRelease.kind !== 'local-authorized') return;
        next = providerOperationRecordSchema.parse({
          ...current,
          afterRelease: aborted,
          revision: current.revision + 1,
          retryNotBeforeMs: this.#deps.time.now(),
          retryCount: 0,
          lastError: current.lastError,
        });
      } else if (current.phase === 'executing') {
        if (current.controlIntent.kind === 'stop') {
          this.#deps.registry.stop(current.operation.jobId, current.controlIntent.cause);
          void this.reconcile(current, preferredAuthority);
          return;
        }
        next = providerOperationRecordSchema.parse({
          ...current,
          controlIntent: { kind: 'stop', cause, requestedAt },
          revision: current.revision + 1,
          retryNotBeforeMs: this.#deps.time.now(),
          retryCount: 0,
          lastError: current.lastError,
        });
      } else {
        return;
      }

      const result = compareAndSwapProviderOperation(this.#deps.getProgressStore().getDb(), current, next);
      if (result.kind === 'conflict') {
        current = result.current;
        continue;
      }
      if (result.record.phase === 'executing' && result.record.controlIntent.kind === 'stop') {
        this.#deps.registry.stop(result.record.operation.jobId, result.record.controlIntent.cause);
      }
      void this.reconcile(result.record, preferredAuthority);
      return;
    }
  }

  #transition(expected: ProviderOperationRecord, next: ProviderOperationRecord): ProviderOperationRecord | null {
    this.#assertActiveDrive();
    const result = compareAndSwapProviderOperation(this.#deps.getProgressStore().getDb(), expected, next);
    if (result.kind === 'updated') return result.record;
    return result.current;
  }

  #deleteSettledOperation(
    record: Extract<ProviderOperationRecord, { phase: 'settlement-pending' }>,
  ): ReturnType<typeof deleteProviderOperation> {
    this.#assertActiveDrive();
    return deleteProviderOperation(this.#deps.getProgressStore().getDb(), record);
  }

  async #recordRetry(record: ProviderOperationRecord, error: unknown): Promise<void> {
    this.#assertActiveDrive();
    const now = this.#deps.time.now();
    const preserveHostRefusal =
      record.phase === 'prestart-cleanup-pending' &&
      record.afterRelease.kind === 'terminal-failed' &&
      record.afterRelease.code === 'provider_host_unserviceable' &&
      record.lastError?.code === 'provider_host_unserviceable';
    const next = providerOperationRecordSchema.parse({
      ...record,
      revision: record.revision + 1,
      retryCount: record.retryCount + 1,
      retryNotBeforeMs: now + retryDelayMs(record.retryCount),
      lastError: preserveHostRefusal
        ? record.lastError
        : {
            observedAtMs: now,
            code: providerOperationErrorCode(error),
            message: providerOperationErrorReason(error),
          },
    });
    const transitioned = this.#transition(record, next);
    if (transitioned !== null) this.#schedule(retryDelayMs(record.retryCount));
  }

  #complete(identity: ProviderOperationIdentity, result: AppServerProxyPlacementResult): void {
    const key = operationKey(identity);
    const publication = this.#publications.get(key);
    if (publication === undefined) return;
    this.#publications.delete(key);
    publication.disposeAbort();
    publication.resolve(result);
  }

  #failPublication(identity: ProviderOperationIdentity, error: Error): void {
    const key = operationKey(identity);
    const publication = this.#publications.get(key);
    if (publication === undefined) return;
    this.#publications.delete(key);
    publication.disposeAbort();
    publication.reject(error);
  }

  async #poll(preferredAuthority?: DurableProviderProxyOperationAuthority): Promise<void> {
    if (this.#fatal) return;
    if (this.#polling) {
      this.#pollRequested = true;
      return;
    }
    this.#polling = true;
    try {
      const progressStore = this.#deps.getProgressStore();
      const scanCutoffMs = this.#deps.time.now();
      let selections: readonly ProviderOperationDueSelection[];
      try {
        selections = readProviderOperationDueSelections(progressStore.getDb(), scanCutoffMs, this.#batchSize);
      } catch (error: unknown) {
        if (error instanceof ProviderOperationJournalError) {
          this.#latchFatal(
            new ProviderOperationReconcilerFatalError(
              'due-index-corruption',
              `Provider operation due-index selection failed: ${providerOperationErrorReason(error)}`,
              { cause: error },
            ),
          );
          return;
        }
        throw error;
      }
      for (const selection of selections) {
        const result = await this.#reconcileDueSelection(selection, scanCutoffMs, preferredAuthority);
        if (result === 'fatal') return;
      }
      if (this.#fatal) return;
      for (const [key, identity] of this.#settlements) {
        const record = readProviderOperation(progressStore.getDb(), identity);
        if (record === null) {
          this.#settlements.delete(key);
          continue;
        }
        if (record.phase !== 'settlement-pending' || record.retryNotBeforeMs > this.#deps.time.now()) continue;
        if (preferredAuthority !== undefined && !sameAuthority(record, preferredAuthority)) continue;
        await this.reconcile(record, preferredAuthority);
      }
      for (const [key, identity] of this.#attachments) {
        const record = readProviderOperation(progressStore.getDb(), identity);
        if (record === null || record.phase !== 'executing') {
          this.#attachments.delete(key);
          continue;
        }
        if (record.retryNotBeforeMs > this.#deps.time.now()) continue;
        if (preferredAuthority !== undefined && !sameAuthority(record, preferredAuthority)) continue;
        await this.reconcile(record, preferredAuthority);
      }
    } catch (error: unknown) {
      if (!this.#observeFatal(error)) {
        this.#deps.onError?.(`Provider operation reconciliation failed: ${providerOperationErrorReason(error)}`);
      }
    } finally {
      this.#polling = false;
      const pollRequested = this.#pollRequested;
      this.#pollRequested = false;
      if (!this.#fatal) {
        if (pollRequested) {
          void this.#poll();
        } else if (this.#started) {
          this.#schedule(TIMER_MAX_MS);
        }
      }
    }
  }

  async #reconcileDueSelection(
    selection: ProviderOperationDueSelection,
    scanCutoffMs: number,
    preferredAuthority?: DurableProviderProxyOperationAuthority,
  ): Promise<'finished' | 'finished-with-drive-error' | 'fatal'> {
    let driveError: unknown;
    try {
      if (preferredAuthority === undefined || sameAuthority(selection.record, preferredAuthority)) {
        const serializer = this.#serializerFor(operationKey(selection.record.operation));
        const precedingDrive = serializer.inFlight;
        await this.reconcile(selection.record, preferredAuthority);
        if (precedingDrive !== null) {
          const current = readProviderOperation(this.#deps.getProgressStore().getDb(), selection.record.operation);
          if (current !== null && current.retryNotBeforeMs <= scanCutoffMs) {
            await this.reconcile(current, preferredAuthority);
          }
        }
      }
    } catch (error: unknown) {
      driveError = error;
    }

    try {
      finishProviderOperationDueSelection(
        this.#deps.getProgressStore().getDb(),
        selection,
        scanCutoffMs,
        scanCutoffMs + TIMER_MIN_MS,
      );
    } catch (repairError: unknown) {
      const cause =
        driveError === undefined
          ? repairError
          : new AggregateError([repairError, driveError], 'Due-turn repair failed after a domain drive error.', {
              cause: repairError,
            });
      this.#latchFatal(
        new ProviderOperationReconcilerFatalError(
          'due-turn-repair',
          `Provider operation due-turn repair failed: ${providerOperationErrorReason(repairError)}`,
          { cause, operation: selection.record.operation, rawKey: selection.rawKey },
        ),
      );
      return 'fatal';
    }

    if (driveError === undefined) return 'finished';
    if (this.#observeFatal(driveError)) return 'fatal';
    this.#deps.onError?.(
      `Provider operation reconciliation failed for '${operationKey(selection.record.operation)}': ${providerOperationErrorReason(driveError)}`,
    );
    return 'finished-with-drive-error';
  }

  #sealFatal(): boolean {
    if (this.#fatal) return false;
    this.#fatal = true;
    this.#started = false;
    if (this.#timer !== null) {
      this.#deps.time.clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pollRequested = false;
    return true;
  }

  #latchFatal(error: ProviderOperationReconcilerFatalError): void {
    if (this.#sealFatal()) this.#deps.onFatal(error);
  }

  #observeFatal(error: unknown): boolean {
    if (isProviderProxyRecoveryFatalError(error)) {
      this.#sealFatal();
      return true;
    }
    if (error instanceof ProviderOperationReconcilerFatalError) {
      this.#latchFatal(error);
      return true;
    }
    return this.#fatal;
  }

  async #reconcileActiveForAuthority(authority: DurableProviderProxyOperationAuthority): Promise<void> {
    const db = this.#deps.getProgressStore().getDb();
    for (const record of readProviderOperations(db)) {
      if (sameAuthority(record, authority)) await this.reconcile(record, authority);
    }
  }

  #schedule(delayMs: number): void {
    if (!this.#started || this.#fatal) return;
    if (this.#timer !== null) this.#deps.time.clearTimeout(this.#timer);
    this.#timer = this.#deps.time.setTimeout(
      () => {
        this.#timer = null;
        void this.#poll();
      },
      Math.max(TIMER_MIN_MS, Math.min(delayMs, TIMER_MAX_MS)),
    );
    this.#timer.unref?.();
  }
}
