import type { TimePort, TimerHandle } from '../../infra/port-types.js';
import { nowIsoString } from '../../infra/time.js';
import type {
  AppServerProxyPlacementResult,
  AppServerProxyRouteRequest,
} from '../../jobs/contracts/app-server-proxy-route.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import { buildJobEventRefs } from '../../jobs/refs.js';
import { deleteProviderOperationRuntimeMeta } from '../../jobs/runtime-meta-store.js';
import type { ProxyPreparedAppServerOperation } from '../../provider-proxy/protocol.js';
import {
  compareAndSwapProviderOperation,
  deleteProviderOperation,
  insertProviderOperation,
  readProviderOperation,
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
  providerOperationRuntimeMeta,
  writeProviderOperationCompatibilityMeta,
} from './provider-proxy-operation-activation.js';

export type ProviderOperationReconciliationEvidence =
  | Readonly<{ kind: 'unresolved' }>
  | Readonly<{
      kind: 'activation-ack-replayed';
      activationAck: ProviderOperationActivationAck;
      localRuntimeCommitCompleted: boolean;
    }>
  | Readonly<{ kind: 'released-never-started'; prepareAttemptKey: string }>
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
  prepared: ProxyPreparedAppServerOperation;
  request: AppServerProxyRouteRequest;
  release: () => void;
  resolve: (result: AppServerProxyPlacementResult) => void;
}>;

type ProviderOperationReconcilerDeps = Readonly<{
  getProgressStore: () => Pick<JobProgressStore, 'getDb' | 'commit' | 'readStatus'>;
  authorityFor: (record: ProviderOperationRecord) => DurableProviderProxyOperationAuthority | null;
  registry: Pick<LocalOperationRegistry, 'activate'>;
  backendNamespace: string;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  batchSize?: number;
  onError?: (message: string) => void;
}>;

export type BeginProviderOperationPublication = Readonly<{
  record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>;
  prepared: ProxyPreparedAppServerOperation;
  request: AppServerProxyRouteRequest;
  release: () => void;
  authority: DurableProviderProxyOperationAuthority;
}>;

type ProviderOperationSettlementListener = (identity: ProviderOperationIdentity) => void;
const settlementListeners = new Set<ProviderOperationSettlementListener>();

export function notifyProviderOperationSettlementPending(identity: ProviderOperationIdentity): void {
  for (const listener of settlementListeners) listener(identity);
}

const TIMER_MIN_MS = 25;
const TIMER_MAX_MS = 2_000;

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

