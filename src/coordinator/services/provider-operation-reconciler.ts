import type { TimePort, TimerHandle } from '../../infra/port-types.js';
import type { AppServerProxyPlacementResult } from '../../jobs/contracts/app-server-proxy-route.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import { buildJobEventRefs } from '../../jobs/refs.js';
import { deleteProviderOperationRuntimeMeta } from '../../jobs/runtime-meta-store.js';
import type { ProxyPreparedAppServerOperation } from '../../provider-proxy/protocol.js';
import { operationPrepareAttemptKey } from '../../provider-proxy/ledger.js';
import {
  providerOperationCleanupIdentity,
  readProviderOperationJobLaunch,
} from '../../jobs/provider-operation-state.js';
import {
  compareAndSwapProviderOperation,
  deleteProviderOperation,
  insertProviderOperation,
  readProviderOperation,
  readProviderOperations,
  readProviderOperationsDue,
} from '../../store/provider-operation-journal.js';
import {
  providerOperationRecordSchema,
  type ProviderOperationActivationAck,
  type ProviderOperationIdentity,
  type ProviderOperationRecord,
} from '../../store/provider-operation-record.js';
import type { DurableProviderProxyOperationAuthority } from '../live/provider-proxy/operation-route.js';
import type { LocalOperationRegistry } from './operation-registry.js';
import {
  providerOperationErrorCode,
  providerOperationErrorIsAmbiguous,
  providerOperationErrorReason,
  providerOperationPrepareAttempt,
  providerOperationRuntimeMeta,
  type ProviderOperationPrepareAttempt,
  writeProviderOperationCompatibilityMeta,
} from './provider-proxy-operation-activation.js';

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
  | Readonly<{ kind: 'released-after-terminal'; settledThroughProviderSeq: number }>
  | Readonly<{ kind: 'containment-disappeared'; disappearanceReceipt: string }>;

export type ProviderOperationTerminationVerdict =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'executing'; activationAck: ProviderOperationActivationAck }>
  | Readonly<{ kind: 'released-never-started' }>
  | Readonly<{ kind: 'released-after-terminal' }>
  | Readonly<{ kind: 'indeterminate-activation'; disappearanceReceipt: string }>;

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
  if (evidence.kind === 'containment-disappeared' && activationMayHaveBegun(record)) {
    return { kind: 'indeterminate-activation', disappearanceReceipt: evidence.disappearanceReceipt };
  }
  return { kind: 'pending' };
}

type ActivePublication = Readonly<{
  operation: ProviderOperationIdentity;
  attempt: ProviderOperationPrepareAttempt;
  resolve: (result: AppServerProxyPlacementResult) => void;
}>;

type ProviderOperationReconcilerDeps = Readonly<{
  getProgressStore: () => Pick<JobProgressStore, 'getDb' | 'commit' | 'readStatus' | 'readLaunchProjection'>;
  authorityFor: (record: ProviderOperationRecord) => DurableProviderProxyOperationAuthority | null;
  acquireAuthority?: (
    record: ProviderOperationRecord,
    signal: AbortSignal,
  ) => Promise<DurableProviderProxyOperationAuthority | null>;
  registry: Pick<LocalOperationRegistry, 'activate'>;
  materializePrepare: (
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
  ) => Promise<ProxyPreparedAppServerOperation> | ProxyPreparedAppServerOperation;
  backendNamespace: string;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  batchSize?: number;
  onError?: (message: string) => void;
}>;

export type BeginProviderOperationPublication = Readonly<{
  record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>;
  attempt: ProviderOperationPrepareAttempt;
  authority: DurableProviderProxyOperationAuthority;
}>;

type ProviderOperationSettlementListener = (identity: ProviderOperationIdentity) => void;
const settlementListeners = new Set<ProviderOperationSettlementListener>();

export function notifyProviderOperationSettlementPending(identity: ProviderOperationIdentity): void {
  for (const listener of settlementListeners) listener(identity);
}

const TIMER_MIN_MS = 25;
const TIMER_MAX_MS = 2_000;
const NEVER_ABORTS = new AbortController().signal;

