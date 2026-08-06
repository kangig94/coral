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

/**
 * The only states an operation may hold. `pending-recovery` is reachable only from `pending-activation`:
 * an expired reservation forbids execution but stays queryable, so control can still cancel exactly it.
 */
export type ProviderOperationState =
  | 'pending-activation'
  | 'executing'
  | 'terminal-awaiting-journal-ack'
  | 'suspended-awaiting-durable-decision'
  | 'pending-recovery'
  | 'released';

const ALLOWED_TRANSITIONS: Readonly<Record<ProviderOperationState, readonly ProviderOperationState[]>> = Object.freeze({
  'pending-activation': ['executing', 'pending-recovery', 'released'],
  executing: ['terminal-awaiting-journal-ack', 'suspended-awaiting-durable-decision'],
  'terminal-awaiting-journal-ack': ['released'],
  'suspended-awaiting-durable-decision': ['released'],
  'pending-recovery': ['released'],
  released: [],
});

export type ProviderOperationKey = Readonly<{ jobId: string; operationId: string }>;

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

export type OperationLedgerEntry = Readonly<{
  key: ProviderOperationKey;
  state: ProviderOperationState;
  reservationId: string;
  activationNonce: string;
  /** Lease expiry on the proxy's own monotonic clock, in its milliseconds. */
  leaseExpiresAtMs: number;
  /**
   * The semantic envelope prepare validated, retained here so activate starts the kernel with what was
   * actually reserved rather than with activate's own request payload — a second map keyed the same way
   * would drift the first time one side is updated without the other.
   */
  prepared: unknown;
  /**
   * The guardian's receipt for the staged provider root. Null until prepare's staging completes, since
   * capacity is checked — and the entry created — before that root is ever staged. Activate compares a
   * caller's receipt against this one, so an activation can never name a root nobody staged.
   */
  jointContainmentReceipt: string | null;
  committedThroughProviderSeq: number;
  bufferedEvents: readonly ReplayEvent[];
  bufferedBytes: number;
}>;

/**
 * A typed capacity refusal. It is retryable and deliberately writes nothing: admission stays with the
 * coordinator, so the proxy reports that it cannot take the work rather than queueing it.
 */
export type PrepareResult =
  | Readonly<{ kind: 'reserved'; entry: OperationLedgerEntry }>
  | Readonly<{ kind: 'capacity'; retryable: true; reason: 'operation-ledgers' | 'replay-bytes' }>;

export interface OperationLedger {
  prepare(input: {
    key: ProviderOperationKey;
    reservationId: string;
    activationNonce: string;
    prepared: unknown;
    nowMs: number;
  }): PrepareResult;
  /**
   * Attaches the guardian's staging receipt once prepare's async staging completes. A separate step because
   * capacity must be checked — and the entry created — before an operation is ever staged; folding the
   * receipt into `prepare`'s input would mean staging every reservation before knowing it will be admitted.
   */
  recordContainmentReceipt(key: ProviderOperationKey, jointContainmentReceipt: string): void;
  renew(key: ProviderOperationKey, reservationId: string, nowMs: number): OperationLedgerEntry;
  activate(key: ProviderOperationKey, reservationId: string, activationNonce: string, nowMs: number): void;
  transition(key: ProviderOperationKey, next: ProviderOperationState): void;
  /** Buffers one provider event, returning whether the producer must pause before sending more. */
  recordEvent(key: ProviderOperationKey, event: ReplayEvent): { paused: boolean };
  /** Acknowledges through a sequence, freeing the buffer it covers and resuming the producer. */
  acknowledge(key: ProviderOperationKey, committedThroughProviderSeq: number): { resumed: boolean };
  /** Events after the acknowledged point, which a reconnecting consumer must be replayed. */
  replayFrom(key: ProviderOperationKey, afterProviderSeq: number): readonly ReplayEvent[];
  get(key: ProviderOperationKey): OperationLedgerEntry | null;
  size(): number;
}

type MutableEntry = {
  key: ProviderOperationKey;
  state: ProviderOperationState;
  reservationId: string;
  activationNonce: string;
  leaseExpiresAtMs: number;
  prepared: unknown;
  jointContainmentReceipt: string | null;
  committedThroughProviderSeq: number;
  buffered: ReplayEvent[];
  bufferedBytes: number;
  paused: boolean;
};

function keyOf(key: ProviderOperationKey): string {
  return `${key.jobId}\u0000${key.operationId}`;
}

function snapshot(entry: MutableEntry): OperationLedgerEntry {
  return Object.freeze({
    key: entry.key,
    state: entry.state,
    reservationId: entry.reservationId,
    activationNonce: entry.activationNonce,
    leaseExpiresAtMs: entry.leaseExpiresAtMs,
    prepared: entry.prepared,
    jointContainmentReceipt: entry.jointContainmentReceipt,
    committedThroughProviderSeq: entry.committedThroughProviderSeq,
    bufferedEvents: Object.freeze([...entry.buffered]),
    bufferedBytes: entry.bufferedBytes,
  });
}

/**
 * The lease's one expiry rule, shared verbatim by every path that may act on a reservation still pending
 * activation. Duplicating this check per call site is exactly how one of them could drift — e.g. keep
 * honouring a lease the other has already deemed expired — so both `renew` and `activate` route through it.
 */
function requireLeaseCurrent(entry: MutableEntry, nowMs: number): void {
  if (entry.state === 'pending-recovery' || nowMs >= entry.leaseExpiresAtMs) {
    // An expired reservation forbids the action but stays queryable, so control can still cancel exactly
    // this reservation rather than losing track of what it authorized.
    entry.state = 'pending-recovery';
    throw new LedgerError('reservation_expired', 'The activation lease expired.');
  }
}

