import { assertNever } from '../infra/error-format.js';
import {
  isAbortStopCause,
  type ProviderArtifactHandleEventBody,
  type ProviderContinuityEventBody,
  type ProviderEventBody,
  type ProviderProgressEventBody,
  type ProviderStopCause,
  type ProviderTerminalEventBody,
} from '../providers/contract.js';
import type { AbortReason } from './outcome.js';

/** The complete identity `applyProviderEventAtSeq` verifies before it is willing to write anything. */
export interface ProviderOperationEventIdentity {
  readonly jobId: string;
  readonly operationId: string;
  readonly proxyInstanceId: string;
  readonly buildSetId: string;
}

export class ProviderEventIdentityMismatchError extends Error {
  readonly identity: ProviderOperationEventIdentity;

  constructor(identity: ProviderOperationEventIdentity) {
    super(
      `Provider event identity mismatch for job '${identity.jobId}' operation '${identity.operationId}' ` +
        `(proxy '${identity.proxyInstanceId}', build set '${identity.buildSetId}').`,
    );
    this.identity = identity;
    this.name = 'ProviderEventIdentityMismatchError';
    Object.setPrototypeOf(this, ProviderEventIdentityMismatchError.prototype);
  }
}

/**
 * An injected write port throws this — instead of a generic error or a false ack — when the durable state an
 * effect depends on (for example a committed continuity checkpoint) is not yet durable. It is the one failure
 * mode `applyProviderEventAtSeq` translates into an explicit replay request rather than letting the
 * transaction's rejection propagate: the coordinator knows exactly what happened instead of guessing from a
 * dropped connection.
 */
export class ProviderEventDurableStateUncommittedError extends Error {
  constructor() {
    super('durable_state_uncommitted');
    this.name = 'ProviderEventDurableStateUncommittedError';
    Object.setPrototypeOf(this, ProviderEventDurableStateUncommittedError.prototype);
  }
}

/**
 * How a `suspended` event's job terminal must be produced. `interrupted` and `abort` exist because a
 * `suspended` body (`{ kind: 'suspended', reason: 'interrupt_unconfirmed' }`) carries no terminal content of
 * its own — the durable decision is derived from the recorded `operation.stop.v1` cause, not from the wire
 * event.
 */
export type TerminalDisposition =
  | { readonly kind: 'direct'; readonly body: ProviderTerminalEventBody }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'abort'; readonly reason: AbortReason };

/**
 * The transactional seam a real store implements. `Tx` is opaque here on purpose: this module never opens a
 * database, so every effect is expressed as "call this with the transaction handle you were given."
 */