function operationKey(identity: ProviderOperationIdentity): string {
  return `${identity.jobId}:${identity.operationId}:${identity.proxyInstanceId}:${identity.buildSetId}`;
}

function sameAuthority(record: ProviderOperationRecord, authority: DurableProviderProxyOperationAuthority): boolean {
  return (
    authority.proxyInstanceId === record.operation.proxyInstanceId &&
    authority.setIdentity.buildSetId === record.operation.buildSetId &&
    authority.setIdentity.hostFingerprint === record.locator.hostFingerprint
  );
}

function retryDelayMs(retryCount: number): number {
  return Math.min(TIMER_MIN_MS * 2 ** Math.min(retryCount, 6), TIMER_MAX_MS);
}

export class ProviderOperationReconciler {
  readonly #deps: ProviderOperationReconcilerDeps;
  readonly #batchSize: number;
  readonly #publications = new Map<string, ActivePublication>();
  readonly #settlements = new Map<string, ProviderOperationIdentity>();
  readonly #inFlight = new Map<string, Promise<void>>();
  #unsubscribeSettlement: (() => void) | null = null;
  #timer: TimerHandle | null = null;
  #started = false;
  #polling = false;
  #pollRequested = false;

  constructor(deps: ProviderOperationReconcilerDeps) {
    const batchSize = deps.batchSize ?? 32;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive safe integer.');
    }
    this.#deps = deps;
    this.#batchSize = batchSize;
  }

  start(): void {
    if (this.#started) return;
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

  async reconcileAtStartup(signal: AbortSignal): Promise<void> {
    this.start();
    const records = readProviderOperations(this.#deps.getProgressStore().getDb());
    for (const record of records) {
      signal.throwIfAborted();
      if (record.phase !== 'executing') await this.reconcile(record, undefined, signal);
    }
  }

  begin(input: BeginProviderOperationPublication): Promise<AppServerProxyPlacementResult> {
    const key = operationKey(input.record.operation);
    if (this.#publications.has(key)) {
      return Promise.resolve({ kind: 'failed', reason: 'Provider operation publication is already active.' });
    }

    return new Promise<AppServerProxyPlacementResult>((resolve) => {
      this.#publications.set(key, {
        operation: input.record.operation,
        attempt: input.attempt,
        resolve,
      });
      try {
        insertProviderOperation(this.#deps.getProgressStore().getDb(), input.record);
      } catch (error: unknown) {
        this.#complete(input.record.operation, {
          kind: 'failed',
          reason: `Provider operation journal insert failed: ${providerOperationErrorReason(error)}`,
        });
        return;
      }
      void this.reconcile(input.record, input.authority);
    });
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
    if (this.#polling) {
      this.#pollRequested = true;
      return;
    }
    void this.#poll();
  }

  reconcile(
    record: ProviderOperationRecord,
    preferredAuthority?: DurableProviderProxyOperationAuthority,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = operationKey(record.operation);
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing;
    const running = this.#drive(record, preferredAuthority, signal).finally(() => {
      this.#inFlight.delete(key);
      if (record.phase !== 'settlement-pending' && this.#settlements.has(key)) this.wake();
    });
    this.#inFlight.set(key, running);
    return running;
  }

  async #drive(
    initial: ProviderOperationRecord,
    preferredAuthority?: DurableProviderProxyOperationAuthority,
    signal?: AbortSignal,
  ): Promise<void> {
    let record: ProviderOperationRecord | null = initial;
    let authority =
      preferredAuthority !== undefined && sameAuthority(initial, preferredAuthority)
        ? preferredAuthority
        : this.#deps.authorityFor(initial);
    if (authority === null && this.#deps.acquireAuthority !== undefined) {
      authority = await this.#deps.acquireAuthority(initial, signal ?? NEVER_ABORTS);
    }

    for (let transitionCount = 0; transitionCount < 8 && record !== null; transitionCount += 1) {
      if (record.phase === 'executing') return;
      authority = authority !== null && sameAuthority(record, authority) ? authority : this.#deps.authorityFor(record);
      if (authority === null && this.#deps.acquireAuthority !== undefined) {
        authority = await this.#deps.acquireAuthority(record, signal ?? NEVER_ABORTS);
      }
      if (authority === null) {
        await this.#recordRetry(record, new Error('No live control authority is available for this proxy set.'));
        return;
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
    }
    if (record !== null) this.#schedule(TIMER_MIN_MS);
  }

  async #drivePrepare(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    const publication = this.#publications.get(operationKey(record.operation));
    if (publication === undefined || !this.#attemptMatchesRecord(record, publication.attempt)) {
      return this.#recoverPrepare(record, authority);
    }

    try {
      const result = await this.#sendJournaledPrepare(record, publication.attempt, authority);
      return this.#acceptPrepareResult(record, result);
    } catch (error: unknown) {
      let retryError = error;
      if (providerOperationErrorIsAmbiguous(error)) {
        try {
          const inspected = await authority.inspectOperation(record.operation, record.prepareAttemptKey);
          if (inspected.state === 'prepared') {
            return this.#acceptPreparedEvidence(record, inspected);
          }
        } catch (inspectionError: unknown) {
          retryError = new Error(
            `${providerOperationErrorReason(error)}; inspect failed: ${providerOperationErrorReason(inspectionError)}`,
          );
        }
      }
      await this.#recordRetry(record, retryError);
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
    return authority.prepareOperation(attempt);
  }

  #acceptPrepareResult(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    result: Awaited<ReturnType<DurableProviderProxyOperationAuthority['prepareOperation']>>,
  ): ProviderOperationRecord | null {
    if (result.state === 'capacity') {
      const deleted = deleteProviderOperation(this.#deps.getProgressStore().getDb(), record);
      if (deleted.kind === 'conflict') return deleted.current;
      this.#complete(record.operation, { kind: 'local-authorized', reason: result.reason });
      return null;
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
  ): Promise<ProviderOperationRecord | null> {
    try {
      const inspected = await authority.inspectOperation(record.operation, record.prepareAttemptKey);
      if (inspected.state === 'prepared') return this.#acceptPreparedEvidence(record, inspected);
      if (inspected.state === 'preparing') {
        await this.#recordRetry(record, new Error('Proxy still reports the journaled prepare attempt as preparing.'));
        return null;
      }
      if (inspected.state !== 'absent') {
        await this.#recordRetry(
          record,
          new Error(`Proxy reported incompatible state '${inspected.state}' for a prepare-pending operation.`),
        );
        return null;
      }

      const released = await authority.cancelOperation(
        record.operation,
        record.prepareAttemptNumber,
        record.prepareAttemptKey,
      );
      if (
        operationKey(released.operation) !== operationKey(record.operation) ||
        released.prepareAttemptNumber !== record.prepareAttemptNumber ||
        released.prepareAttemptKey !== record.prepareAttemptKey
      ) {
        throw new Error('Cancellation acknowledgement did not fence the journaled prepare attempt.');
      }

      const prepared = await this.#deps.materializePrepare(record);
      const nextAttemptNumber = record.prepareAttemptNumber + 1;
      if (!Number.isSafeInteger(nextAttemptNumber))
        throw new Error('Provider operation prepare attempts are exhausted.');
      const attempt = providerOperationPrepareAttempt(authority, record.operation, prepared, nextAttemptNumber);
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
        await this.#recordRetry(rotated, error);
        return null;
      }
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }
  }

  async #driveGuardianActivation(
    record: Extract<ProviderOperationRecord, { phase: 'guardian-activation-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    try {
      const result = await authority.authorizeOperation(record.operation, {
        reservation: record.reservation,
        providerRoot: record.providerRoot,
        jointContainmentReceipt: record.jointContainmentReceipt,
      });
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
        providerOperationRecordSchema.parse({
          version: record.version,
          operation: record.operation,
          locator: record.locator,
          prepareAttemptNumber: record.prepareAttemptNumber,
          prepareAttemptKey: record.prepareAttemptKey,
          phase: 'prestart-cleanup-pending',
          cleanupIntent: 'release-never-started',
          revision: record.revision + 1,
          retryNotBeforeMs: this.#deps.time.now(),
          retryCount: 0,
          lastError: {
            observedAtMs: this.#deps.time.now(),
            code: providerOperationErrorCode(error),
            message: providerOperationErrorReason(error),
          },
        }),
      );
    }
  }

  async #driveProxyActivation(
    record: Extract<ProviderOperationRecord, { phase: 'proxy-activation-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    let activationAck: ProviderOperationActivationAck;
    try {
      activationAck = await authority.activatePreparedOperation(record.operation, {
        reservation: record.reservation,
        jointContainmentReceipt: record.jointContainmentReceipt,
        jointActivationReceipt: record.jointActivationReceipt,
      });
    } catch (error: unknown) {
      if (providerOperationErrorIsAmbiguous(error)) {
        await this.#recordRetry(record, error);
        return null;
      }
      return this.#transition(
        record,
        providerOperationRecordSchema.parse({
          ...record,
          phase: 'activation-resolution-pending',
          revision: record.revision + 1,
          retryNotBeforeMs: this.#deps.time.now(),
          retryCount: 0,
          lastError: {
            observedAtMs: this.#deps.time.now(),
            code: providerOperationErrorCode(error),
            message: providerOperationErrorReason(error),
          },
        }),
      );
    }
    try {
      await this.#commitExecuting(record, activationAck, authority);
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
    }
    return null;
  }

  async #driveActivationResolution(
    record: Extract<ProviderOperationRecord, { phase: 'activation-resolution-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    let inspected: Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>;
    try {
      inspected = await authority.inspectOperation(record.operation, record.prepareAttemptKey);
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }

    if (
      inspected.state === 'prepared' ||
      (inspected.state === 'releasing' && inspected.activationFingerprint === null)
    ) {
      return this.#transition(
        record,
        providerOperationRecordSchema.parse({
          version: record.version,
          operation: record.operation,
          locator: record.locator,
          prepareAttemptNumber: record.prepareAttemptNumber,
          prepareAttemptKey: record.prepareAttemptKey,
          phase: 'prestart-cleanup-pending',
          cleanupIntent: 'release-never-started',
          revision: record.revision + 1,
          retryNotBeforeMs: this.#deps.time.now(),
          retryCount: 0,
          lastError: record.lastError,
        }),
      );
    }
    if (inspected.state === 'absent' || inspected.state === 'releasing') {
      await this.#recordRetry(record, new Error('Indeterminate remote activation requires operator recovery.'));
      return null;
    }
    if (inspected.state === 'preparing') {
      await this.#recordRetry(record, new Error('Proxy still reports the operation as preparing.'));
      return null;
    }

    try {
      const activationAck = await authority.activatePreparedOperation(record.operation, {
        reservation: record.reservation,
        jointContainmentReceipt: record.jointContainmentReceipt,
        jointActivationReceipt: record.jointActivationReceipt,
      });
      await this.#commitExecuting(record, activationAck, authority);
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
    }
    return null;
  }

  async #drivePrestartCleanup(
    record: Extract<ProviderOperationRecord, { phase: 'prestart-cleanup-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    try {
      const released = await authority.cancelOperation(
        record.operation,
        record.prepareAttemptNumber,
        record.prepareAttemptKey,
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
      const deleted = deleteProviderOperation(this.#deps.getProgressStore().getDb(), record);
      if (deleted.kind === 'conflict') return deleted.current;
      this.#complete(record.operation, {
        kind: 'local-authorized',
        reason: 'The proxy fenced and released the operation before semantic execution began.',
      });
      return null;
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }
  }

  async #driveSettlement(
    record: Extract<ProviderOperationRecord, { phase: 'settlement-pending' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<ProviderOperationRecord | null> {
    try {
      const released = await authority.settleOperation(record.operation, record.terminalProviderSeq);
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

  async #commitExecuting(
    record: Extract<ProviderOperationRecord, { phase: 'proxy-activation-pending' | 'activation-resolution-pending' }>,
    activationAck: ProviderOperationActivationAck,
    authority: DurableProviderProxyOperationAuthority,
  ): Promise<void> {
    if (activationAck.committedThroughProviderSeq !== 0) {
      throw new Error('A fresh activation acknowledgement must begin at provider watermark zero.');
    }
    const next = providerOperationRecordSchema.parse({
      ...record,
      phase: 'executing',
      activationAck,
      committedThroughProviderSeq: 0,
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
    const cleanup = providerOperationCleanupIdentity(launch);
    let updated = false;
    progressStore.commit((commit) => {
      const result = compareAndSwapProviderOperation(progressStore.getDb(), record, next);
      if (result.kind === 'conflict') {
        return undefined;
      }
      updated = true;
      writeProviderOperationCompatibilityMeta(progressStore.getDb(), next);
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
        this.#registerExecuting(current, authority, cleanup);
        return;
      }
      throw new Error('Provider operation journal changed before execution could be committed.');
    }

    this.#registerExecuting(next, authority, cleanup);
    this.#complete(record.operation, { kind: 'remote-executing' });
  }

  #registerExecuting(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    authority: DurableProviderProxyOperationAuthority,
    cleanup: ReturnType<typeof providerOperationCleanupIdentity>,
  ): void {
    const meta = providerOperationRuntimeMeta(record);
    const control = authority.buildOperationControl(record.operation);
    this.#deps.registry.activate(meta, control, cleanup);
  }

  #transition(expected: ProviderOperationRecord, next: ProviderOperationRecord): ProviderOperationRecord | null {
    const result = compareAndSwapProviderOperation(this.#deps.getProgressStore().getDb(), expected, next);
    if (result.kind === 'updated') return result.record;
    return result.current;
  }

  #deleteSettledOperation(
    record: Extract<ProviderOperationRecord, { phase: 'settlement-pending' }>,
  ): ReturnType<typeof deleteProviderOperation> {
    const db = this.#deps.getProgressStore().getDb();
    const ownsTransaction = !db.isTransaction;
    if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
    try {
      const deleted = deleteProviderOperation(db, record);
      if (deleted.kind === 'deleted' || deleted.current === null) {
        deleteProviderOperationRuntimeMeta(db, record.operation.jobId, record.operation.operationId);
      }
      if (ownsTransaction) db.exec('COMMIT');
      return deleted;
    } catch (error: unknown) {
      if (ownsTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Preserve the deletion failure that determines whether reconciliation retries.
        }
      }
      throw error;
    }
  }

  async #recordRetry(record: ProviderOperationRecord, error: unknown): Promise<void> {
    const now = this.#deps.time.now();
    const next = providerOperationRecordSchema.parse({
      ...record,
      revision: record.revision + 1,
      retryCount: record.retryCount + 1,
      retryNotBeforeMs: now + retryDelayMs(record.retryCount),
      lastError: {
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
    publication.resolve(result);
  }

  async #poll(preferredAuthority?: DurableProviderProxyOperationAuthority): Promise<void> {
    if (this.#polling) {
      this.#pollRequested = true;
      return;
    }
    this.#polling = true;
    try {
      const progressStore = this.#deps.getProgressStore();
      const records = readProviderOperationsDue(progressStore.getDb(), this.#deps.time.now(), this.#batchSize);
      for (const record of records) {
        if (preferredAuthority !== undefined && !sameAuthority(record, preferredAuthority)) continue;
        await this.reconcile(record, preferredAuthority);
      }
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
    } catch (error: unknown) {
      this.#deps.onError?.(`Provider operation reconciliation failed: ${providerOperationErrorReason(error)}`);
    } finally {
      this.#polling = false;
      const pollRequested = this.#pollRequested;
      this.#pollRequested = false;
      if (pollRequested) {
        void this.#poll();
      } else if (this.#started) {
        this.#schedule(TIMER_MAX_MS);
      }
    }
  }

  async #reconcileActiveForAuthority(authority: DurableProviderProxyOperationAuthority): Promise<void> {
    const db = this.#deps.getProgressStore().getDb();
    for (const record of readProviderOperations(db)) {
      if (record.phase !== 'executing' && sameAuthority(record, authority)) await this.reconcile(record, authority);
    }
  }

  #schedule(delayMs: number): void {
    if (!this.#started) return;
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
