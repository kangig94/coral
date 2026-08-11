import type {
  HostRef,
  ProviderContinuityEventBody,
  ProviderEventBody,
  ProviderStopCause,
} from '../providers/contract.js';
import { isInterruptionStopCause } from '../providers/contract.js';
import { commitContinuityEvent, rejectContinuityEvent } from '../providers/internal/continuity-commit.js';
import { providerProxyEmergencyEvent, type ProviderProxyReplayFailureReason } from '../providers/proxy-failure.js';
import {
  ControlEndpointError,
  type ControlEndpointTimer,
  type ControlEpoch,
  type ControlTenancyPush,
} from './control-endpoint.js';
import {
  LedgerError,
  MAX_PROVIDER_REPLAY_BYTES,
  createOperationLedger,
  type OperationLedger,
  type PrepareResult,
  type ProviderOperationKey,
  type ProviderOperationState,
  type ProviderRootIdentity,
  type ReplayEvent,
} from './ledger.js';
import { ReplayAdmissionError } from './replay-budget.js';
import {
  PROVIDER_EVENT_METHOD,
  PROXY_EVENT_COMMIT_TIMEOUT_MS,
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
  type ProxyOperationPrepareCapacityResult,
  type ProxyOperationReleaseReceipt,
  type ProxyPreparedAppServerOperation,
  type Reservation,
} from './protocol.js';

export const OPERATION_RELEASE_RETRY_MS = 1_000;

export type ContinuityCommitDeliveryErrorCode =
  | 'continuity_commit_replaced_by_proxy_terminal'
  | 'continuity_commit_operation_released'
  | 'continuity_commit_operation_cancelled'
  | 'continuity_commit_attempt_superseded'
  | 'continuity_commit_proxy_shutdown';

export class ContinuityCommitDeliveryError extends Error {
  readonly code: ContinuityCommitDeliveryErrorCode;

  constructor(code: ContinuityCommitDeliveryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContinuityCommitDeliveryError';
    this.code = code;
    Object.setPrototypeOf(this, ContinuityCommitDeliveryError.prototype);
  }
}

export type ContinuityCommitSettlement = Readonly<{
  providerSeq: number;
  committed: Promise<void>;
  reject(error: ContinuityCommitDeliveryError): void;
}>;

export type ProviderEventEmissionResult =
  | Readonly<{ kind: 'recorded'; providerSeq: number }>
  | Readonly<{
      kind: 'continuity-recorded';
      providerSeq: number;
      settlement: ContinuityCommitSettlement;
    }>
  | Readonly<{ kind: 'proxy-emergency-terminal' }>;

export type ProviderEventControlFaultReason =
  | 'provider_event_ack_timeout'
  | 'provider_event_response_refused'
  | 'provider_event_response_invalid'
  | 'provider_event_ack_invalid';

export type ProviderEventControlFault = Readonly<{
  reason: ProviderEventControlFaultReason;
  operation: OperationIdentity;
  providerSeq: number;
  expectedControlEpoch: ControlEpoch;
}>;

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
  | ProviderOperationPreparePermanentRefusal
  | ProxyOperationPrepareCapacityResult;

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

type OperationOwnershipEpoch = Readonly<{
  prepareAttemptNumber: number;
  prepareAttemptKey: string;
  ordinal: number;
}>;

type PendingContinuityCommit = {
  readonly ownership: OperationOwnershipEpoch;
  readonly providerSeq: number;
  readonly event: ProviderContinuityEventBody;
  state: 'pending' | 'committed' | 'rejected';
  readonly settlement: ContinuityCommitSettlement;
  resolveCommitted(): void;
  rejectCommitted(error: ContinuityCommitDeliveryError): void;
};

type ProviderEventAmbiguityDeadline = {
  readonly controlEpoch: ControlEpoch;
  readonly providerSeq: number;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  timer: { unref?: () => void } | null;
  fault: ProviderEventControlFaultReason | null;
};

type BegunProviderEventPush = Readonly<{
  next: ReplayEvent;
  ownership: OperationOwnershipEpoch;
  push: ControlTenancyPush;
  deadline: ProviderEventAmbiguityDeadline;
}>;