function acquiredHostRef(request: AppServerProxyRouteRequest, record: ProviderOperationRecord) {
  return request.hostSpec.leaseMode === 'job-exclusive'
    ? {
        provider: request.provider,
        fingerprint: record.locator.hostFingerprint,
        instanceId: record.operation.proxyInstanceId,
        leaseMode: 'job-exclusive' as const,
        ownerJobId: request.jobId,
      }
    : {
        provider: request.provider,
        fingerprint: record.locator.hostFingerprint,
        instanceId: record.operation.proxyInstanceId,
        leaseMode: 'shared' as const,
      };
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

  begin(input: BeginProviderOperationPublication): Promise<AppServerProxyPlacementResult> {
    const key = operationKey(input.record.operation);
    if (this.#publications.has(key)) {
      return Promise.resolve({ kind: 'failed', reason: 'Provider operation publication is already active.' });
    }

    return new Promise<AppServerProxyPlacementResult>((resolve) => {
      this.#publications.set(key, {
        operation: input.record.operation,
        prepared: input.prepared,
        request: input.request,
        release: input.release,
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
  ): Promise<void> {
    const key = operationKey(record.operation);
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing;
    const running = this.#drive(record, preferredAuthority).finally(() => {
      this.#inFlight.delete(key);
      if (record.phase !== 'settlement-pending' && this.#settlements.has(key)) this.wake();
    });
    this.#inFlight.set(key, running);
    return running;
  }

  async #drive(
    initial: ProviderOperationRecord,
    preferredAuthority?: DurableProviderProxyOperationAuthority,
  ): Promise<void> {
    let record: ProviderOperationRecord | null = initial;
    let authority =
      preferredAuthority !== undefined && sameAuthority(initial, preferredAuthority)
        ? preferredAuthority
        : this.#deps.authorityFor(initial);

    for (let transitionCount = 0; transitionCount < 8 && record !== null; transitionCount += 1) {
      if (record.phase === 'executing') return;
      authority = authority !== null && sameAuthority(record, authority) ? authority : this.#deps.authorityFor(record);
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
    if (publication === undefined) {
      await this.#recordRetry(record, new Error('The prepared operation envelope is unavailable in this generation.'));
      return null;
    }

    try {
      const result = await authority.prepareOperation(record.operation, publication.prepared);
      if (result.state === 'capacity') {
        const deleted = deleteProviderOperation(this.#deps.getProgressStore().getDb(), record);
        if (deleted.kind === 'conflict') return deleted.current;
        this.#complete(record.operation, { kind: 'local-authorized', reason: result.reason });
        return null;
      }
      return this.#transition(
        record,
        providerOperationRecordSchema.parse({
          ...record,
          phase: 'guardian-activation-pending',
          reservation: result.reservation,
          providerRoot: result.providerRoot,
          jointContainmentReceipt: result.jointContainmentReceipt,
          revision: record.revision + 1,
          retryNotBeforeMs: this.#deps.time.now(),
          retryCount: 0,
          lastError: null,
        }),
      );
    } catch (error: unknown) {
      let retryError = error;
      if (providerOperationErrorIsAmbiguous(error)) {
        try {
          const inspected = await authority.inspectOperation(record.operation, record.prepareAttemptKey);
          if (inspected.state === 'prepared') {
            return this.#transition(
              record,
              providerOperationRecordSchema.parse({
                ...record,
                phase: 'guardian-activation-pending',
                reservation: inspected.reservation,
                providerRoot: inspected.providerRoot,
                jointContainmentReceipt: inspected.jointContainmentReceipt,
                revision: record.revision + 1,
                retryNotBeforeMs: this.#deps.time.now(),
                retryCount: 0,
                lastError: null,
              }),
            );
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
          prepareAttemptKey: record.prepareAttemptKey,
          phase: 'prestart-cleanup-pending',
          reservation: record.reservation,
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
          prepareAttemptKey: record.prepareAttemptKey,
          phase: 'prestart-cleanup-pending',
          reservation: record.reservation,
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
      const released = await authority.cancelOperation(record.operation, record.prepareAttemptKey, record.reservation);
      const verdict = providerOperationTerminationVerdict(record, {
        kind: 'released-never-started',
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
    const publication = this.#publications.get(operationKey(record.operation));
    if (publication === undefined) {
      throw new Error('Runtime publication context is unavailable in this coordinator generation.');
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
    let updated = false;
    progressStore.commit((commit) => {
      const result = compareAndSwapProviderOperation(progressStore.getDb(), record, next);
      if (result.kind === 'conflict') {
        return undefined;
      }
      updated = true;
      writeProviderOperationCompatibilityMeta(progressStore.getDb(), next);
      const status = progressStore.readStatus(record.operation.jobId);
      commit.append({
        type: 'job.runtime.started',
        stream: { kind: 'job', id: record.operation.jobId },
        namespace: status?.backendNamespace ?? this.#deps.backendNamespace,
        project: status?.projectRoot,
        refs: buildJobEventRefs({ jobId: record.operation.jobId, sessionId: status?.sessionId ?? null }),
        body: {
          transport: 'app-server',
          startedAt: nowIsoString(this.#deps.time.now()),
          providerMeta: {
            provider: publication.request.provider,
            leaseState: 'acquired',
            hostRef: acquiredHostRef(publication.request, next),
          },
        },
      });
      return undefined;
    });

    if (!updated) {
      if (readProviderOperation(progressStore.getDb(), record.operation)?.phase === 'executing') return;
      throw new Error('Provider operation journal changed before execution could be committed.');
    }

    const meta = providerOperationRuntimeMeta(next);
    const control = authority.buildOperationControl(record.operation);
    this.#deps.registry.activate(meta, control, publication.release);
    this.#complete(record.operation, { kind: 'remote-executing' });
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
        if (!this.#publications.has(operationKey(record.operation))) continue;
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
    for (const publication of this.#publications.values()) {
      if (publication.operation.proxyInstanceId !== authority.proxyInstanceId) continue;
      const record = readProviderOperation(db, publication.operation);
      if (record !== null && sameAuthority(record, authority)) await this.reconcile(record, authority);
    }
    for (const [key, identity] of this.#settlements) {
      const record = readProviderOperation(db, identity);
      if (record === null) {
        this.#settlements.delete(key);
        continue;
      }
      if (record.phase === 'settlement-pending' && sameAuthority(record, authority)) {
        await this.reconcile(record, authority);
      }
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
