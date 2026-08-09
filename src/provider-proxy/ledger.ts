import { createHash } from 'node:crypto';

import { z } from 'zod';

// Type-only, so no runtime edge and no cycle with `protocol.ts` (which imports this file's ledger bound).
// `production-import-graph.test.ts` walks runtime edges alone, for exactly this reason.
import type { JointContainmentReceipt, ProxyOperationActivationReceipt, Reservation } from './protocol.js';
import { ReplayBudget, type ReplayCapacityReservation } from './replay-budget.js';

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
/** How long a reservation stays activatable without renewal, on the proxy's own clock. */
export const PROXY_PENDING_ACTIVATION_LEASE_MS = 15_000;

/** The phases are evidence: `starting` means the host call is unresolved, never that a kernel exists. */
export type ProviderOperationState =
  | 'preparing'
  | 'prepared'
  | 'starting'
  | 'executing'
  | 'terminal-awaiting-settlement'
  | 'suspended-awaiting-durable-decision'
  | 'releasing';

const ALLOWED_TRANSITIONS: Readonly<Record<ProviderOperationState, readonly (ProviderOperationState | 'released')[]>> =
  Object.freeze({
    preparing: ['prepared', 'releasing'],
    prepared: ['starting', 'releasing'],
    starting: ['executing', 'releasing'],
    executing: ['terminal-awaiting-settlement', 'suspended-awaiting-durable-decision'],
    'terminal-awaiting-settlement': ['releasing'],
    'suspended-awaiting-durable-decision': ['releasing'],
    releasing: ['released'],
  });

export type ProviderOperationKey = Readonly<{ jobId: string; operationId: string }>;
export type ProviderRootIdentity = Readonly<{ pid: number; processStartedAtSeconds: number }>;

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

/** The frame's cost against both the per-operation and proxy-wide budgets. */
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
  completeActivation(key: ProviderOperationKey, fingerprint: string, ack: ProxyOperationActivationReceipt): void;
  beginRelease(key: ProviderOperationKey): void;
  transition(key: ProviderOperationKey, next: ProviderOperationState | 'released'): void;
  reserveEvent(key: ProviderOperationKey, signal?: AbortSignal): Promise<ReplayCapacityReservation>;
  recordEvent(key: ProviderOperationKey, event: ReplayEvent, reservation: ReplayCapacityReservation): void;
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
  buffered: ReplayEvent[];
  bufferedBytes: number;
};

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
    bufferedEvents: Object.freeze([...entry.buffered]),
    bufferedBytes: entry.bufferedBytes,
  });
}

function requireLeaseCurrent(entry: MutableEntry<unknown>, nowMs: number): void {
  if (nowMs >= entry.leaseExpiresAtMs) {
    throw new LedgerError('reservation_expired', 'The activation lease expired.');
  }
}

export function createOperationLedger<Prepared = unknown>(): OperationLedger<Prepared> {
  const entries = new Map<string, MutableEntry<Prepared>>();
  const replayBudget = new ReplayBudget(MAX_PROXY_REPLAY_BYTES, MAX_PROVIDER_REPLAY_BYTES);

  const require = (key: ProviderOperationKey): MutableEntry<Prepared> => {
    const entry = entries.get(keyOf(key));
    if (entry === undefined) {
      throw new LedgerError('operation_not_found', `No ledger entry for ${key.jobId}/${key.operationId}.`);
    }
    return entry;
  };

  const eventMayBeProduced = (key: ProviderOperationKey): boolean => {
    const entry = entries.get(keyOf(key));
    return (
      entry !== undefined &&
      (entry.state === 'starting' ||
        entry.state === 'executing' ||
        entry.state === 'terminal-awaiting-settlement' ||
        entry.state === 'suspended-awaiting-durable-decision') &&
      entry.buffered.length < MAX_PROVIDER_REPLAY_EVENTS &&
      entry.bufferedBytes < MAX_PROVIDER_REPLAY_BYTES
    );
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

    completeActivation(key, fingerprint, ack): void {
      const entry = require(key);
      if (entry.state !== 'starting' || entry.activationFingerprint !== fingerprint) {
        throw new LedgerError('operation_invalid_transition', `Cannot complete activation from ${entry.state}.`);
      }
      entry.activationAck = Object.freeze({ ...ack });
      entry.state = 'executing';
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
        replayBudget.cancel(keyOf(key), new LedgerError('operation_not_found', 'The operation was released.'));
        replayBudget.releaseBuffered(entry.bufferedBytes);
        entries.delete(keyOf(key));
        return;
      }
      entry.state = next;
    },

    reserveEvent(key, signal): Promise<ReplayCapacityReservation> {
      require(key);
      return replayBudget.reserve(keyOf(key), () => eventMayBeProduced(key), signal);
    },

    recordEvent(key, event, reservation): void {
      try {
        const entry = require(key);
        if (reservation.identity !== keyOf(key)) {
          throw new LedgerError('operation_invalid_transition', 'Replay reservation belongs to another operation.');
        }
        if (
          entry.state !== 'starting' &&
          entry.state !== 'executing' &&
          entry.state !== 'terminal-awaiting-settlement' &&
          entry.state !== 'suspended-awaiting-durable-decision'
        ) {
          throw new LedgerError('operation_invalid_transition', `Cannot record an event from ${entry.state}.`);
        }
        const last = entry.buffered.at(-1);
        const floor = last?.providerSeq ?? entry.committedThroughProviderSeq;
        if (event.providerSeq <= floor) {
          throw new LedgerError('operation_invalid_transition', 'Provider sequence must increase monotonically.');
        }
        const cost = frameBytes(event);
        if (cost > MAX_PROVIDER_REPLAY_BYTES) {
          throw new LedgerError(
            'replay_capacity_exhausted',
            `A single provider event was ${cost} bytes, over the ${MAX_PROVIDER_REPLAY_BYTES}-byte per-operation limit.`,
          );
        }
        replayBudget.commit(reservation, cost);
        entry.buffered.push(event);
        entry.bufferedBytes += cost;
      } catch (error: unknown) {
        reservation.release();
        throw error;
      }
    },

    acknowledge(key, committedThroughProviderSeq): void {
      const entry = require(key);
      if (committedThroughProviderSeq < entry.committedThroughProviderSeq) {
        throw new LedgerError('operation_invalid_transition', 'Acknowledgement moved backwards.');
      }
      const retained: ReplayEvent[] = [];
      let freed = 0;
      for (const event of entry.buffered) {
        if (event.providerSeq <= committedThroughProviderSeq) freed += frameBytes(event);
        else retained.push(event);
      }
      entry.buffered = retained;
      entry.bufferedBytes -= freed;
      entry.committedThroughProviderSeq = committedThroughProviderSeq;
      replayBudget.releaseBuffered(freed);
    },

    nextProviderSeq(key): number {
      const entry = require(key);
      const last = entry.buffered.at(-1);
      return (last?.providerSeq ?? entry.committedThroughProviderSeq) + 1;
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