type ProviderEventPushResponse =
  | Readonly<{ kind: 'received'; response: unknown }>
  | Readonly<{ kind: 'retry' }>
  | Readonly<{ kind: 'stop' }>;

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
  ownershipOrdinal: number;
  continuityCommits: Map<number, PendingContinuityCommit>;
  providerEventAmbiguity: ProviderEventAmbiguityDeadline | null;
  pumpDemand: boolean;
  pumpTurn: { unref?: () => void } | null;
  pumpRunning: boolean;
  closed: boolean;
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
  pushProviderEvent(frame: string): ControlTenancyPush;
  faultProviderEventControl(fault: ProviderEventControlFault): void;
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
          code: 'operation_ledger_capacity',
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
        if (staged.state === 'capacity') {
          record.fenced = true;
          this.#beginRelease(record, { kind: 'never-started' });
          const released = await this.#driveRelease(record, true);
          if (released?.state !== 'released-never-started') {
            throw new ProxyControlProtocolError('invalid_state', 'Root-capacity refusal did not release its stage.');
          }
          return proxyOperationPrepareCapacityResultSchema.parse(staged);
        }
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
          record.pumpRunning ||
          record.pumpTurn !== null
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
        const ownership = this.#ownership(record);
        const ambiguity = record.providerEventAmbiguity;
        if (ambiguity !== null && ambiguity.fault === null && ambiguity.providerSeq <= committedThroughProviderSeq) {
          this.#clearProviderEventAmbiguity(record, ambiguity);
        }
        this.#commitCoveredContinuity(record, ownership, committedThroughProviderSeq);
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
      this.#requestPump(record);
      return proxyOperationAttachResultSchema.parse({
        state: 'attached',
        replayFromProviderSeq: committedThroughProviderSeq + 1,
      });
    });
  }

  controlActivated(controlEpoch: ControlEpoch): void {
    for (const key of this.#ledger.keys()) {
      const record = this.#operations.get(operationToken(key));
      if (record === undefined) continue;
      const deadline = record.providerEventAmbiguity;
      if (deadline?.controlEpoch === controlEpoch && deadline.fault !== null) {
        this.#options.faultProviderEventControl({
          reason: deadline.fault,
          operation: record.operation,
          providerSeq: deadline.providerSeq,
          expectedControlEpoch: controlEpoch,
        });
        continue;
      }
      if (deadline !== null && deadline.controlEpoch !== controlEpoch) {
        this.#clearProviderEventAmbiguity(record, deadline);
      }
      this.#requestPump(record);
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
      const emission = this.#recordProxyEmergencyCompletion(
        record,
        event.kind === 'terminal' || event.kind === 'suspended'
          ? 'provider_completion_too_large'
          : 'provider_replay_operation_bytes_exhausted',
      );
      if (event.kind === 'continuity') {
        rejectContinuityEvent(
          event,
          new ContinuityCommitDeliveryError(
            'continuity_commit_replaced_by_proxy_terminal',
            'The continuity checkpoint was replaced by a proxy emergency terminal.',
          ),
        );
      }
      return emission;
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
      const emission = this.#recordProxyEmergencyCompletion(record, this.#replayFailureReason(event, error));
      if (event.kind === 'continuity') {
        rejectContinuityEvent(
          event,
          new ContinuityCommitDeliveryError(
            'continuity_commit_replaced_by_proxy_terminal',
            'The continuity checkpoint was replaced by a proxy emergency terminal.',
            { cause: error },
          ),
        );
      }
      return emission;
    }
    this.#nextProviderEventFrameId += 1;
    this.#recordCompletion(record, event);
    if (event.kind === 'continuity') {
      const pending = this.#createPendingContinuityCommit(record, providerSeq, event);
      record.continuityCommits.set(providerSeq, pending);
      this.#requestPump(record);
      return { kind: 'continuity-recorded', providerSeq, settlement: pending.settlement };
    }
    this.#requestPump(record);
    return { kind: 'recorded', providerSeq };
  }

  close(): void {
    for (const record of this.#operations.values()) {
      if (record.closed) continue;
      record.closed = true;
      record.ownershipOrdinal += 1;
      this.#clearDeadline(record);
      const ambiguity = record.providerEventAmbiguity;
      if (ambiguity !== null) this.#clearProviderEventAmbiguity(record, ambiguity);
      if (record.releaseRetryTimer !== null) this.#options.timer.clearTimeout(record.releaseRetryTimer);
      record.releaseRetryTimer = null;
      record.pumpDemand = false;
      if (record.pumpTurn !== null) this.#options.timer.clearTimeout(record.pumpTurn);
      record.pumpTurn = null;
      this.#rejectAllContinuityCommits(
        record,
        new ContinuityCommitDeliveryError(
          'continuity_commit_proxy_shutdown',
          'The provider proxy shut down before the continuity checkpoint was committed.',
        ),
      );
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
    current.ownershipOrdinal += 1;
    this.#rejectAllContinuityCommits(
      current,
      new ContinuityCommitDeliveryError(
        'continuity_commit_attempt_superseded',
        'The prepare attempt owning the continuity checkpoint was superseded.',
      ),
    );
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
      ownershipOrdinal: 1,
      continuityCommits: new Map(),
      providerEventAmbiguity: null,
      pumpDemand: false,
      pumpTurn: null,
      pumpRunning: false,
      closed: false,
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
    const beginsRelease = record.releaseIntent === null;
    record.releaseIntent ??= intent;
    record.fenced = true;
    if (beginsRelease) record.ownershipOrdinal += 1;
    this.#clearDeadline(record);
    try {
      this.#ledger.beginRelease(record.key);
    } catch (error: unknown) {
      asProtocolError(error);
    }
    if (beginsRelease) {
      this.#rejectAllContinuityCommits(
        record,
        new ContinuityCommitDeliveryError(
          'continuity_commit_operation_released',
          'The operation was released before the continuity checkpoint was committed.',
        ),
      );
      const ambiguity = record.providerEventAmbiguity;
      if (ambiguity !== null) this.#clearProviderEventAmbiguity(record, ambiguity);
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
    this.#rejectAllContinuityCommits(
      record,
      new ContinuityCommitDeliveryError(
        'continuity_commit_replaced_by_proxy_terminal',
        'The continuity checkpoint was replaced by a proxy emergency terminal.',
      ),
    );
    this.#requestPump(record);
    return { kind: 'proxy-emergency-terminal' };
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

  #ownership(record: SupervisedOperation): OperationOwnershipEpoch {
    return {
      prepareAttemptNumber: record.prepareAttemptNumber,
      prepareAttemptKey: record.prepareAttemptKey,
      ordinal: record.ownershipOrdinal,
    };
  }

  #owns(record: SupervisedOperation, ownership: OperationOwnershipEpoch): boolean {
    return (
      record.prepareAttemptNumber === ownership.prepareAttemptNumber &&
      record.prepareAttemptKey === ownership.prepareAttemptKey &&
      record.ownershipOrdinal === ownership.ordinal
    );
  }

  #sameOwnership(left: OperationOwnershipEpoch, right: OperationOwnershipEpoch): boolean {
    return (
      left.prepareAttemptNumber === right.prepareAttemptNumber &&
      left.prepareAttemptKey === right.prepareAttemptKey &&
      left.ordinal === right.ordinal
    );
  }

  #createPendingContinuityCommit(
    record: SupervisedOperation,
    providerSeq: number,
    event: ProviderContinuityEventBody,
  ): PendingContinuityCommit {
    let resolveCommitted!: () => void;
    let rejectCommitted!: (error: ContinuityCommitDeliveryError) => void;
    const committed = new Promise<void>((resolve, reject) => {
      resolveCommitted = resolve;
      rejectCommitted = reject;
    });
    const rejectSettlement = (error: ContinuityCommitDeliveryError): void =>
      this.#rejectContinuityCommit(record, pending, error);
    const settlement: ContinuityCommitSettlement = Object.freeze({
      providerSeq,
      committed,
      reject: rejectSettlement,
    });
    const pending: PendingContinuityCommit = {
      ownership: this.#ownership(record),
      providerSeq,
      event,
      state: 'pending',
      settlement,
      resolveCommitted,
      rejectCommitted,
    };
    return pending;
  }

  #commitContinuityCommit(record: SupervisedOperation, pending: PendingContinuityCommit): void {
    if (record.continuityCommits.get(pending.providerSeq) !== pending || pending.state !== 'pending') return;
    pending.state = 'committed';
    record.continuityCommits.delete(pending.providerSeq);
    commitContinuityEvent(pending.event);
    pending.resolveCommitted();
  }

  #rejectContinuityCommit(
    record: SupervisedOperation,
    pending: PendingContinuityCommit,
    error: ContinuityCommitDeliveryError,
  ): void {
    if (record.continuityCommits.get(pending.providerSeq) !== pending || pending.state !== 'pending') return;
    pending.state = 'rejected';
    record.continuityCommits.delete(pending.providerSeq);
    const deadline = record.providerEventAmbiguity;
    if (deadline?.providerSeq === pending.providerSeq) this.#clearProviderEventAmbiguity(record, deadline);
    rejectContinuityEvent(pending.event, error);
    pending.rejectCommitted(error);
  }

  #rejectAllContinuityCommits(record: SupervisedOperation, error: ContinuityCommitDeliveryError): void {
    for (const pending of [...record.continuityCommits.values()]) {
      this.#rejectContinuityCommit(record, pending, error);
    }
  }

  #commitCoveredContinuity(
    record: SupervisedOperation,
    ownership: OperationOwnershipEpoch,
    committedThroughProviderSeq: number,
  ): void {
    for (const pending of [...record.continuityCommits.values()]) {
      if (pending.providerSeq > committedThroughProviderSeq) continue;
      if (!this.#sameOwnership(pending.ownership, ownership)) continue;
      this.#commitContinuityCommit(record, pending);
    }
  }

  #ensureProviderEventAmbiguity(
    record: SupervisedOperation,
    providerSeq: number,
    controlEpoch: ControlEpoch,
  ): ProviderEventAmbiguityDeadline {
    const current = record.providerEventAmbiguity;
    if (current !== null && current.controlEpoch === controlEpoch) {
      if (current.providerSeq !== providerSeq) {
        throw new Error('One control epoch attempted a later provider frame before resolving its ambiguity.');
      }
      return current;
    }
    if (current !== null) this.#clearProviderEventAmbiguity(record, current);
    const requestedAtMs = this.#options.nowMs();
    const deadline: ProviderEventAmbiguityDeadline = {
      controlEpoch,
      providerSeq,
      requestedAtMs,
      expiresAtMs: requestedAtMs + PROXY_EVENT_COMMIT_TIMEOUT_MS,
      timer: null,
      fault: null,
    };
    const timer = this.#options.timer.setTimeout(
      () => this.#expireProviderEventAmbiguity(record, deadline),
      PROXY_EVENT_COMMIT_TIMEOUT_MS,
    );
    timer.unref?.();
    deadline.timer = timer;
    record.providerEventAmbiguity = deadline;
    return deadline;
  }

  #expireProviderEventAmbiguity(record: SupervisedOperation, deadline: ProviderEventAmbiguityDeadline): void {
    this.#faultProviderEventAmbiguity(record, deadline, 'provider_event_ack_timeout');
  }

  #faultProviderEventAmbiguity(
    record: SupervisedOperation,
    deadline: ProviderEventAmbiguityDeadline,
    reason: ProviderEventControlFaultReason,
  ): void {
    if (record.providerEventAmbiguity !== deadline || deadline.fault !== null) return;
    deadline.fault = reason;
    if (deadline.timer !== null) this.#options.timer.clearTimeout(deadline.timer);
    deadline.timer = null;
    this.#retirePumpDemand(record);
    this.#options.faultProviderEventControl({
      reason,
      operation: record.operation,
      providerSeq: deadline.providerSeq,
      expectedControlEpoch: deadline.controlEpoch,
    });
  }

  #clearProviderEventAmbiguity(record: SupervisedOperation, deadline: ProviderEventAmbiguityDeadline): void {
    if (record.providerEventAmbiguity !== deadline) return;
    if (deadline.timer !== null) this.#options.timer.clearTimeout(deadline.timer);
    deadline.timer = null;
    record.providerEventAmbiguity = null;
  }

  #retirePumpDemand(record: SupervisedOperation): void {
    record.pumpDemand = false;
    if (record.pumpTurn !== null) {
      this.#options.timer.clearTimeout(record.pumpTurn);
      record.pumpTurn = null;
    }
  }

  #requestPump(record: SupervisedOperation): void {
    const deadline = record.providerEventAmbiguity;
    if (deadline !== null && deadline.fault !== null) {
      this.#retirePumpDemand(record);
      return;
    }
    record.pumpDemand = true;
    this.#schedulePumpTurn(record);
  }

  #schedulePumpTurn(record: SupervisedOperation): void {
    const deadline = record.providerEventAmbiguity;
    if (deadline !== null && deadline.fault !== null) {
      this.#retirePumpDemand(record);
      return;
    }
    if (record.pumpTurn !== null || record.pumpRunning || record.closed) return;
    let handle: { unref?: () => void } | null = null;
    handle = this.#options.timer.setTimeout(() => {
      if (record.pumpTurn !== handle) return;
      record.pumpTurn = null;
      void this.#runPumpTurn(record);
    }, 0);
    record.pumpTurn = handle;
  }

  #beginProviderEventPush(record: SupervisedOperation, next: ReplayEvent): BegunProviderEventPush | null {
    const ownership = this.#ownership(record);
    let push: ControlTenancyPush;
    try {
      push = this.#options.pushProviderEvent(next.frame);
    } catch (error: unknown) {
      if (
        error instanceof ControlEndpointError &&
        (error.code === 'control_endpoint_push_no_tenancy' || error.code === 'control_endpoint_closed')
      ) {
        return null;
      }
      throw error;
    }
    const deadline = this.#ensureProviderEventAmbiguity(record, next.providerSeq, push.controlEpoch);
    return { next, ownership, push, deadline };
  }

  async #awaitProviderEventPush(
    record: SupervisedOperation,
    begun: BegunProviderEventPush,
  ): Promise<ProviderEventPushResponse> {
    try {
      return { kind: 'received', response: await begun.push.response };
    } catch (error: unknown) {
      if (error instanceof ControlEndpointError) {
        if (error.code === 'control_endpoint_push_timeout') {
          this.#expireProviderEventAmbiguity(record, begun.deadline);
          return { kind: 'stop' };
        }
        if (error.code === 'control_endpoint_push_refused') {
          this.#faultProviderEventAmbiguity(record, begun.deadline, 'provider_event_response_refused');
          return { kind: 'stop' };
        }
        if (error.code === 'control_endpoint_push_lost' || error.code === 'control_endpoint_closed') {
          return { kind: record.pumpDemand ? 'retry' : 'stop' };
        }
      }
      return { kind: 'stop' };
    }
  }

  #applyProviderEventResponse(
    record: SupervisedOperation,
    begun: BegunProviderEventPush,
    response: unknown,
  ): 'advanced' | 'retained' | 'stop' {
    let result: ProviderEventResult;
    try {
      result = providerEventResultSchema.parse(response);
    } catch {
      this.#faultProviderEventAmbiguity(record, begun.deadline, 'provider_event_response_invalid');
      return 'stop';
    }
    if (result.kind === 'replay') return 'retained';

    const current = this.#operations.get(operationToken(record.operation));
    const guardedEntry = this.#ledger.get(record.key);
    if (
      current !== record ||
      !this.#owns(record, begun.ownership) ||
      record.providerEventAmbiguity !== begun.deadline ||
      begun.deadline.fault !== null ||
      record.fenced ||
      record.releaseIntent !== null ||
      guardedEntry?.state === 'releasing'
    ) {
      return 'stop';
    }
    if (result.committedThroughProviderSeq < begun.next.providerSeq) {
      this.#faultProviderEventAmbiguity(record, begun.deadline, 'provider_event_ack_invalid');
      return 'stop';
    }
    try {
      this.#ledger.acknowledge(record.key, result.committedThroughProviderSeq);
    } catch {
      this.#faultProviderEventAmbiguity(record, begun.deadline, 'provider_event_ack_invalid');
      return 'stop';
    }
    this.#clearProviderEventAmbiguity(record, begun.deadline);
    this.#commitCoveredContinuity(record, begun.ownership, result.committedThroughProviderSeq);
    if ((this.#ledger.get(record.key)?.bufferedEvents.length ?? 0) > 0) this.#requestPump(record);
    return 'advanced';
  }

  async #runPumpTurn(record: SupervisedOperation): Promise<void> {
    if (this.#operations.get(operationToken(record.operation)) !== record || record.pumpRunning || record.closed) {
      return;
    }
    record.pumpRunning = true;
    record.pumpDemand = false;
    try {
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
      const begun = this.#beginProviderEventPush(record, next);
      if (begun === null) return;
      const pushed = await this.#awaitProviderEventPush(record, begun);
      if (pushed.kind !== 'received') return;
      this.#applyProviderEventResponse(record, begun, pushed.response);
    } finally {
      record.pumpRunning = false;
      if (record.pumpDemand) this.#schedulePumpTurn(record);
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
