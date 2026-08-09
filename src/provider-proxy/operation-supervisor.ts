import type { HostRef, ProviderEventBody, ProviderStopCause } from '../providers/contract.js';
import { isInterruptionStopCause } from '../providers/contract.js';
import { providerProxyEmergencyEvent, type ProviderProxyReplayFailureReason } from '../providers/proxy-failure.js';
import type { ControlEndpointTimer } from './control-endpoint.js';
import {
  LedgerError,
  MAX_PROVIDER_REPLAY_BYTES,
  createOperationLedger,
  type OperationLedger,
  type PrepareResult,
  type ProviderOperationKey,
  type ProviderOperationState,
  type ProviderRootIdentity,
} from './ledger.js';
import { ReplayAdmissionError } from './replay-budget.js';
import {
  PROVIDER_EVENT_METHOD,
  ProxyControlProtocolError,
  encodedProxyControlFrameByteLength,
  encodeProxyControlFrame,
  providerEventRequestSchema,
  providerEventResultSchema,
  proxyOperationActivationOutcomeSchema,
  proxyOperationActivateResultSchema,
  proxyOperationAttachResultSchema,
  proxyOperationCancelResultSchema,
  proxyOperationInspectResultSchema,
  proxyOperationPrepareCapacityResultSchema,
  proxyOperationPreparePendingResultSchema,
  proxyOperationReleasedActivationIndeterminateSchema,
  proxyOperationSettleResultSchema,
  proxyOperationStopResultSchema,
  type JointActivationReceipt,
  type JointContainmentReceipt,
  type OperationIdentity,
  type ProviderOperationPreparePermanentRefusal,
  type ProviderEventResult,
  type ProxyOperationActivationOutcome,
  type ProxyOperationReleaseReceipt,
  type ProxyPreparedAppServerOperation,
  type Reservation,
} from './protocol.js';

export const OPERATION_RELEASE_RETRY_MS = 1_000;

export type ProviderEventEmissionResult = 'recorded' | 'proxy-emergency-terminal';

export type SemanticOperationStartResult =
  | Readonly<{ kind: 'started'; hostRef: HostRef }>
  | Readonly<{ kind: 'never-started'; reason: string }>
  | Readonly<{ kind: 'activation-indeterminate'; reason: string }>;

export interface SemanticOperationStartHandle {
  readonly result: Promise<SemanticOperationStartResult>;
  abortAndRelease(): Promise<void>;
}

export interface SemanticOperationHost {
  start(
    input: Readonly<{ key: ProviderOperationKey; prepared: ProxyPreparedAppServerOperation }>,
  ): SemanticOperationStartHandle;
  stop(input: Readonly<{ key: ProviderOperationKey; cause: ProviderStopCause }>): Promise<void> | void;
}

export type OperationStageResult =
  | Readonly<{
      state: 'staged';
      providerRoot: ProviderRootIdentity;
      receipt: JointContainmentReceipt;
    }>
  | ProviderOperationPreparePermanentRefusal;

export interface OperationStageHandle {
  readonly result: Promise<OperationStageResult>;
  confirmActivation(
    input: Readonly<{
      jointContainmentReceipt: JointContainmentReceipt;
      jointActivationReceipt: JointActivationReceipt;
    }>,
  ): Promise<void>;
  abortAndRelease(): Promise<void>;
}

type ReleaseKind = 'never-started' | 'activation-indeterminate' | 'after-terminal';

type ReleaseIntent = Readonly<{
  kind: ReleaseKind;
  finalProviderSeq?: number;
}>;

type SupervisedOperation = {
  readonly key: ProviderOperationKey;
  readonly operation: OperationIdentity;
  prepareAttemptNumber: number;
  prepareAttemptKey: string;
  fenced: boolean;
  tail: Promise<void>;
  stage: OperationStageHandle | null;
  prepareRefusal: ProviderOperationPreparePermanentRefusal | null;
  start: SemanticOperationStartHandle | null;
  releaseIntent: ReleaseIntent | null;
  releaseReceipt: ProxyOperationReleaseReceipt | null;
  releaseInFlight: Promise<ProxyOperationReleaseReceipt> | null;
  startAbort: Promise<void> | null;
  stageAbort: Promise<void> | null;
  deadlineTimer: { unref?: () => void } | null;
  releaseRetryTimer: { unref?: () => void } | null;
  pumping: boolean;
  pendingCompletion: 'terminal-awaiting-settlement' | 'suspended-awaiting-durable-decision' | null;
};

type OperationSupervisorOptions = Readonly<{
  host: SemanticOperationHost;
  timer: ControlEndpointTimer;
  mintReservation(): Reservation;
  wallClockNow(): number;
  nowMs(): number;
  proxyInstanceId: string;
  buildSetId: string;
  stageProviderRoot(
    key: ProviderOperationKey,
    reserved: Readonly<{ reservation: Reservation; prepared: ProxyPreparedAppServerOperation }>,
  ): OperationStageHandle;
  pushProviderEvent(frame: string): Promise<unknown>;
}>;

const LEDGER_WIRE_CODES = new Set(['operation_not_found', 'reservation_expired']);

function asProtocolError(error: unknown): never {
  if (error instanceof LedgerError) {
    const code = LEDGER_WIRE_CODES.has(error.code) ? (error.code as 'operation_not_found') : 'invalid_state';
    throw new ProxyControlProtocolError(code, error.message);
  }
  throw error;
}

function operationToken(key: ProviderOperationKey): string {
  return `${key.jobId}\u0000${key.operationId}`;
}

