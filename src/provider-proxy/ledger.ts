import type { ProcessIncarnation } from '../infra/node-process.js';
import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  MAX_PROVIDER_PROXY_EMERGENCY_FRAME_BYTES,
  providerProxyEmergencyEventSchema,
  type ProviderProxyEmergencyEvent,
} from '../providers/proxy-failure.js';

// Type-only, so no runtime edge and no cycle with `protocol.ts` (which imports this file's ledger bound).
// `production-import-graph.test.ts` walks runtime edges alone, for exactly this reason.
import type { JointContainmentReceipt, ProxyOperationActivationReceipt, Reservation } from './protocol.js';
import { ReplayAdmissionError, ReplayBudget, type ReplayAdmissionKind, type ReplayCharge } from './replay-budget.js';

/**
 * How many operations one proxy may carry at once. It lives here because it is a ledger bound; the
 * containment primitive takes it as an injected limit rather than naming a provider-proxy concept.
 */
export const MAX_PROXY_OPERATION_LEDGERS = 128;

/** Per-operation replay ceilings. Both are checked, because either can be reached first. */
export const MAX_PROVIDER_REPLAY_EVENTS = 4_096;
export const MAX_PROVIDER_REPLAY_BYTES = 16 * 1024 * 1024;
/** Proxy-wide ceiling across every live ledger. */
export const MAX_PROXY_REPLAY_BYTES = 64 * 1024 * 1024;
export const MAX_EMERGENCY_COMPLETION_FRAME_BYTES = 64 * 1024;
export const MAX_PROXY_COMPLETION_RESERVE_BYTES = MAX_PROXY_OPERATION_LEDGERS * MAX_EMERGENCY_COMPLETION_FRAME_BYTES;
export const MAX_PROXY_SHARED_REPLAY_BYTES = MAX_PROXY_REPLAY_BYTES - MAX_PROXY_COMPLETION_RESERVE_BYTES;
/** How long a reservation stays activatable without renewal, on the proxy's own clock. */
export const PROXY_PENDING_ACTIVATION_LEASE_MS = 15_000;

/** The phases are evidence: `starting` means the supervisor has no proof that the host crossed its start boundary. */
export type ProviderOperationState =
  | 'preparing'
  | 'prepared'
  | 'starting'
  | 'started-awaiting-publication'
  | 'executing'
  | 'terminal-awaiting-settlement'
  | 'suspended-awaiting-durable-decision'
  | 'releasing';

const ALLOWED_TRANSITIONS: Readonly<Record<ProviderOperationState, readonly (ProviderOperationState | 'released')[]>> =
  Object.freeze({
    preparing: ['prepared', 'releasing'],
    prepared: ['starting', 'releasing'],
    starting: ['started-awaiting-publication', 'releasing'],
    'started-awaiting-publication': ['executing'],
    executing: ['terminal-awaiting-settlement', 'suspended-awaiting-durable-decision'],
    'terminal-awaiting-settlement': ['releasing'],
    'suspended-awaiting-durable-decision': ['releasing'],
    releasing: ['released'],
  });

export type ProviderOperationKey = Readonly<{ jobId: string; operationId: string }>;
export type ProviderRootIdentity = Readonly<{ pid: number; incarnation: ProcessIncarnation }>;

export const operationPrepareAttemptKeySchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const operationPrepareAttemptNumberSchema = z.number().int().positive().safe();

export function operationPrepareAttemptKey(
  request: Readonly<{
    operation: unknown;
    hostFingerprint: string;
    prepared: unknown;
    prepareAttemptNumber: number;
  }>,
): string {
  return createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex');
}

export function operationActivationFingerprint(request: unknown): string {
  return createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex');
}

export type LedgerErrorCode =
  | 'operation_not_found'
  | 'operation_duplicate'
  | 'operation_invalid_transition'
  | 'operation_capacity_exhausted'
  | 'replay_capacity_exhausted'
  | 'reservation_expired'
  | 'reservation_mismatch';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    Object.setPrototypeOf(this, LedgerError.prototype);
  }
}