export interface ProviderEventEffectPort<Tx> {
  /** Runs `execute` inside one `BEGIN IMMEDIATE` transaction: commits on resolve, rolls back and rethrows on reject. */
  readonly runInTransaction: <T>(execute: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Confirms job, operation, proxy instance, and build set together still identify one live operation. */
  readonly verifyIdentity: (tx: Tx, identity: ProviderOperationEventIdentity) => Promise<boolean>;
  readonly readWatermark: (tx: Tx, identity: ProviderOperationEventIdentity) => Promise<number>;
  /** The last write of an applying transaction — every effect above it must already be durable in the same commit. */
  readonly advanceWatermark: (tx: Tx, identity: ProviderOperationEventIdentity, seq: number) => Promise<void>;
  readonly appendProgress: (
    tx: Tx,
    identity: ProviderOperationEventIdentity,
    seq: number,
    body: ProviderProgressEventBody,
  ) => Promise<void>;
  /** Continuity and artifact events both append to the session stream. */
  readonly appendSessionEvent: (
    tx: Tx,
    identity: ProviderOperationEventIdentity,
    seq: number,
    body: ProviderContinuityEventBody | ProviderArtifactHandleEventBody,
  ) => Promise<void>;
  readonly appendJobTerminal: (
    tx: Tx,
    identity: ProviderOperationEventIdentity,
    seq: number,
    disposition: TerminalDisposition,
  ) => Promise<void>;
  readonly appendSessionInterrupted: (tx: Tx, identity: ProviderOperationEventIdentity, seq: number) => Promise<void>;
  /** Releases the exact session claim this operation holds. Must run before `advanceWatermark` in the same transaction. */
  readonly releaseSessionClaim: (tx: Tx, identity: ProviderOperationEventIdentity) => Promise<void>;
}

export interface ApplyProviderEventInput {
  readonly identity: ProviderOperationEventIdentity;
  readonly seq: number;
  readonly event: ProviderEventBody;
  /**
   * The `operation.stop.v1` cause that produced this event. Required if and only if `event.kind === 'suspended'`
   * — every other event kind carries its own durable content and needs no external cause.
   */
  readonly recordedStopCause?: ProviderStopCause;
}

export type ApplyProviderEventResult =
  | { readonly kind: 'ack'; readonly committedThroughProviderSeq: number }
  | {
      readonly kind: 'replay';
      readonly replayFromProviderSeq: number;
      readonly reason: 'sequence_gap' | 'durable_state_uncommitted';
    };

/**
 * The single seam through which a provider event becomes durable (W2.3, W2.5). Verifies the complete
 * identity, then — inside one `BEGIN IMMEDIATE` — treats `seq` against the durable watermark: `seq <=
 * watermark` is effect-free and acknowledges the current watermark (the "cumulative ACK reply is lost after
 * commit" row: a replay must change nothing), `seq === watermark + 1` applies the event and advances the
 * watermark atomically, and any larger `seq` is a gap that requests replay without writing anything. The ACK
 * is the function returning normally; a rejected promise means the transaction rolled back and produced
 * neither an ACK nor a claim release (the "journal transaction rolls back" row) — the caller never has to
 * inspect the database to tell the two apart.
 */
export async function applyProviderEventAtSeq<Tx>(
  port: ProviderEventEffectPort<Tx>,
  input: ApplyProviderEventInput,
): Promise<ApplyProviderEventResult> {
  const { identity, seq, event, recordedStopCause } = input;
  let watermarkAtRead: number | undefined;

  try {
    return await port.runInTransaction(async (tx) => {
      const identityVerified = await port.verifyIdentity(tx, identity);
      if (!identityVerified) {
        throw new ProviderEventIdentityMismatchError(identity);
      }

      const watermark = await port.readWatermark(tx, identity);
      watermarkAtRead = watermark;

      if (seq <= watermark) {
        return { kind: 'ack', committedThroughProviderSeq: watermark };
      }

      if (seq > watermark + 1) {
        return { kind: 'replay', replayFromProviderSeq: watermark + 1, reason: 'sequence_gap' };
      }

      await applyEffect(port, tx, identity, seq, event, recordedStopCause);
      await port.advanceWatermark(tx, identity, seq);
      return { kind: 'ack', committedThroughProviderSeq: seq };
    });
  } catch (error) {
    if (error instanceof ProviderEventDurableStateUncommittedError && watermarkAtRead !== undefined) {
      return { kind: 'replay', replayFromProviderSeq: watermarkAtRead + 1, reason: 'durable_state_uncommitted' };
    }
    throw error;
  }
}

async function applyEffect<Tx>(
  port: ProviderEventEffectPort<Tx>,
  tx: Tx,
  identity: ProviderOperationEventIdentity,
  seq: number,
  event: ProviderEventBody,
  recordedStopCause: ProviderStopCause | undefined,
): Promise<void> {
  switch (event.kind) {
    case 'progress':
      await port.appendProgress(tx, identity, seq, event);
      return;
    case 'continuity':
    case 'artifact_handle':
      await port.appendSessionEvent(tx, identity, seq, event);
      return;
    case 'terminal':
      await port.appendJobTerminal(tx, identity, seq, { kind: 'direct', body: event });
      await port.releaseSessionClaim(tx, identity);
      return;
    case 'suspended':
      await applySuspendedEffect(port, tx, identity, seq, recordedStopCause);
      return;
    default:
      assertNever(event);
  }
}

/**
 * A `suspended` event means the proxy could not confirm whether its interrupt landed. `restart`/`handoff`
 * owe the job a truthful `session.interrupted` before its terminal; the three abort causes were deliberate
 * stops, so writing `session.interrupted` for them would record an interruption nobody suffered — they get
 * only the existing abort terminal. Both paths still release the claim in the same transaction as a direct
 * terminal does.
 */
async function applySuspendedEffect<Tx>(
  port: ProviderEventEffectPort<Tx>,
  tx: Tx,
  identity: ProviderOperationEventIdentity,
  seq: number,
  recordedStopCause: ProviderStopCause | undefined,
): Promise<void> {
  if (recordedStopCause === undefined) {
    throw new Error('applyProviderEventAtSeq: a suspended event requires the recorded operation.stop.v1 cause.');
  }

  if (isAbortStopCause(recordedStopCause)) {
    await port.appendJobTerminal(tx, identity, seq, { kind: 'abort', reason: recordedStopCause });
  } else {
    await port.appendSessionInterrupted(tx, identity, seq);
    await port.appendJobTerminal(tx, identity, seq, { kind: 'interrupted' });
  }
  await port.releaseSessionClaim(tx, identity);
}