function sameOperation(left: OperationIdentity, right: OperationIdentity): boolean {
  return (
    left.jobId === right.jobId &&
    left.operationId === right.operationId &&
    left.proxyInstanceId === right.proxyInstanceId &&
    left.buildSetId === right.buildSetId
  );
}

function releaseIntentsMatch(left: ReleaseIntent, right: ReleaseIntent): boolean {
  return left.kind === right.kind && left.finalProviderSeq === right.finalProviderSeq;
}

function legacyState(state: ProviderOperationState): string {
  if (
    state === 'preparing' ||
    state === 'prepared' ||
    state === 'starting' ||
    state === 'started-awaiting-publication'
  ) {
    return 'pending-activation';
  }
  if (state === 'terminal-awaiting-settlement') return 'terminal-awaiting-journal-ack';
  return state;
}

export class OperationSupervisor {
  readonly #options: OperationSupervisorOptions;
  readonly #ledger: OperationLedger<ProxyPreparedAppServerOperation>;
  readonly #operations = new Map<string, SupervisedOperation>();
  #nextProviderEventFrameId = 1;

  constructor(options: OperationSupervisorOptions) {
    this.#options = options;
    this.#ledger = createOperationLedger<ProxyPreparedAppServerOperation>({
      encodeProxyEmergencyCompletion: ({ key, providerSeq, frameId, event }) => {
        const request = providerEventRequestSchema.parse({
          operation: {
            jobId: key.jobId,
            operationId: key.operationId,
            proxyInstanceId: options.proxyInstanceId,
            buildSetId: options.buildSetId,
          },
          providerSeq,
          event,
        });
        return {
          providerSeq,
          frame: encodeProxyControlFrame({
            jsonrpc: '2.0',
            id: frameId,
            method: PROVIDER_EVENT_METHOD,
            params: request,
          }),
        };
      },
    });
  }

  ledger(): OperationLedger<ProxyPreparedAppServerOperation> {
    return this.#ledger;
  }

  prepare(
    operation: OperationIdentity,
    input: Readonly<{
      prepareAttemptNumber: number;
      prepareAttemptKey: string;
      prepared: ProxyPreparedAppServerOperation;
    }>,
  ): Promise<unknown> {
    const record = this.#registerAttempt(operation, input.prepareAttemptNumber, input.prepareAttemptKey);
    return this.#enqueue(record, async () => {
      if (
        record.prepareRefusal !== null &&
        record.prepareAttemptNumber === input.prepareAttemptNumber &&
        record.prepareAttemptKey === input.prepareAttemptKey &&
        record.releaseReceipt?.state === 'released-never-started'
      ) {
        return record.prepareRefusal;
      }
      this.#assertAttemptOpen(record, input.prepareAttemptNumber, input.prepareAttemptKey);
      let reserved: PrepareResult<ProxyPreparedAppServerOperation>;
      try {
        reserved = this.#ledger.prepare({
          key: record.key,
          reservation: this.#options.mintReservation(),
          prepared: input.prepared,
          nowMs: this.#options.nowMs(),
          prepareAttemptNumber: input.prepareAttemptNumber,
          idempotencyKey: input.prepareAttemptKey,
        });
      } catch (error: unknown) {
        asProtocolError(error);
      }
      if (reserved.kind === 'capacity') {
        record.fenced = true;
        return proxyOperationPrepareCapacityResultSchema.parse({
          state: 'capacity',
          retryable: true,
          reason: reserved.reason,
        });
      }

      this.#armDeadline(record);
      if (reserved.entry.providerRoot !== null && reserved.entry.jointContainmentReceipt !== null) {
        return this.#preparedResult(reserved.entry);
      }

      if (record.stage === null) {
        try {
          record.stage = this.#options.stageProviderRoot(record.key, {
            reservation: reserved.entry.reservation,
            prepared: reserved.entry.prepared,
          });
        } catch (error: unknown) {
          this.#beginRelease(record, { kind: 'never-started' });
          await this.#driveRelease(record, false);
          throw error;
        }
      }

      try {
        const staged = await record.stage.result;
        if (staged.state === 'permanent-refusal') {
          record.prepareRefusal = staged;
          this.#beginRelease(record, { kind: 'never-started' });
          const released = await this.#driveRelease(record, true);
          if (released?.state !== 'released-never-started') {
            throw new ProxyControlProtocolError('invalid_state', 'Prepare refusal did not release its containment.');
          }
          return staged;
        }
        const current = this.#ledger.get(record.key);
        if (record.fenced || current?.state === 'releasing') {
          await this.#driveRelease(record, false);
          throw new ProxyControlProtocolError('reservation_expired', 'The activation lease expired.');
        }
        this.#ledger.recordPreparation(record.key, staged.providerRoot, staged.receipt);
        return this.#preparedResult(this.#requireLedger(record.key));
      } catch (error: unknown) {
        if (this.#ledger.get(record.key)?.state !== 'releasing') {
          this.#beginRelease(record, { kind: 'never-started' });
        }
        await this.#driveRelease(record, false);
        throw error;
      }
    });
  }

  renew(key: ProviderOperationKey, reservation: Reservation): Promise<unknown> {
    const record = this.#requireRecord(key);
    return this.#enqueue(record, () => {
      try {
        const entry = this.#ledger.renew(key, reservation, this.#options.nowMs());
        this.#armDeadline(record);
        return { state: 'pending-activation', leaseExpiresInMs: entry.leaseExpiresAtMs - this.#options.nowMs() };
      } catch (error: unknown) {
        asProtocolError(error);
      }
    });
  }

  activate(
    operation: OperationIdentity,
    input: Readonly<{
      reservation: Reservation;
      jointContainmentReceipt: JointContainmentReceipt;
      jointActivationReceipt: JointActivationReceipt;
      activationFingerprint: string;
    }>,
  ): Promise<ProxyOperationActivationOutcome> {
    const record = this.#requireRecord(operation);
    return this.#enqueue(record, async () => {
      let releaseOutcome = await this.#releasedActivationOutcome(record);
      if (releaseOutcome !== null) return releaseOutcome;

      let entry = this.#requireLedger(record.key);
      if (entry.activationFingerprint !== null && entry.activationFingerprint !== input.activationFingerprint) {
        throw new ProxyControlProtocolError('invalid_state', 'Activation does not match the stored attempt.');
      }
      if (entry.activationAck !== null && entry.state !== 'releasing') {
        return proxyOperationActivateResultSchema.parse(entry.activationAck);
      }
      this.#assertAttemptOpen(record, entry.prepareAttemptNumber, entry.prepareAttemptKey);
      if (entry.jointContainmentReceipt !== input.jointContainmentReceipt) {
        throw new ProxyControlProtocolError(
          'unauthorized_control',
          'Activation named a different containment receipt.',
        );
      }
      if (record.stage === null) {
        throw new ProxyControlProtocolError('invalid_state', 'Prepared operation has no owned stage handle.');
      }

      try {
        await record.stage.confirmActivation({
          jointContainmentReceipt: input.jointContainmentReceipt,
          jointActivationReceipt: input.jointActivationReceipt,
        });
      } catch {
        releaseOutcome = await this.#releasedActivationOutcome(record);
        if (releaseOutcome !== null) return releaseOutcome;
        this.#beginRelease(record, { kind: 'never-started' });
        const receipt = await this.#driveRelease(record, true);
        if (receipt === null)
          throw new ProxyControlProtocolError('invalid_state', 'Release did not produce a receipt.');
        return this.#activationReceipt(receipt);
      }

      releaseOutcome = await this.#releasedActivationOutcome(record);
      if (releaseOutcome !== null) return releaseOutcome;

      try {
        this.#ledger.beginActivation(record.key, input.reservation, this.#options.nowMs(), input.activationFingerprint);
      } catch (error: unknown) {
        if (error instanceof LedgerError && error.code === 'reservation_expired') {
          this.#beginRelease(record, { kind: 'never-started' });
          const receipt = await this.#driveRelease(record, true);
          if (receipt === null)
            throw new ProxyControlProtocolError('invalid_state', 'Release did not produce a receipt.');
          return this.#activationReceipt(receipt);
        }
        asProtocolError(error);
      }

      let startResult: SemanticOperationStartResult;
      try {
        record.start = this.#options.host.start({ key: record.key, prepared: entry.prepared });
        startResult = await record.start.result;
      } catch (error: unknown) {
        startResult = {
          kind: 'activation-indeterminate',
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      releaseOutcome = await this.#releasedActivationOutcome(record);
      if (releaseOutcome !== null) return releaseOutcome;
      if (startResult.kind !== 'started') {
        this.#beginRelease(record, {
          kind: startResult.kind === 'never-started' ? 'never-started' : 'activation-indeterminate',
        });
        const receipt = await this.#driveRelease(record, true);
        if (receipt === null)
          throw new ProxyControlProtocolError('invalid_state', 'Release did not produce a receipt.');
        return this.#activationReceipt(receipt);
      }

      entry = this.#requireLedger(record.key);
      const ack = proxyOperationActivateResultSchema.parse({
        state: 'executing',
        activationFingerprint: input.activationFingerprint,
        startedAt: new Date(this.#options.wallClockNow()).toISOString(),
        hostRef: startResult.hostRef,
        committedThroughProviderSeq: entry.committedThroughProviderSeq,
      });
      try {
        this.#ledger.recordStart(record.key, input.activationFingerprint, ack);
        this.#clearDeadline(record);
      } catch (error: unknown) {
        asProtocolError(error);
      }
      return proxyOperationActivationOutcomeSchema.parse(ack);
    });
  }

  async cancel(
    operation: OperationIdentity,
    prepareAttemptNumber: number,
    prepareAttemptKey: string,
  ): Promise<ProxyOperationReleaseReceipt> {
    const record = this.#fenceAttempt(operation, prepareAttemptNumber, prepareAttemptKey);
    if (record.releaseReceipt !== null) {
      if (record.releaseReceipt.state !== 'released-never-started') {
        throw new ProxyControlProtocolError('invalid_state', 'Activation has begun for this operation.');
      }
      return record.releaseReceipt;
    }

    const entry = this.#ledger.get(record.key);
    if (entry === null) return this.#recordNeverStartedReceipt(record);
    if (
      entry.state === 'started-awaiting-publication' ||
      entry.state === 'executing' ||
      entry.state === 'terminal-awaiting-settlement' ||
      entry.state === 'suspended-awaiting-durable-decision'
    ) {
      throw new ProxyControlProtocolError('invalid_state', 'Activation has begun for this operation.');
    }
    if (record.releaseIntent !== null && record.releaseIntent.kind !== 'never-started') {
      throw new ProxyControlProtocolError('invalid_state', 'Activation has begun for this operation.');
    }
    if (record.releaseIntent === null) this.#beginRelease(record, { kind: 'never-started' });
    const receipt = await this.#driveRelease(record, true);
    if (receipt?.state !== 'released-never-started') {
      throw new ProxyControlProtocolError('invalid_state', 'Activation has begun for this operation.');
    }
    return receipt;
  }

  stop(operation: OperationIdentity, cause: ProviderStopCause): Promise<unknown> {
    const record = this.#requireRecord(operation);
    const before = this.#ledger.get(record.key);
    if (
      before !== null &&
      (before.state === 'preparing' || before.state === 'prepared' || before.state === 'starting')
    ) {
      record.fenced = true;
      if (record.releaseIntent === null) this.#beginRelease(record, { kind: 'never-started' });
    }
    return this.#enqueue(record, async () => {
      if (record.releaseReceipt !== null) {
        return proxyOperationStopResultSchema.parse({
          state: 'released',
          committedThroughProviderSeq:
            record.releaseReceipt.state === 'released-after-terminal'
              ? record.releaseReceipt.settledThroughProviderSeq
              : 0,
        });
      }
      if (record.releaseIntent !== null) {
        await this.#driveRelease(record, true);
        return proxyOperationStopResultSchema.parse({ state: 'released', committedThroughProviderSeq: 0 });
      }
      const entry = this.#requireLedger(record.key);
      const next = isInterruptionStopCause(cause)
        ? 'suspended-awaiting-durable-decision'
        : 'terminal-awaiting-settlement';
      if (entry.state === 'executing') {
        await this.#options.host.stop({ key: record.key, cause });
        if (this.#ledger.get(record.key)?.state === 'executing') this.#ledger.transition(record.key, next);
      }
      const after = this.#ledger.get(record.key);
      return proxyOperationStopResultSchema.parse({
        state: after === null ? 'released' : legacyState(after.state),
        committedThroughProviderSeq: after?.committedThroughProviderSeq ?? 0,
      });
    });
  }

  settle(operation: OperationIdentity, finalProviderSeq: number): Promise<unknown> {
    const record = this.#requireRecord(operation);
    return this.#enqueue(record, async () => {
      if (record.releaseReceipt !== null) {
        if (
          record.releaseReceipt.state !== 'released-after-terminal' ||
          finalProviderSeq > record.releaseReceipt.settledThroughProviderSeq
        ) {
          throw new ProxyControlProtocolError('invalid_state', 'Settlement exceeds the released watermark.');
        }
        return proxyOperationSettleResultSchema.parse(record.releaseReceipt);
      }
      if (record.releaseIntent !== null) {
        if (record.releaseIntent.kind !== 'after-terminal') {
          throw new ProxyControlProtocolError('invalid_state', 'Operation is releasing without settlement.');
        }
        const receipt = await this.#driveRelease(record, true);
        if (receipt === null)
          throw new ProxyControlProtocolError('invalid_state', 'Release did not produce a receipt.');
        return receipt;
      }

      const entry = this.#requireLedger(record.key);
      if (entry.state !== 'terminal-awaiting-settlement' && entry.state !== 'suspended-awaiting-durable-decision') {
        throw new ProxyControlProtocolError('invalid_state', 'Operation is not ready for settlement.');
      }
      const lastProviderSeq = this.#ledger.nextProviderSeq(record.key) - 1;
      if (finalProviderSeq !== lastProviderSeq) {
        throw new ProxyControlProtocolError('invalid_request', 'Settlement named a different final sequence.');
      }
      try {
        this.#ledger.acknowledge(record.key, finalProviderSeq);
      } catch (error: unknown) {
        asProtocolError(error);
      }
      this.#beginRelease(record, { kind: 'after-terminal', finalProviderSeq });
      const receipt = await this.#driveRelease(record, true);
      if (receipt === null) throw new ProxyControlProtocolError('invalid_state', 'Release did not produce a receipt.');
      return receipt;
    });
  }

  async inspect(operation: OperationIdentity, prepareAttemptKey: string): Promise<unknown> {
    const record = this.#operations.get(operationToken(operation));
    if (record === undefined) return proxyOperationInspectResultSchema.parse({ state: 'absent' });
    if (!sameOperation(record.operation, operation)) {
      throw new ProxyControlProtocolError('identity_mismatch', 'Inspect named another operation identity.');
    }
    if (record.prepareAttemptKey !== prepareAttemptKey) {
      throw new ProxyControlProtocolError('invalid_state', 'Inspect does not match the prepared operation.');
    }
    if (record.prepareRefusal !== null && record.releaseReceipt?.state === 'released-never-started') {
      return proxyOperationInspectResultSchema.parse(record.prepareRefusal);
    }
    if (record.releaseReceipt !== null) return proxyOperationInspectResultSchema.parse(record.releaseReceipt);
    if (record.releaseIntent !== null) {
      const receipt = await this.#driveRelease(record, false);
      if (receipt !== null) {
        if (record.prepareRefusal !== null && receipt.state === 'released-never-started') {
          return proxyOperationInspectResultSchema.parse(record.prepareRefusal);
        }
        return proxyOperationInspectResultSchema.parse(receipt);
      }
    }

    const entry = this.#ledger.get(record.key);
    if (entry === null) return proxyOperationInspectResultSchema.parse({ state: 'absent' });
    if (entry.state === 'preparing') {
      return proxyOperationInspectResultSchema.parse({
        state: 'preparing',
        reservation: entry.reservation,
        leaseExpiresInMs: entry.leaseExpiresAtMs - this.#options.nowMs(),
      });
    }
    if (entry.state === 'prepared') {
      if (entry.providerRoot === null || entry.jointContainmentReceipt === null) {
        throw new ProxyControlProtocolError('invalid_state', 'Prepared operation lacks containment evidence.');
      }
      return proxyOperationInspectResultSchema.parse({
        state: 'prepared',
        reservation: entry.reservation,
        leaseExpiresInMs: entry.leaseExpiresAtMs - this.#options.nowMs(),
        providerRoot: entry.providerRoot,
        jointContainmentReceipt: entry.jointContainmentReceipt,
      });
    }
    if (entry.state === 'starting') {
      if (
        entry.providerRoot === null ||
        entry.jointContainmentReceipt === null ||
        entry.activationFingerprint === null
      ) {
        throw new ProxyControlProtocolError('invalid_state', 'Starting operation lacks activation evidence.');
      }
      return proxyOperationInspectResultSchema.parse({
        state: 'starting',
        reservation: entry.reservation,
        providerRoot: entry.providerRoot,
        jointContainmentReceipt: entry.jointContainmentReceipt,
        activationFingerprint: entry.activationFingerprint,
      });
    }
    if (entry.state === 'started-awaiting-publication') {
      if (entry.activationAck === null) {
        throw new ProxyControlProtocolError('invalid_state', 'Started operation lacks its activation acknowledgement.');
      }
      return proxyOperationInspectResultSchema.parse({ ...entry.activationAck, state: 'started-awaiting-publication' });
    }
    if (entry.state === 'releasing') {
      if (record.releaseIntent === null) {
        throw new ProxyControlProtocolError('invalid_state', 'Releasing operation lacks its retained intent.');
      }
      return proxyOperationInspectResultSchema.parse({
        state: 'releasing',
        releaseKind: record.releaseIntent.kind,
        prepareAttemptNumber: record.prepareAttemptNumber,
        prepareAttemptKey: record.prepareAttemptKey,
        reservation: entry.reservation,
        providerRoot: entry.providerRoot,
        jointContainmentReceipt: entry.jointContainmentReceipt,
        activationFingerprint: entry.activationFingerprint,
        activationAck: entry.activationAck,
        committedThroughProviderSeq: entry.committedThroughProviderSeq,
      });
    }
    if (entry.activationFingerprint === null || entry.activationAck === null) {
      throw new ProxyControlProtocolError('invalid_state', 'Operation lacks its activation acknowledgement.');
    }
    if (entry.state === 'executing') return proxyOperationInspectResultSchema.parse(entry.activationAck);
    return proxyOperationInspectResultSchema.parse({
      state: 'terminal-awaiting-settlement',
      activationFingerprint: entry.activationFingerprint,
      activationAck: entry.activationAck,
      committedThroughProviderSeq: entry.committedThroughProviderSeq,
    });
  }

  attach(
    operation: OperationIdentity,
    committedThroughProviderSeq: number,
  ): Promise<ReturnType<typeof proxyOperationAttachResultSchema.parse>> {
    const record = this.#operations.get(operationToken(operation));
    if (record === undefined) {
      return Promise.resolve(proxyOperationAttachResultSchema.parse({ state: 'operation-absent', operation }));
    }
    if (!sameOperation(record.operation, operation)) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named operation is not held by this proxy.');
    }
    return this.#enqueue(record, () => {
      const entry = this.#ledger.get(record.key);
      if (entry === null) {
        if (
          record.stage !== null ||
          record.start !== null ||
          record.releaseIntent !== null ||
          record.releaseInFlight !== null ||
          record.startAbort !== null ||
          record.stageAbort !== null ||
          record.deadlineTimer !== null ||
          record.releaseRetryTimer !== null ||
          record.pendingCompletion !== null ||
          record.pumping
        ) {
          throw new ProxyControlProtocolError('invalid_state', 'Operation ownership is still being resolved.');
        }
        return proxyOperationAttachResultSchema.parse({ state: 'operation-absent', operation });
      }
      if (
        entry.state !== 'started-awaiting-publication' &&
        entry.state !== 'executing' &&
        entry.state !== 'terminal-awaiting-settlement' &&
        entry.state !== 'suspended-awaiting-durable-decision'
      ) {
        throw new ProxyControlProtocolError('invalid_state', `Cannot attach an operation from ${entry.state}.`);
      }
      if (committedThroughProviderSeq >= this.#ledger.nextProviderSeq(record.key)) {
        throw new ProxyControlProtocolError(
          'invalid_state',
          'Attachment watermark exceeds the produced event sequence.',
        );
      }
      try {
        this.#ledger.acknowledge(record.key, committedThroughProviderSeq);
        if (entry.state === 'started-awaiting-publication') {
          if (entry.activationFingerprint === null) {
            throw new ProxyControlProtocolError('invalid_state', 'Started operation lacks activation evidence.');
          }
          this.#ledger.publishActivation(record.key, entry.activationFingerprint);
          if (record.pendingCompletion !== null) {
            this.#ledger.transition(record.key, record.pendingCompletion);
            record.pendingCompletion = null;
          }
        }
      } catch (error: unknown) {
        asProtocolError(error);
      }
      void this.#pump(record);
      return proxyOperationAttachResultSchema.parse({
        state: 'attached',
        replayFromProviderSeq: committedThroughProviderSeq + 1,
      });
    });
  }

  reattachControl(): void {
    for (const key of this.#ledger.keys()) {
      const record = this.#operations.get(operationToken(key));
      if (record !== undefined) void this.#pump(record);
    }
  }

  emitProviderEvent(key: ProviderOperationKey, event: ProviderEventBody): ProviderEventEmissionResult {
    const record = this.#requireRecord(key);
    const providerSeq = this.#ledger.nextProviderSeq(key);
    const request = providerEventRequestSchema.parse({
      operation: {
        jobId: key.jobId,
        operationId: key.operationId,
        proxyInstanceId: this.#options.proxyInstanceId,
        buildSetId: this.#options.buildSetId,
      },
      providerSeq,
      event,
    });
    const message = {
      jsonrpc: '2.0',
      id: this.#nextProviderEventFrameId,
      method: PROVIDER_EVENT_METHOD,
      params: request,
    } as const;
    if (encodedProxyControlFrameByteLength(message) > MAX_PROVIDER_REPLAY_BYTES) {
      return this.#recordProxyEmergencyCompletion(
        record,
        event.kind === 'terminal' || event.kind === 'suspended'
          ? 'provider_completion_too_large'
          : 'provider_replay_operation_bytes_exhausted',
      );
    }

    const frame = encodeProxyControlFrame(message);
    try {
      this.#ledger.recordEvent(
        key,
        { providerSeq, frame },
        event.kind === 'terminal' || event.kind === 'suspended' ? { kind: 'completion' } : { kind: 'ordinary' },
      );
    } catch (error: unknown) {
      if (!(error instanceof ReplayAdmissionError)) throw error;
      return this.#recordProxyEmergencyCompletion(record, this.#replayFailureReason(event, error));
    }
    this.#nextProviderEventFrameId += 1;
    this.#recordCompletion(record, event);
    void this.#pump(record);
    return 'recorded';
  }

  close(): void {
    for (const record of this.#operations.values()) {
      this.#clearDeadline(record);
      if (record.releaseRetryTimer !== null) this.#options.timer.clearTimeout(record.releaseRetryTimer);
      record.releaseRetryTimer = null;
    }
  }

  #registerAttempt(
    operation: OperationIdentity,
    prepareAttemptNumber: number,
    prepareAttemptKey: string,
  ): SupervisedOperation {
    const token = operationToken(operation);
    const current = this.#operations.get(token);
    if (current === undefined) {
      const created = this.#newRecord(operation, prepareAttemptNumber, prepareAttemptKey);
      this.#operations.set(token, created);
      return created;
    }
    if (!sameOperation(current.operation, operation)) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named operation is not held by this proxy.');
    }
    if (prepareAttemptNumber < current.prepareAttemptNumber) {
      throw new ProxyControlProtocolError('invalid_state', 'A delayed lower prepare attempt was refused.');
    }
    if (prepareAttemptNumber === current.prepareAttemptNumber) {
      if (prepareAttemptKey !== current.prepareAttemptKey) {
        throw new ProxyControlProtocolError('invalid_request', 'A prepare attempt number named different bytes.');
      }
      return current;
    }
    if (!current.fenced) {
      throw new ProxyControlProtocolError('invalid_state', 'The previous prepare attempt is not fenced.');
    }
    if (current.releaseReceipt !== null && current.releaseReceipt.state !== 'released-never-started') {
      throw new ProxyControlProtocolError('invalid_state', 'The previous prepare attempt cannot be replaced.');
    }
    if (this.#ledger.get(current.key) !== null || current.releaseIntent !== null) {
      throw new ProxyControlProtocolError('invalid_state', 'The previous prepare attempt is not released.');
    }
    current.prepareAttemptNumber = prepareAttemptNumber;
    current.prepareAttemptKey = prepareAttemptKey;
    current.fenced = false;
    current.stage = null;
    current.start = null;
    current.prepareRefusal = null;
    current.releaseReceipt = null;
    current.pendingCompletion = null;
    return current;
  }

  #fenceAttempt(
    operation: OperationIdentity,
    prepareAttemptNumber: number,
    prepareAttemptKey: string,
  ): SupervisedOperation {
    const record = this.#registerAttempt(operation, prepareAttemptNumber, prepareAttemptKey);
    if (record.prepareAttemptNumber !== prepareAttemptNumber || record.prepareAttemptKey !== prepareAttemptKey) {
      throw new ProxyControlProtocolError('invalid_state', 'Cancel does not name the active prepare attempt.');
    }
    record.fenced = true;
    return record;
  }

  #assertAttemptOpen(record: SupervisedOperation, prepareAttemptNumber: number, prepareAttemptKey: string): void {
    if (
      record.prepareAttemptNumber !== prepareAttemptNumber ||
      record.prepareAttemptKey !== prepareAttemptKey ||
      record.fenced
    ) {
      throw new ProxyControlProtocolError('invalid_state', 'This prepare attempt is fenced.');
    }
  }

  #newRecord(
    operation: OperationIdentity,
    prepareAttemptNumber: number,
    prepareAttemptKey: string,
  ): SupervisedOperation {
    return {
      key: { jobId: operation.jobId, operationId: operation.operationId },
      operation,
      prepareAttemptNumber,
      prepareAttemptKey,
      fenced: false,
      tail: Promise.resolve(),
      stage: null,
      prepareRefusal: null,
      start: null,
      releaseIntent: null,
      releaseReceipt: null,
      releaseInFlight: null,
      startAbort: null,
      stageAbort: null,
      deadlineTimer: null,
      releaseRetryTimer: null,
      pumping: false,
      pendingCompletion: null,
    };
  }

  #enqueue<T>(record: SupervisedOperation, action: () => Promise<T> | T): Promise<T> {
    const result = record.tail.then(action, action);
    record.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  #armDeadline(record: SupervisedOperation): void {
    this.#clearDeadline(record);
    const entry = this.#ledger.get(record.key);
    if (entry === null || (entry.state !== 'preparing' && entry.state !== 'prepared' && entry.state !== 'starting')) {
      return;
    }
    const leaseExpiresAtMs = entry.leaseExpiresAtMs;
    const handle = this.#options.timer.setTimeout(
      () => {
        if (record.deadlineTimer !== handle) return;
        record.deadlineTimer = null;
        const current = this.#ledger.get(record.key);
        if (
          current === null ||
          current.leaseExpiresAtMs !== leaseExpiresAtMs ||
          (current.state !== 'preparing' && current.state !== 'prepared' && current.state !== 'starting')
        ) {
          return;
        }
        record.fenced = true;
        this.#beginRelease(record, { kind: 'never-started' });
        void this.#driveRelease(record, false);
      },
      Math.max(0, leaseExpiresAtMs - this.#options.nowMs()),
    );
    handle.unref?.();
    record.deadlineTimer = handle;
  }

  #clearDeadline(record: SupervisedOperation): void {
    if (record.deadlineTimer === null) return;
    this.#options.timer.clearTimeout(record.deadlineTimer);
    record.deadlineTimer = null;
  }

  #beginRelease(record: SupervisedOperation, intent: ReleaseIntent): void {
    if (record.releaseIntent !== null && !releaseIntentsMatch(record.releaseIntent, intent)) {
      throw new ProxyControlProtocolError('invalid_state', 'This operation is already releasing for another reason.');
    }
    record.releaseIntent ??= intent;
    record.fenced = true;
    this.#clearDeadline(record);
    try {
      this.#ledger.beginRelease(record.key);
    } catch (error: unknown) {
      asProtocolError(error);
    }
    this.#abortOwnedHandles(record);
  }

  #abortOwnedHandles(record: SupervisedOperation): void {
    record.startAbort ??= this.#startAbort(record.start);
    record.stageAbort ??= this.#startAbort(record.stage);
  }

  #startAbort(handle: Readonly<{ abortAndRelease(): Promise<void> }> | null): Promise<void> | null {
    if (handle === null) return null;
    try {
      return handle.abortAndRelease();
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #driveRelease(
    record: SupervisedOperation,
    surfaceFailure: boolean,
  ): Promise<ProxyOperationReleaseReceipt | null> {
    if (record.releaseReceipt !== null) return record.releaseReceipt;
    if (record.releaseIntent === null) return null;
    this.#abortOwnedHandles(record);
    record.releaseInFlight ??= this.#finishRelease(record).finally(() => {
      record.releaseInFlight = null;
    });
    if (!surfaceFailure) {
      void this.#observeRelease(record, record.releaseInFlight);
      return record.releaseReceipt;
    }
    try {
      return await record.releaseInFlight;
    } catch (error: unknown) {
      this.#scheduleReleaseRetry(record);
      if (surfaceFailure) throw error;
      return null;
    }
  }

  async #observeRelease(record: SupervisedOperation, release: Promise<ProxyOperationReleaseReceipt>): Promise<void> {
    try {
      await release;
    } catch {
      this.#scheduleReleaseRetry(record);
    }
  }

  async #finishRelease(record: SupervisedOperation): Promise<ProxyOperationReleaseReceipt> {
    try {
      await record.startAbort;
    } catch (error: unknown) {
      record.startAbort = null;
      throw error;
    }
    try {
      await record.stageAbort;
    } catch (error: unknown) {
      record.stageAbort = null;
      throw error;
    }
    const intent = record.releaseIntent;
    if (intent === null) throw new ProxyControlProtocolError('invalid_state', 'Release lost its retained intent.');
    try {
      this.#ledger.transition(record.key, 'released');
    } catch (error: unknown) {
      asProtocolError(error);
    }
    const receipt = this.#buildReleaseReceipt(record, intent);
    record.releaseReceipt = receipt;
    record.releaseIntent = null;
    record.stage = null;
    record.start = null;
    record.stageAbort = null;
    record.startAbort = null;
    if (record.releaseRetryTimer !== null) this.#options.timer.clearTimeout(record.releaseRetryTimer);
    record.releaseRetryTimer = null;
    return receipt;
  }

  #scheduleReleaseRetry(record: SupervisedOperation): void {
    if (record.releaseRetryTimer !== null || record.releaseReceipt !== null) return;
    const handle = this.#options.timer.setTimeout(() => {
      if (record.releaseRetryTimer !== handle) return;
      record.releaseRetryTimer = null;
      void this.#driveRelease(record, false);
    }, OPERATION_RELEASE_RETRY_MS);
    handle.unref?.();
    record.releaseRetryTimer = handle;
  }

  #buildReleaseReceipt(record: SupervisedOperation, intent: ReleaseIntent): ProxyOperationReleaseReceipt {
    if (intent.kind === 'never-started') return this.#recordNeverStartedReceipt(record);
    if (intent.kind === 'activation-indeterminate') {
      return proxyOperationReleasedActivationIndeterminateSchema.parse({
        state: 'released-activation-indeterminate',
        operation: record.operation,
        prepareAttemptNumber: record.prepareAttemptNumber,
        prepareAttemptKey: record.prepareAttemptKey,
      });
    }
    return proxyOperationSettleResultSchema.parse({
      state: 'released-after-terminal',
      settledThroughProviderSeq: intent.finalProviderSeq ?? 0,
    });
  }

  #recordNeverStartedReceipt(record: SupervisedOperation): ProxyOperationReleaseReceipt {
    const receipt = proxyOperationCancelResultSchema.parse({
      state: 'released-never-started',
      operation: record.operation,
      prepareAttemptNumber: record.prepareAttemptNumber,
      prepareAttemptKey: record.prepareAttemptKey,
    });
    record.releaseReceipt = receipt;
    record.releaseIntent = null;
    return receipt;
  }

  #activationReceipt(receipt: ProxyOperationReleaseReceipt): ProxyOperationActivationOutcome {
    if (receipt.state === 'released-after-terminal') {
      throw new ProxyControlProtocolError('invalid_state', 'This operation was released after terminal settlement.');
    }
    return proxyOperationActivationOutcomeSchema.parse(receipt);
  }

  async #releasedActivationOutcome(record: SupervisedOperation): Promise<ProxyOperationActivationOutcome | null> {
    if (record.releaseReceipt !== null) return this.#activationReceipt(record.releaseReceipt);
    if (record.releaseIntent === null) return null;
    const receipt = await this.#driveRelease(record, true);
    if (receipt === null) throw new ProxyControlProtocolError('invalid_state', 'Release did not produce a receipt.');
    return this.#activationReceipt(receipt);
  }

  #preparedResult(
    entry: Readonly<{
      reservation: Reservation;
      leaseExpiresAtMs: number;
      providerRoot: ProviderRootIdentity | null;
      jointContainmentReceipt: JointContainmentReceipt | null;
    }>,
  ): unknown {
    if (entry.providerRoot === null || entry.jointContainmentReceipt === null) {
      throw new ProxyControlProtocolError('invalid_state', 'Prepared operation lacks containment evidence.');
    }
    return proxyOperationPreparePendingResultSchema.parse({
      state: 'pending-activation',
      reservation: entry.reservation,
      leaseExpiresInMs: entry.leaseExpiresAtMs - this.#options.nowMs(),
      providerRoot: entry.providerRoot,
      jointContainmentReceipt: entry.jointContainmentReceipt,
    });
  }

  #replayFailureReason(event: ProviderEventBody, error: ReplayAdmissionError): ProviderProxyReplayFailureReason {
    if (event.kind === 'terminal' || event.kind === 'suspended') return 'provider_completion_too_large';
    switch (error.scope) {
      case 'operation-events':
        return 'provider_replay_operation_events_exhausted';
      case 'operation-bytes':
        return 'provider_replay_operation_bytes_exhausted';
      case 'proxy-shared-bytes':
        return 'provider_replay_proxy_bytes_exhausted';
      case 'completion-frame-bytes':
        return 'provider_completion_too_large';
    }
  }

  #recordProxyEmergencyCompletion(
    record: SupervisedOperation,
    reason: ProviderProxyReplayFailureReason,
  ): ProviderEventEmissionResult {
    const event = providerProxyEmergencyEvent({ reason });
    this.#ledger.recordProxyEmergencyCompletion(record.key, event, this.#nextProviderEventFrameId);
    this.#nextProviderEventFrameId += 1;
    this.#recordCompletion(record, event);
    void this.#pump(record);
    return 'proxy-emergency-terminal';
  }

  #recordCompletion(record: SupervisedOperation, event: ProviderEventBody): void {
    const next =
      event.kind === 'terminal'
        ? 'terminal-awaiting-settlement'
        : event.kind === 'suspended'
          ? 'suspended-awaiting-durable-decision'
          : null;
    if (next === null) return;
    const state = this.#ledger.get(record.key)?.state;
    if (state === 'executing') this.#ledger.transition(record.key, next);
    else if (state === 'starting' || state === 'started-awaiting-publication') record.pendingCompletion = next;
  }

  async #pump(record: SupervisedOperation): Promise<void> {
    if (record.pumping) return;
    record.pumping = true;
    try {
      while (true) {
        const entry = this.#ledger.get(record.key);
        if (
          entry?.state === 'preparing' ||
          entry?.state === 'prepared' ||
          entry?.state === 'starting' ||
          entry?.state === 'started-awaiting-publication'
        ) {
          return;
        }
        const next = entry?.bufferedEvents[0];
        if (next === undefined) return;
        let response: unknown;
        try {
          response = await this.#options.pushProviderEvent(next.frame);
        } catch {
          return;
        }
        let result: ProviderEventResult;
        try {
          result = providerEventResultSchema.parse(response);
        } catch {
          return;
        }
        if (result.kind === 'ack') {
          try {
            this.#ledger.acknowledge(record.key, result.committedThroughProviderSeq);
          } catch {
            return;
          }
        }
      }
    } finally {
      record.pumping = false;
    }
  }

  #requireRecord(key: ProviderOperationKey): SupervisedOperation;
  #requireRecord(operation: OperationIdentity): SupervisedOperation;
  #requireRecord(input: ProviderOperationKey | OperationIdentity): SupervisedOperation {
    const record = this.#operations.get(operationToken(input));
    if (record === undefined) throw new ProxyControlProtocolError('operation_not_found', 'No such operation.');
    if ('proxyInstanceId' in input && !sameOperation(record.operation, input)) {
      throw new ProxyControlProtocolError('identity_mismatch', 'The named operation is not held by this proxy.');
    }
    return record;
  }

  #requireLedger(key: ProviderOperationKey) {
    const entry = this.#ledger.get(key);
    if (entry === null) throw new ProxyControlProtocolError('operation_not_found', 'No such prepared operation.');
    return entry;
  }
}