/**
 * One buffered event awaiting the coordinator's commit acknowledgement. It carries the encoded frame,
 * because a consumer that reconnects has to be sent the events again — a record of sizes alone could not
 * replay anything, and a second buffer beside this one would be a second place for the accounting to drift.
 */
export type ReplayEvent = Readonly<{ providerSeq: number; frame: string }>;

function frameBytes(event: ReplayEvent): number {
  return Buffer.byteLength(event.frame, 'utf8');
}

export type OperationLedgerEntry<Prepared = unknown> = Readonly<{
  key: ProviderOperationKey;
  state: ProviderOperationState;
  reservation: Reservation;
  /** Lease expiry on the proxy's own monotonic clock, in its milliseconds. */
  leaseExpiresAtMs: number;
  /**
   * The semantic envelope prepare validated, retained here so activate starts the kernel with what was
   * actually reserved rather than with activate's own request payload — a second map keyed the same way
   * would drift the first time one side is updated without the other.
   */
  prepared: Prepared;
  prepareAttemptNumber: number;
  prepareAttemptKey: string;
  providerRoot: ProviderRootIdentity | null;
  /**
   * The guardian's receipt for the staged provider root. Null until prepare's staging completes, since
   * capacity is checked — and the entry created — before that root is ever staged. Activate compares a
   * caller's receipt against this one, so an activation can never name a root nobody staged.
   */
  jointContainmentReceipt: JointContainmentReceipt | null;
  activationFingerprint: string | null;
  activationAck: ProxyOperationActivationReceipt | null;
  committedThroughProviderSeq: number;
  bufferedEvents: readonly ReplayEvent[];
  bufferedBytes: number;
}>;

/**
 * A typed capacity refusal. It is retryable and deliberately writes nothing: admission stays with the
 * coordinator, so the proxy reports that it cannot take the work rather than queueing it.
 */
export type PrepareResult<Prepared = unknown> =
  | Readonly<{ kind: 'reserved'; entry: OperationLedgerEntry<Prepared> }>
  | Readonly<{ kind: 'capacity'; retryable: true; reason: 'operation-ledgers' | 'replay-bytes' }>;

export interface OperationLedger<Prepared = unknown> {
  prepare(input: {
    key: ProviderOperationKey;
    reservation: Reservation;
    prepared: Prepared;
    nowMs: number;
    prepareAttemptNumber?: number;
    idempotencyKey?: string;
  }): PrepareResult<Prepared>;
  /**
   * Attaches the guardian's staging receipt once prepare's async staging completes. A separate step because
   * capacity must be checked — and the entry created — before an operation is ever staged; folding the
   * receipt into `prepare`'s input would mean staging every reservation before knowing it will be admitted.
   */
  recordContainmentReceipt(key: ProviderOperationKey, jointContainmentReceipt: JointContainmentReceipt): void;
  recordPreparation(
    key: ProviderOperationKey,
    providerRoot: ProviderRootIdentity,
    jointContainmentReceipt: JointContainmentReceipt,
  ): void;
  renew(key: ProviderOperationKey, reservation: Reservation, nowMs: number): OperationLedgerEntry<Prepared>;
  beginActivation(key: ProviderOperationKey, reservation: Reservation, nowMs: number, fingerprint: string): void;
  recordStart(key: ProviderOperationKey, fingerprint: string, ack: ProxyOperationActivationReceipt): void;
  publishActivation(key: ProviderOperationKey, fingerprint: string): void;
  completeActivation(key: ProviderOperationKey, fingerprint: string, ack: ProxyOperationActivationReceipt): void;
  beginRelease(key: ProviderOperationKey): void;
  transition(key: ProviderOperationKey, next: ProviderOperationState | 'released'): void;
  recordEvent(
    key: ProviderOperationKey,
    event: ReplayEvent,
    admission: Readonly<{ kind: 'ordinary' }> | Readonly<{ kind: 'completion' }>,
  ): void;
  recordProxyEmergencyCompletion(key: ProviderOperationKey, event: unknown, frameId: number): void;
  acknowledge(key: ProviderOperationKey, committedThroughProviderSeq: number): void;
  /**
   * The `providerSeq` the next `recordEvent` call for this operation must use: one past whatever is
   * currently the newest buffered event, or one past the last acknowledged point once the buffer is empty.
   * The one place this arithmetic lives, so a caller never re-derives it from `bufferedEvents` itself and
   * risks drifting from the exact floor `recordEvent` enforces.
   */
  nextProviderSeq(key: ProviderOperationKey): number;
  get(key: ProviderOperationKey): OperationLedgerEntry<Prepared> | null;
  /**
   * Every operation this ledger currently holds, in no particular order. Used to resume draining every
   * operation's buffer after a control tenancy reattaches — not to look up any one operation's own state.
   */
  keys(): readonly ProviderOperationKey[];
}

