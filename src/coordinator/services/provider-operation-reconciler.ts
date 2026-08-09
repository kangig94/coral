import type { TimePort, TimerHandle } from '../../infra/port-types.js';
import { assertNever } from '../../infra/error-format.js';
import type { AppServerProxyPlacementResult } from '../../jobs/contracts/app-server-proxy-route.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import { buildJobEventRefs } from '../../jobs/refs.js';
import type { ProviderOperationTerminalizationPort } from '../../jobs/provider-operation-terminalization.js';
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
  deleteProviderOperation,
  insertProviderOperation,
  readProviderOperation,
  readProviderOperationForJob,
  readProviderOperations,
  readProviderOperationsDue,
} from '../../store/provider-operation-journal.js';
import {
  providerOperationRecordSchema,
  type ProviderOperationAfterReleaseDirective,
  type ProviderOperationActivationAck,
  type ProviderOperationIdentity,
  type ProviderOperationNeverStartedDirective,
  type ProviderOperationRecord,
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
  reject: (error: Error) => void;
  disposeAbort: () => void;
}>;

type ProviderOperationReconcilerDeps = Readonly<{
  getProgressStore: () => Pick<JobProgressStore, 'getDb' | 'commit' | 'readStatus' | 'readLaunchProjection'>;
  authorityFor: (record: ProviderOperationRecord) => DurableProviderProxyOperationAuthority | null;
  acquireAuthority?: (
    record: ProviderOperationRecord,
    signal: AbortSignal,
  ) => Promise<
    | DurableProviderProxyOperationAuthority
    | Readonly<{ kind: 'containment-disappeared'; disappearanceReceipt: string }>
    | null
  >;
  registry: Pick<LocalOperationRegistry, 'activate' | 'attach' | 'settled' | 'stop'>;
  materializePrepare: (
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
  ) => Promise<ProviderOperationPrepareMaterializationResult> | ProviderOperationPrepareMaterializationResult;
  terminalization: ProviderOperationTerminalizationPort;
  backendNamespace: string;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  batchSize?: number;
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

function boundedPrepareRefusalReason(error: unknown): string {
  const reason = providerOperationErrorReason(error).trim();
  return (reason.length === 0 ? 'Provider operation prepare was refused.' : reason).slice(0, 4096);
}

export class ProviderOperationReconciler {
  readonly #deps: ProviderOperationReconcilerDeps;
  readonly #batchSize: number;
  readonly #publications = new Map<string, ActivePublication>();
  readonly #attachments = new Map<string, ProviderOperationIdentity>();
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
      await this.reconcile(record, undefined, signal);
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
    if (initial.phase === 'executing') {
      this.#attachments.set(operationKey(initial.operation), initial.operation);
    }
    let authority =
      preferredAuthority !== undefined && sameAuthority(initial, preferredAuthority)
        ? preferredAuthority
        : this.#deps.authorityFor(initial);
    if (authority === null && this.#deps.acquireAuthority !== undefined) {
      const acquired = await this.#deps.acquireAuthority(initial, signal ?? NEVER_ABORTS);
      if (acquired !== null && 'kind' in acquired) {
        const current = await this.#finishContainmentDisappearance(initial, acquired.disappearanceReceipt);
        if (current !== null) this.#schedule(TIMER_MIN_MS);
        return;
      }
      authority = acquired;
    }

    for (let transitionCount = 0; transitionCount < 8 && record !== null; transitionCount += 1) {
      authority = authority !== null && sameAuthority(record, authority) ? authority : this.#deps.authorityFor(record);
      if (authority === null && this.#deps.acquireAuthority !== undefined) {
        const acquired = await this.#deps.acquireAuthority(record, signal ?? NEVER_ABORTS);
        if (acquired !== null && 'kind' in acquired) {
          const current = await this.#finishContainmentDisappearance(record, acquired.disappearanceReceipt);
          if (current !== null) this.#schedule(TIMER_MIN_MS);
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
        const inspected = await authority.inspectOperation(record.operation, record.prepareAttemptKey);
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
    await authority.registerSuccessionOperation(record.operation);
    return authority.prepareOperation(attempt);
  }

  #acceptPrepareResult(
    record: Extract<ProviderOperationRecord, { phase: 'prepare-pending' }>,
    result: Awaited<ReturnType<DurableProviderProxyOperationAuthority['prepareOperation']>>,
  ): ProviderOperationRecord | null {
    if (result.state === 'permanent-refusal') {
      return this.#transition(record, this.#prepareRefusalRecord(record, result));
    }
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
    knownInspection?: Extract<
      Awaited<ReturnType<DurableProviderProxyOperationAuthority['inspectOperation']>>,
      { state: 'absent' | 'released-never-started' }
    >,
  ): Promise<ProviderOperationRecord | null> {
    try {
      const inspected =
        knownInspection ?? (await authority.inspectOperation(record.operation, record.prepareAttemptKey));
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
          : await authority.cancelOperation(record.operation, record.prepareAttemptNumber, record.prepareAttemptKey);
      if (
        operationKey(released.operation) !== operationKey(record.operation) ||
        released.prepareAttemptNumber !== record.prepareAttemptNumber ||
        released.prepareAttemptKey !== record.prepareAttemptKey
      ) {
        throw new Error('Cancellation acknowledgement did not fence the journaled prepare attempt.');
      }

      let materialized: ProviderOperationPrepareMaterializationResult;
      try {
        materialized = await this.#deps.materializePrepare(record);
      } catch (error: unknown) {
        materialized = providerOperationPreparePermanentRefusalSchema.parse({
          state: 'permanent-refusal',
          code: 'prepare_materialization_refused',
          disposition: 'terminal-failure',
          reason: boundedPrepareRefusalReason(error),
        });
      }
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
    return this.#prestartCleanupRecord(
      record,
      refusal.disposition === 'terminal-failure'
        ? { kind: 'terminal-failed', code: refusal.code, reason: refusal.reason }
        : { kind: 'local-authorized', reason: refusal.reason },
    );
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
      activationOutcome = await authority.activatePreparedOperation(record.operation, {
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
      inspected = await authority.inspectOperation(record.operation, record.prepareAttemptKey);
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
        const released = await authority.cancelOperation(
          record.operation,
          record.prepareAttemptNumber,
          record.prepareAttemptKey,
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
      const activationOutcome = await authority.activatePreparedOperation(record.operation, {
        reservation: record.reservation,
        jointContainmentReceipt: record.jointContainmentReceipt,
        jointActivationReceipt: record.jointActivationReceipt,
      });
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
      if (record.afterRelease.kind !== 'local-authorized') {
        return this.#terminalize(record, record.afterRelease);
      }
      // Finding F replaces this existing local completion with its durable local-recovery handoff. Until that
      // owner exists, keep the established local-authorized behavior rather than inventing another deletion path.
      const deleted = deleteProviderOperation(this.#deps.getProgressStore().getDb(), record);
      if (deleted.kind === 'conflict') return deleted.current;
      this.#complete(record.operation, {
        kind: 'local-authorized',
        reason: record.afterRelease.reason,
      });
      return null;
    } catch (error: unknown) {
      await this.#recordRetry(record, error);
      return null;
    }
  }

  #terminalize(
    record: ProviderOperationRecord,
    directive: Extract<ProviderOperationAfterReleaseDirective, { kind: 'terminal-failed' | 'terminal-aborted' }>,
  ): ProviderOperationRecord | null {
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

  async #finishContainmentDisappearance(
    record: ProviderOperationRecord,
    disappearanceReceipt: string,
  ): Promise<ProviderOperationRecord | null> {
    try {
      if (record.phase === 'settlement-pending') {
        const deleted = this.#deleteSettledOperation(record);
        if (deleted.kind === 'conflict') return deleted.current;
        this.#settlements.delete(operationKey(record.operation));
        return null;
      }
      if (record.phase === 'proxy-activation-pending' || record.phase === 'activation-resolution-pending') {
        const directive =
          record.phase === 'activation-resolution-pending'
            ? record.activationIndeterminate
            : {
                kind: 'terminal-failed' as const,
                code: 'activation_indeterminate',
                reason: `Provider containment disappeared after activation may have begun (${disappearanceReceipt}).`,
              };
        return this.#terminalize(record, directive);
      }
      if (record.phase === 'executing') {
        return this.#terminalize(record, {
          kind: 'terminal-failed',
          code: 'provider_lost',
          reason: `Provider execution was interrupted when its containment disappeared (${disappearanceReceipt}).`,
        });
      }
      if (record.phase === 'prestart-cleanup-pending' && record.afterRelease.kind !== 'local-authorized') {
        return this.#terminalize(record, record.afterRelease);
      }
      const deleted = deleteProviderOperation(this.#deps.getProgressStore().getDb(), record);
      if (deleted.kind === 'conflict') return deleted.current;
      const reason =
        record.phase === 'prestart-cleanup-pending' && record.afterRelease.kind === 'local-authorized'
          ? record.afterRelease.reason
          : `Remote start is impossible because the exact provider containment disappeared (${disappearanceReceipt}).`;
      this.#complete(record.operation, { kind: 'local-authorized', reason });
      return null;
    } catch (error: unknown) {
      const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
      if (current !== null && current.revision !== record.revision) return current;
      await this.#recordRetry(record, error);
      return null;
    }
  }

  async #commitExecuting(
    record: Extract<ProviderOperationRecord, { phase: 'proxy-activation-pending' | 'activation-resolution-pending' }>,
    activationAck: ProviderOperationActivationAck,
  ): Promise<Extract<ProviderOperationRecord, { phase: 'executing' }>> {
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
    try {
      const result = await authority.attachOperation(record.operation, record.committedThroughProviderSeq);
      if (result.state === 'operation-absent') {
        if (operationKey(result.operation) !== key) {
          throw new Error('Operation-absent proof named a different operation.');
        }
        this.#attachments.delete(key);
        return this.#terminalize(record, {
          kind: 'terminal-failed',
          code: 'provider_lost',
          reason: 'The provider proxy proved that the committed operation is absent.',
        });
      }
      if (result.replayFromProviderSeq !== record.committedThroughProviderSeq + 1) {
        throw new Error('Attachment reply named a different replay boundary.');
      }

      const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
      const attachedRecord = current?.phase === 'executing' ? current : record;
      const finished = await this.#finishAttached(
        attachedRecord,
        authority,
        current?.phase === 'executing' ? undefined : current,
      );
      this.#attachments.delete(key);
      return finished;
    } catch (error: unknown) {
      const current = readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
      if (current?.phase !== 'executing') {
        const finished = await this.#finishAttached(record, authority, current);
        this.#attachments.delete(key);
        return finished;
      }
      await this.#recordRetry(current, error);
      return null;
    }
  }

  async #finishAttached(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    authority: DurableProviderProxyOperationAuthority,
    current?: ProviderOperationRecord | null,
  ): Promise<ProviderOperationRecord | null> {
    this.#registerExecuting(record, authority);
    if (record.controlIntent.kind === 'stop') {
      await authority.buildOperationControl(record.operation).stop(record.controlIntent.cause);
    }
    this.#complete(record.operation, { kind: 'remote-executing' });
    const latest = current ?? readProviderOperation(this.#deps.getProgressStore().getDb(), record.operation);
    if (latest?.phase === 'executing') return null;
    this.#deps.registry.settled(record.operation);
    return latest;
  }

  #registerExecuting(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    authority: DurableProviderProxyOperationAuthority,
  ): void {
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
    const result = compareAndSwapProviderOperation(this.#deps.getProgressStore().getDb(), expected, next);
    if (result.kind === 'updated') return result.record;
    return result.current;
  }

  #deleteSettledOperation(
    record: Extract<ProviderOperationRecord, { phase: 'settlement-pending' }>,
  ): ReturnType<typeof deleteProviderOperation> {
    return deleteProviderOperation(this.#deps.getProgressStore().getDb(), record);
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
      if (sameAuthority(record, authority)) await this.reconcile(record, authority);
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