export function createOperationLedger(): OperationLedger {
  const entries = new Map<string, MutableEntry>();
  let proxyBufferedBytes = 0;

  const require = (key: ProviderOperationKey): MutableEntry => {
    const entry = entries.get(keyOf(key));
    if (entry === undefined) {
      throw new LedgerError('operation_not_found', `No ledger entry for ${key.jobId}/${key.operationId}.`);
    }
    return entry;
  };

  return {
    prepare({ key, reservationId, activationNonce, prepared, nowMs }): PrepareResult {
      const existing = entries.get(keyOf(key));
      if (existing !== undefined) {
        // A repeat of the same prepare is the same request arriving twice — a dropped reply, a retry. It
        // returns the reservation already made; only a *different* payload for one identity is a conflict.
        if (existing.reservationId === reservationId && existing.activationNonce === activationNonce) {
          return { kind: 'reserved', entry: snapshot(existing) };
        }
        throw new LedgerError('operation_duplicate', `${key.jobId}/${key.operationId} is already reserved.`);
      }
      if (entries.size >= MAX_PROXY_OPERATION_LEDGERS) {
        return { kind: 'capacity', retryable: true, reason: 'operation-ledgers' };
      }
      if (proxyBufferedBytes >= MAX_PROXY_REPLAY_BYTES) {
        return { kind: 'capacity', retryable: true, reason: 'replay-bytes' };
      }
      const entry: MutableEntry = {
        key,
        state: 'pending-activation',
        reservationId,
        activationNonce,
        leaseExpiresAtMs: nowMs + PROXY_PENDING_ACTIVATION_LEASE_MS,
        prepared,
        jointContainmentReceipt: null,
        committedThroughProviderSeq: 0,
        buffered: [],
        bufferedBytes: 0,
        paused: false,
      };
      entries.set(keyOf(key), entry);
      return { kind: 'reserved', entry: snapshot(entry) };
    },

    recordContainmentReceipt(key, jointContainmentReceipt): void {
      const entry = require(key);
      entry.jointContainmentReceipt = jointContainmentReceipt;
    },

    renew(key, reservationId, nowMs): OperationLedgerEntry {
      const entry = require(key);
      if (entry.reservationId !== reservationId) {
        throw new LedgerError('reservation_mismatch', 'Renewal presented a different reservation.');
      }
      if (entry.state !== 'pending-activation' && entry.state !== 'pending-recovery') {
        throw new LedgerError('operation_invalid_transition', `Cannot renew from ${entry.state}.`);
      }
      requireLeaseCurrent(entry, nowMs);
      entry.leaseExpiresAtMs = nowMs + PROXY_PENDING_ACTIVATION_LEASE_MS;
      return snapshot(entry);
    },

    activate(key, reservationId, activationNonce, nowMs): void {
      const entry = require(key);
      if (entry.reservationId !== reservationId || entry.activationNonce !== activationNonce) {
        throw new LedgerError('reservation_mismatch', 'Activation presented a different reservation.');
      }
      // A repeat for an operation already executing is the same request arriving twice, not a new one: the
      // lease governs whether a reservation may *start*, so applying it here would let a late duplicate
      // demote a running kernel to pending-recovery and from there to released.
      if (entry.state === 'executing') return;
      requireLeaseCurrent(entry, nowMs);
      if (entry.state !== 'pending-activation') {
        throw new LedgerError('operation_invalid_transition', `Cannot activate from ${entry.state}.`);
      }
      entry.state = 'executing';
    },

    transition(key, next): void {
      const entry = require(key);
      if (!ALLOWED_TRANSITIONS[entry.state].includes(next)) {
        throw new LedgerError('operation_invalid_transition', `${entry.state} does not reach ${next}.`);
      }
      entry.state = next;
      if (next === 'released') {
        proxyBufferedBytes -= entry.bufferedBytes;
        entries.delete(keyOf(key));
      }
    },

    recordEvent(key, event): { paused: boolean } {
      const entry = require(key);
      const last = entry.buffered.at(-1);
      const floor = last?.providerSeq ?? entry.committedThroughProviderSeq;
      if (event.providerSeq <= floor) {
        throw new LedgerError('operation_invalid_transition', 'Provider sequence must increase monotonically.');
      }
      const cost = frameBytes(event);
      entry.buffered.push(event);
      entry.bufferedBytes += cost;
      proxyBufferedBytes += cost;
      // Pausing before a crossing is what keeps the buffer bounded; the ACK that frees capacity resumes it.
      entry.paused =
        entry.buffered.length >= MAX_PROVIDER_REPLAY_EVENTS ||
        entry.bufferedBytes >= MAX_PROVIDER_REPLAY_BYTES ||
        proxyBufferedBytes >= MAX_PROXY_REPLAY_BYTES;
      return { paused: entry.paused };
    },

    acknowledge(key, committedThroughProviderSeq): { resumed: boolean } {
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
      proxyBufferedBytes -= freed;
      entry.committedThroughProviderSeq = committedThroughProviderSeq;
      const wasPaused = entry.paused;
      entry.paused =
        entry.buffered.length >= MAX_PROVIDER_REPLAY_EVENTS ||
        entry.bufferedBytes >= MAX_PROVIDER_REPLAY_BYTES ||
        proxyBufferedBytes >= MAX_PROXY_REPLAY_BYTES;
      return { resumed: wasPaused && !entry.paused };
    },

    replayFrom(key, afterProviderSeq): readonly ReplayEvent[] {
      const entry = require(key);
      return Object.freeze(entry.buffered.filter((event) => event.providerSeq > afterProviderSeq));
    },

    get(key): OperationLedgerEntry | null {
      const entry = entries.get(keyOf(key));
      return entry === undefined ? null : snapshot(entry);
    },

    size(): number {
      return entries.size;
    },
  };
}