type MutableEntry<Prepared> = {
  key: ProviderOperationKey;
  state: ProviderOperationState;
  reservation: Reservation;
  leaseExpiresAtMs: number;
  prepared: Prepared;
  prepareAttemptNumber: number;
  idempotencyKey: string;
  providerRoot: ProviderRootIdentity | null;
  jointContainmentReceipt: JointContainmentReceipt | null;
  activationFingerprint: string | null;
  activationAck: ProxyOperationActivationReceipt | null;
  committedThroughProviderSeq: number;
  buffered: BufferedReplayEvent[];
  bufferedBytes: number;
  ordinaryEventCount: number;
  sharedBytes: number;
  completionRecorded: boolean;
};

type BufferedReplayEvent = Readonly<{
  event: ReplayEvent;
  admission: ReplayAdmissionKind;
  charge: ReplayCharge;
}>;

type ProxyEmergencyCompletionEncoder = (
  input: Readonly<{
    key: ProviderOperationKey;
    providerSeq: number;
    frameId: number;
    event: ProviderProxyEmergencyEvent;
  }>,
) => ReplayEvent;

function keyOf(key: ProviderOperationKey): string {
  return `${key.jobId}\u0000${key.operationId}`;
}

function snapshot<Prepared>(entry: MutableEntry<Prepared>): OperationLedgerEntry<Prepared> {
  return Object.freeze({
    key: entry.key,
    state: entry.state,
    reservation: entry.reservation,
    leaseExpiresAtMs: entry.leaseExpiresAtMs,
    prepared: entry.prepared,
    prepareAttemptNumber: entry.prepareAttemptNumber,
    prepareAttemptKey: entry.idempotencyKey,
    providerRoot: entry.providerRoot,
    jointContainmentReceipt: entry.jointContainmentReceipt,
    activationFingerprint: entry.activationFingerprint,
    activationAck: entry.activationAck,
    committedThroughProviderSeq: entry.committedThroughProviderSeq,
    bufferedEvents: Object.freeze(entry.buffered.map((buffered) => buffered.event)),
    bufferedBytes: entry.bufferedBytes,
  });
}

function requireLeaseCurrent(entry: MutableEntry<unknown>, nowMs: number): void {
  if (nowMs >= entry.leaseExpiresAtMs) {
    throw new LedgerError('reservation_expired', 'The activation lease expired.');
  }
}

export function createOperationLedger<Prepared = unknown>(
  options: Readonly<{ encodeProxyEmergencyCompletion?: ProxyEmergencyCompletionEncoder }> = {},
): OperationLedger<Prepared> {
  const entries = new Map<string, MutableEntry<Prepared>>();
  const replayBudget = new ReplayBudget(MAX_PROXY_SHARED_REPLAY_BYTES, MAX_PROXY_COMPLETION_RESERVE_BYTES);

  const require = (key: ProviderOperationKey): MutableEntry<Prepared> => {
    const entry = entries.get(keyOf(key));
    if (entry === undefined) {
      throw new LedgerError('operation_not_found', `No ledger entry for ${key.jobId}/${key.operationId}.`);
    }
    return entry;
  };

  const eventMayBeRecorded = (key: ProviderOperationKey): boolean => {
    const entry = entries.get(keyOf(key));
    return (
      entry !== undefined &&
      (entry.state === 'starting' ||
        entry.state === 'started-awaiting-publication' ||
        entry.state === 'executing' ||
        entry.state === 'terminal-awaiting-settlement' ||
        entry.state === 'suspended-awaiting-durable-decision')
    );
  };

  const requireEventTarget = (key: ProviderOperationKey, event: ReplayEvent): MutableEntry<Prepared> => {
    const entry = require(key);
    if (!eventMayBeRecorded(key)) {
      throw new LedgerError('operation_invalid_transition', `Cannot record an event from ${entry.state}.`);
    }
    const last = entry.buffered.at(-1)?.event;
    const floor = last?.providerSeq ?? entry.committedThroughProviderSeq;
    if (event.providerSeq <= floor) {
      throw new LedgerError('operation_invalid_transition', 'Provider sequence must increase monotonically.');
    }
    return entry;
  };

  const appendCommittedEvent = (
    entry: MutableEntry<Prepared>,
    event: ReplayEvent,
    admission: ReplayAdmissionKind,
    charge: ReplayCharge,
  ): void => {
    entry.buffered.push({ event, admission, charge });
    entry.bufferedBytes += frameBytes(event);
    entry.sharedBytes += charge.sharedBytes;
    if (admission === 'ordinary') entry.ordinaryEventCount += 1;
    else entry.completionRecorded = true;
  };

  const nextProviderSeq = (key: ProviderOperationKey): number => {
    const entry = require(key);
    const last = entry.buffered.at(-1)?.event;
    return (last?.providerSeq ?? entry.committedThroughProviderSeq) + 1;
  };

  return {
    prepare({
      key,
      reservation,
      prepared,
      nowMs,
      prepareAttemptNumber = 1,
      idempotencyKey = reservation,
    }): PrepareResult<Prepared> {
      const existing = entries.get(keyOf(key));
      if (existing !== undefined) {
        // A repeat of the same prepare is the same request arriving twice — a dropped reply, a retry. It
        // returns the reservation already made; only a *different* payload for one identity is a conflict.
        if (existing.prepareAttemptNumber === prepareAttemptNumber && existing.idempotencyKey === idempotencyKey) {
          return { kind: 'reserved', entry: snapshot(existing) };
        }
        throw new LedgerError('operation_duplicate', `${key.jobId}/${key.operationId} is already reserved.`);
      }
      if (entries.size >= MAX_PROXY_OPERATION_LEDGERS) {
        return { kind: 'capacity', retryable: true, reason: 'operation-ledgers' };
      }
      if (replayBudget.isExhausted()) {
        return { kind: 'capacity', retryable: true, reason: 'replay-bytes' };
      }
      const entry: MutableEntry<Prepared> = {
        key,
        state: 'preparing',
        reservation,
        leaseExpiresAtMs: nowMs + PROXY_PENDING_ACTIVATION_LEASE_MS,
        prepared,
        prepareAttemptNumber,
        idempotencyKey,
        providerRoot: null,
        jointContainmentReceipt: null,
        activationFingerprint: null,
        activationAck: null,
        committedThroughProviderSeq: 0,
        buffered: [],
        bufferedBytes: 0,
        ordinaryEventCount: 0,
        sharedBytes: 0,
        completionRecorded: false,
      };
      entries.set(keyOf(key), entry);
      return { kind: 'reserved', entry: snapshot(entry) };
    },

    recordContainmentReceipt(key, jointContainmentReceipt): void {
      const entry = require(key);
      entry.jointContainmentReceipt = jointContainmentReceipt;
    },

    recordPreparation(key, providerRoot, jointContainmentReceipt): void {
      const entry = require(key);
      if (entry.state !== 'preparing' && entry.state !== 'releasing') {
        throw new LedgerError('operation_invalid_transition', `Cannot record preparation from ${entry.state}.`);
      }
      entry.providerRoot = providerRoot;
      entry.jointContainmentReceipt = jointContainmentReceipt;
      if (entry.state === 'preparing') entry.state = 'prepared';
    },

    renew(key, reservation, nowMs): OperationLedgerEntry<Prepared> {
      const entry = require(key);
      if (entry.reservation !== reservation) {
        throw new LedgerError('reservation_mismatch', 'Renewal presented a different reservation.');
      }
      if (entry.state !== 'preparing' && entry.state !== 'prepared') {
        throw new LedgerError('operation_invalid_transition', `Cannot renew from ${entry.state}.`);
      }
      requireLeaseCurrent(entry, nowMs);
      entry.leaseExpiresAtMs = nowMs + PROXY_PENDING_ACTIVATION_LEASE_MS;
      return snapshot(entry);
    },

    beginActivation(key, reservation, nowMs, fingerprint): void {
      const entry = require(key);
      if (entry.reservation !== reservation) {
        throw new LedgerError('reservation_mismatch', 'Activation presented a different reservation.');
      }
      requireLeaseCurrent(entry, nowMs);
      if (entry.state !== 'prepared') {
        throw new LedgerError('operation_invalid_transition', `Cannot activate from ${entry.state}.`);
      }
      entry.state = 'starting';
      entry.activationFingerprint = fingerprint;
    },

    recordStart(key, fingerprint, ack): void {
      const entry = require(key);
      if (entry.state !== 'starting' || entry.activationFingerprint !== fingerprint) {
        throw new LedgerError('operation_invalid_transition', `Cannot record start from ${entry.state}.`);
      }
      entry.activationAck = Object.freeze({ ...ack });
      entry.state = 'started-awaiting-publication';
    },

    publishActivation(key, fingerprint): void {
      const entry = require(key);
      if (entry.state !== 'started-awaiting-publication' || entry.activationFingerprint !== fingerprint) {
        throw new LedgerError('operation_invalid_transition', `Cannot publish activation from ${entry.state}.`);
      }
      entry.state = 'executing';
    },

    completeActivation(key, fingerprint, ack): void {
      this.recordStart(key, fingerprint, ack);
      this.publishActivation(key, fingerprint);
    },

    beginRelease(key): void {
      const entry = require(key);
      if (entry.state === 'releasing') return;
      if (!ALLOWED_TRANSITIONS[entry.state].includes('releasing')) {
        throw new LedgerError('operation_invalid_transition', `${entry.state} does not reach releasing.`);
      }
      entry.state = 'releasing';
    },

    transition(key, next): void {
      const entry = require(key);
      if (!ALLOWED_TRANSITIONS[entry.state].includes(next)) {
        throw new LedgerError('operation_invalid_transition', `${entry.state} does not reach ${next}.`);
      }
      if (next === 'released') {
        for (const buffered of entry.buffered) replayBudget.release(buffered.charge);
        entries.delete(keyOf(key));
        return;
      }
      entry.state = next;
    },

    recordEvent(key, event, admission): void {
      const entry = requireEventTarget(key, event);
      const cost = frameBytes(event);
      if (admission.kind !== 'ordinary' && admission.kind !== 'completion') {
        throw new TypeError(`Unsupported replay admission kind '${String((admission as { kind?: unknown }).kind)}'.`);
      }

      if (admission.kind === 'ordinary') {
        if (entry.ordinaryEventCount + 1 > MAX_PROVIDER_REPLAY_EVENTS) {
          throw new ReplayAdmissionError('operation-events', 'The operation replay event budget is exhausted.');
        }
        if (entry.sharedBytes + cost > MAX_PROVIDER_REPLAY_BYTES) {
          throw new ReplayAdmissionError('operation-bytes', 'The operation replay byte budget is exhausted.');
        }
      } else {
        if (entry.completionRecorded) {
          throw new LedgerError('operation_invalid_transition', 'The operation already recorded a completion.');
        }
        const sharedRemainder = Math.max(0, cost - MAX_EMERGENCY_COMPLETION_FRAME_BYTES);
        if (entry.sharedBytes + sharedRemainder > MAX_PROVIDER_REPLAY_BYTES) {
          throw new ReplayAdmissionError(
            'completion-frame-bytes',
            'The provider completion cannot fit the operation replay byte budget.',
          );
        }
      }

      const charge = replayBudget.commit({
        kind: admission.kind,
        frameBytes: cost,
        completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
      });
      try {
        requireEventTarget(key, event);
        appendCommittedEvent(entry, event, admission.kind, charge);
      } catch (error: unknown) {
        replayBudget.release(charge);
        throw error;
      }
    },

    recordProxyEmergencyCompletion(key, event, frameId): void {
      const providerSeq = nextProviderSeq(key);
      const entry = requireEventTarget(key, { providerSeq, frame: '' });
      if (entry.completionRecorded) {
        throw new LedgerError('operation_invalid_transition', 'The operation already recorded a completion.');
      }
      if (options.encodeProxyEmergencyCompletion === undefined) {
        throw new Error('The operation ledger has no proxy-emergency frame encoder.');
      }

      const parsedEvent = providerProxyEmergencyEventSchema.parse(event);
      const encoded = options.encodeProxyEmergencyCompletion({ key, providerSeq, frameId, event: parsedEvent });
      if (encoded.providerSeq !== providerSeq) {
        throw new LedgerError('operation_invalid_transition', 'The proxy-emergency encoder changed provider sequence.');
      }
      const cost = frameBytes(encoded);
      if (cost > MAX_PROVIDER_PROXY_EMERGENCY_FRAME_BYTES) {
        throw new ReplayAdmissionError(
          'completion-frame-bytes',
          `The proxy emergency completion exceeded ${MAX_PROVIDER_PROXY_EMERGENCY_FRAME_BYTES} bytes.`,
        );
      }

      const charge = replayBudget.commit({
        kind: 'emergency-completion',
        frameBytes: cost,
        completionSlotLimitBytes: MAX_EMERGENCY_COMPLETION_FRAME_BYTES,
      });
      try {
        requireEventTarget(key, encoded);
        appendCommittedEvent(entry, encoded, 'emergency-completion', charge);
      } catch (error: unknown) {
        replayBudget.release(charge);
        throw error;
      }
    },

    acknowledge(key, committedThroughProviderSeq): void {
      const entry = require(key);
      if (committedThroughProviderSeq < entry.committedThroughProviderSeq) {
        throw new LedgerError('operation_invalid_transition', 'Acknowledgement moved backwards.');
      }
      const retained: BufferedReplayEvent[] = [];
      let freed = 0;
      for (const buffered of entry.buffered) {
        if (buffered.event.providerSeq <= committedThroughProviderSeq) {
          freed += frameBytes(buffered.event);
          entry.sharedBytes -= buffered.charge.sharedBytes;
          if (buffered.admission === 'ordinary') entry.ordinaryEventCount -= 1;
          replayBudget.release(buffered.charge);
        } else retained.push(buffered);
      }
      entry.buffered = retained;
      entry.bufferedBytes -= freed;
      entry.committedThroughProviderSeq = committedThroughProviderSeq;
    },

    nextProviderSeq(key): number {
      return nextProviderSeq(key);
    },

    get(key): OperationLedgerEntry<Prepared> | null {
      const entry = entries.get(keyOf(key));
      return entry === undefined ? null : snapshot(entry);
    },

    keys(): readonly ProviderOperationKey[] {
      return Object.freeze([...entries.values()].map((entry) => entry.key));
    },
  };
}
