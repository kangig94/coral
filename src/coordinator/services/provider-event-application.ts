import type { Database } from '../../store/db.js';
import { commitWithinOpenTransaction, type AppendContext, type CommitEventsFn } from '../../store/append.js';
import type { Runtime } from '../../runtime/ports.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import { appendJobTerminalRecorded } from '../../jobs/terminal/recording.js';
import { buildJobEventRefs } from '../../jobs/refs.js';
import { progressTimingFromProjection } from '../../jobs/progress-timing.js';
import {
  applyProviderEventAtSeq,
  ProviderEventDurableStateUncommittedError,
  type ApplyProviderEventBody,
  type ProviderEventEffectPort,
  type ProviderOperationEventIdentity,
} from '../../jobs/provider-event.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { ProviderInterruptionCause, ProviderStopCause } from '../../providers/contract.js';
import { isRecord } from '../../infra/json.js';
import { SessionManager } from '../../sessions/shell.js';
import { releaseSessionJobClaim, type SessionReleasedEmitter } from '../../sessions/job-release.js';
import type { SessionContinuityState } from '../../sessions/fault.js';
import { appendProviderTerminalInCommit, appendSessionInterruptedTerminalInCommit } from './terminal-materializer.js';
import type { ProviderEventHandler } from '../../provider-proxy/control-client.js';
import type { ProviderEventRequest, ProviderEventResult } from '../../provider-proxy/protocol.js';
import { compareAndSwapProviderOperation, readProviderOperation } from '../../store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '../../store/provider-operation-record.js';
import { notifyProviderOperationSettlementPending } from './provider-operation-reconciler.js';

/**
 * The coordinator's real `ProviderEventEffectPort` (W2.3, W2.5): the store-backed implementation of the seam
 * `applyProviderEventAtSeq` (`jobs/provider-event.ts`) is written against, and the RPC adapter that turns
 * `provider.event.v1` into a call on it. Lives in `coordinator/services/` — the same exemption
 * `terminal-materializer.ts` uses — because it composes three domains at once (jobs progress/terminal,
 * sessions continuity/claim, provider binding rehydration), which `coordinator/live/**` may not do freely
 * (`architecture-layering.test.ts`'s coordinator-contract-entrypoint rule); `jobs/provider-event.ts` itself
 * stays domain-pure and imports none of this.
 */

/**
 * `applyProviderEventAtSeq`'s opaque `Tx`. Manual `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` on `db`, not
 * `store/append.ts`'s `commit()` — `commit()` cannot nest (SQLite refuses a `BEGIN` inside an open
 * transaction), so `runInTransaction` below opens the one transaction the whole call runs in and every effect
 * composes into it through `commitWithinOpenTransaction`, `checkpointJobContinuityAtomic`/
 * `recordArtifactHandleAtomic` on a `SessionManager` bound to an in-transaction `CommitEventsFn`, or
 * `releaseSessionJobClaim` given that same adapter.
 *
 * `pendingInterruption` exists only because `applyProviderEventAtSeq` calls `appendSessionInterrupted` and
 * `appendJobTerminal` as two separate awaited port calls, but a truthful interrupted terminal is one
 * `causeRef`-linked commit: the terminal's outcome must reference the *same* `CauseRefToken` the interruption
 * fault minted, and tokens do not resolve across two separate `commitWithinOpenTransaction` calls (each
 * reserves its own `seq` batch). So `appendSessionInterrupted` only records the trigger on `tx`, and
 * `appendJobTerminal`'s `interrupted` branch performs the one combined append
 * (`appendSessionInterruptedTerminalInCommit`) that actually needs it.
 */
interface PortTx {
  readonly db: Database;
  pendingInterruption?: ProviderInterruptionCause;
}

export interface ProviderEventApplicationDeps {
  readonly db: Database;
  readonly progressStore: Pick<JobProgressStore, 'readStatus' | 'readLaunchProjection' | 'readRuntimeProjection'>;
  /** The same `AppendContext` (reducers/bodyCodec/providers/now) every other journal writer in this process
   *  composes against. Not derivable from `progressStore` alone — `JobStore` builds its own and keeps
   *  `providers`/`reducers` private, so the caller that already has one (composition) must supply it. */
  readonly appendContext: AppendContext;
  readonly providerRegistry: Pick<ProviderBindingCatalog, 'rehydrateBinding' | 'renderBindingFailure'>;
  readonly runtime: Runtime;
  readonly emitSessionReleased: SessionReleasedEmitter;
  /**
   * The stop cause the coordinator most recently sent as `operation.stop.v1` for this operation. The wire
   * `suspended` event carries no cause of its own (`{ kind: 'suspended', reason: 'interrupt_unconfirmed' }`),
   * so this is the only way a `suspended` event learns whether it followed a deliberate abort or a
   * restart/handoff that owes the job a truthful `session.interrupted` — the caller that issues
   * `operation.stop.v1` (the operation-activation orchestrator) is the one party that knows which. `null`
   * means no stop was ever recorded for this operation, which is a protocol violation, not a default to guess
   * through.
   */
  readonly recordedStopCauseFor: (identity: ProviderOperationEventIdentity) => ProviderStopCause | null;
  /**
   * Where a proxied operation's terminal (or interrupting suspension) reports back once it has durably
   * committed, so whatever registered the operation can let go of the in-process bookkeeping it still holds
   * for that job — its admission slot above all. `settled` receives the full identity, not just `jobId`,
   * because the registry and proxy ledger are both keyed by the
   * `(jobId, operationId)` pair. Composed in `coordinator/index.ts` beside where this whole
   * handler is built, from the same `LocalOperationRegistry` that also answers `recordedStopCauseFor` above.
   */
  readonly operations: { settled(identity: ProviderOperationEventIdentity): void };
}

function commitEventsWithinTx(db: Database, ctx: AppendContext): CommitEventsFn {
  return (cb) => commitWithinOpenTransaction(db, cb, ctx);
}

function sessionManagerWithinTx(deps: ProviderEventApplicationDeps, db: Database, projectRoot: string): SessionManager {
  return SessionManager.forProduction(
    projectRoot,
    deps.runtime,
    commitEventsWithinTx(db, deps.appendContext),
    deps.emitSessionReleased,
    { db },
  );
}

interface JobEventContext {
  readonly sessionId: string;
  readonly provider: string;
  readonly projectRoot: string;
  readonly namespace?: string;
  readonly project?: string;
}

/** Every effect below needs the job's current session/provider/scope facts; none of it is carried on
 *  `ProviderOperationEventIdentity` itself, so every port method re-derives it from the store. A job with no
 *  active provider session to apply against cannot be fixed by a replay, so this throws rather than asking
 *  for one. */
function resolveJobContext(deps: ProviderEventApplicationDeps, jobId: string): JobEventContext {
  const status = deps.progressStore.readStatus(jobId);
  if (status === null || status.sessionId === null || status.provider === null) {
    throw new Error(`Provider event for job '${jobId}' has no active provider session to apply against.`);
  }
  return {
    sessionId: status.sessionId,
    provider: status.provider,
    projectRoot: status.projectRoot,
    namespace: status.backendNamespace,
    project: status.projectRoot,
  };
}

function elapsedDurationMs(deps: ProviderEventApplicationDeps, jobId: string): number {
  const launch = deps.progressStore.readLaunchProjection(jobId);
  if (launch === null) return 0;
  const startedAt = Date.parse(launch.createdAt);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, deps.runtime.time.now() - startedAt);
}

function readJournalRecord(db: Database, identity: ProviderOperationEventIdentity): ProviderOperationRecord | null {
  return readProviderOperation(db, identity);
}

function requireJournalRecord(db: Database, identity: ProviderOperationEventIdentity): ProviderOperationRecord {
  const record = readJournalRecord(db, identity);
  if (record === null) {
    throw new Error(`No committed provider-operation saga for '${identity.jobId}'/'${identity.operationId}'.`);
  }
  return record;
}

function updateJournalRecord(db: Database, expected: ProviderOperationRecord, next: ProviderOperationRecord): void {
  const updated = compareAndSwapProviderOperation(db, expected, next);
  if (updated.kind === 'conflict') {
    throw new Error(
      `Provider-operation saga changed while applying an event for '${expected.operation.jobId}'/` +
        `'${expected.operation.operationId}'.`,
    );
  }
}

/**
 * Whether the interrupted session's own continuity survives the interruption. This port applies durably and
 * synchronously — it cannot perform the host-reachability check W1.6's `verified`/`unavailable` distinction
 * depends on without a network round trip mid-commit, which would tie a durable write to a foreign process
 * being reachable. So it answers only the question the store itself can prove: whether a checkpoint exists
 * to preserve. A resumable, committed continuity survives (`pre_checkpoint_preserved`); the plan states the
 * other case directly ("No committed snapshot means continuity `unavailable`").
 */
function derivedInterruptionContinuity(
  session: Readonly<{ providerContinuity: unknown; conversationRef?: string }> | null,
): SessionContinuityState {
  return session !== null && session.providerContinuity !== null && session.conversationRef !== undefined
    ? 'pre_checkpoint_preserved'
    : 'unavailable';
}

/**
 * Serializes provider-event transactions **per database connection**, keyed by the connection itself.
 *
 * The connection is what `BEGIN IMMEDIATE` is exclusive on, so the connection is what the chain has to be
 * scoped to. Holding this transaction open across an `await` — unlike the synchronous `withImmediate` it is
 * modelled on — means a second `BEGIN IMMEDIATE` issued while the first is open is refused by SQLite.
 *
 * Events arrive interleaved by design and by delivery, at two levels. Within one proxy, each operation's pump
 * runs concurrently over one socket and `control-client.ts` dispatches each inbound frame with
 * `void serveInboundRequest(...)` rather than awaiting it. Across proxies, `buildProviderEventHandler` is
 * called once per set — and two sets is the ordinary case, since Claude and Codex are distinct executable
 * identities — so a per-handler chain would leave each set serialized against itself and against nothing
 * else, on one shared connection.
 *
 * The failure it prevents is worse than a lost event: the refusal is neither an ack nor a replay, so the
 * proxy's drain loop stops on a reply it cannot read, and that operation's events sit buffered until
 * something else restarts its pump.
 *
 * A `WeakMap` so a closed connection's chain is collectable with it.
 */
const transactionChains = new WeakMap<Database, Promise<unknown>>();

export function createStoreProviderEventEffectPort(
  deps: ProviderEventApplicationDeps,
): ProviderEventEffectPort<PortTx> {
  return {
    runInTransaction: async (execute) => {
      const run = async (): Promise<unknown> => {
        deps.db.exec('BEGIN IMMEDIATE');
        const tx: PortTx = { db: deps.db };
        try {
          const result = await execute(tx);
          deps.db.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            deps.db.exec('ROLLBACK');
          } catch {
            // Preserve the original failure that triggered the rollback.
          }
          throw error;
        }
      };
      // The chain must survive a rejection, or one failed event would wedge every later one behind it.
      const pending = transactionChains.get(deps.db) ?? Promise.resolve();
      const settled = pending.then(run, run);
      transactionChains.set(
        deps.db,
        settled.catch(() => undefined),
      );
      return (await settled) as Awaited<ReturnType<typeof execute>>;
    },

    verifyIdentity: async (tx, identity) => {
      const record = readJournalRecord(tx.db, identity);
      return record?.phase === 'executing' || record?.phase === 'settlement-pending';
    },

    readWatermark: async (tx, identity) => {
      const record = requireJournalRecord(tx.db, identity);
      if (record.phase !== 'executing' && record.phase !== 'settlement-pending') {
        throw new Error(`Provider operation '${identity.jobId}'/'${identity.operationId}' is not accepting events.`);
      }
      return record.committedThroughProviderSeq;
    },

    advanceWatermark: async (tx, identity, seq) => {
      const record = requireJournalRecord(tx.db, identity);
      if (record.phase !== 'executing') {
        throw new Error(`Provider operation '${identity.jobId}'/'${identity.operationId}' is not executing.`);
      }
      const next = providerOperationRecordSchema.parse({
        ...record,
        committedThroughProviderSeq: seq,
        revision: record.revision + 1,
      });
      if (next.phase !== 'executing') throw new Error('Provider watermark transition failed validation.');
      updateJournalRecord(tx.db, record, next);
    },

    appendProgress: async (tx, identity, _seq, body) => {
      const ctx = resolveJobContext(deps, identity.jobId);
      const status = deps.progressStore.readStatus(identity.jobId);
      const launch = deps.progressStore.readLaunchProjection(identity.jobId);
      const runtimeProjection = deps.progressStore.readRuntimeProjection(identity.jobId);
      const timing = progressTimingFromProjection(
        {
          status: status === null ? null : { phase: status.phase, updatedAt: status.updatedAt },
          runtime: runtimeProjection === null ? null : { startTime: runtimeProjection.startTime },
          launch: launch === null ? null : { createdAt: launch.createdAt },
        },
        deps.runtime.time.now(),
      );
      commitWithinOpenTransaction(
        tx.db,
        (c) => {
          c.append({
            type: 'job.progress.emitted',
            stream: { kind: 'job', id: identity.jobId },
            namespace: ctx.namespace,
            project: ctx.project,
            refs: buildJobEventRefs({ jobId: identity.jobId, sessionId: ctx.sessionId }),
            body: { kind: 'message', message: body.message, timing },
          });
          return undefined;
        },
        deps.appendContext,
      );
    },

    appendSessionEvent: async (tx, identity, _seq, body) => {
      const ctx = resolveJobContext(deps, identity.jobId);
      const manager = sessionManagerWithinTx(deps, tx.db, ctx.projectRoot);
      const session = manager.get(ctx.provider, ctx.sessionId);
      if (session === null || session.activeJobId !== identity.jobId) {
        throw new Error(`Job '${identity.jobId}' no longer holds the active claim on session '${ctx.sessionId}'.`);
      }

      if (body.kind === 'continuity') {
        const bound = deps.providerRegistry.rehydrateBinding(session.binding);
        if (!bound.ok) {
          throw new Error(
            `Cannot rehydrate the provider binding for job '${identity.jobId}': ${deps.providerRegistry.renderBindingFailure(bound.failure)}`,
          );
        }
        const decoded = bound.value.decodeContinuity(body.providerContinuity);
        if (!decoded.ok) {
          throw new Error(
            `Provider emitted invalid continuity for job '${identity.jobId}': ${deps.providerRegistry.renderBindingFailure(decoded.failure)}`,
          );
        }
        const result = await manager.checkpointJobContinuityAtomic(ctx.sessionId, {
          expectedActiveJobId: identity.jobId,
          expectedVersion: session.version,
          snapshot: {
            conversationRef: body.conversationRef,
            resumable: body.resumable,
            providerContinuity: isRecord(decoded.value) ? decoded.value : null,
          },
        });
        if (!result.ok) throw new ProviderEventDurableStateUncommittedError();
        return;
      }

      const result = await manager.recordArtifactHandleAtomic(ctx.sessionId, {
        expectedActiveJobId: identity.jobId,
        expectedVersion: session.version,
        handle: body.handle,
        identity: body.identity,
        sourceJobId: identity.jobId,
      });
      if (!result.ok) throw new ProviderEventDurableStateUncommittedError();
    },

    appendJobTerminal: async (tx, identity, _seq, disposition) => {
      const ctx = resolveJobContext(deps, identity.jobId);
      const durationMs = elapsedDurationMs(deps, identity.jobId);
      const options = {
        jobId: identity.jobId,
        sessionId: ctx.sessionId,
        namespace: ctx.namespace,
        project: ctx.project,
      };

      if (disposition.kind === 'direct') {
        commitWithinOpenTransaction(
          tx.db,
          (c) => {
            appendProviderTerminalInCommit(c, disposition.body, options);
            return undefined;
          },
          deps.appendContext,
        );
        return;
      }

      if (disposition.kind === 'abort') {
        commitWithinOpenTransaction(
          tx.db,
          (c) => {
            appendJobTerminalRecorded(c, {
              ...options,
              terminal: { content: '', durationMs, outcome: { kind: 'aborted', reason: disposition.reason } },
            });
            return undefined;
          },
          deps.appendContext,
        );
        return;
      }

      const trigger = tx.pendingInterruption;
      if (trigger === undefined) {
        throw new Error(
          `Interrupted terminal for job '${identity.jobId}' has no recorded interruption trigger — ` +
            `appendSessionInterrupted must run first in the same transaction.`,
        );
      }
      const session = sessionManagerWithinTx(deps, tx.db, ctx.projectRoot).get(ctx.provider, ctx.sessionId);
      const continuity = derivedInterruptionContinuity(session);
      commitWithinOpenTransaction(
        tx.db,
        (c) => {
          appendSessionInterruptedTerminalInCommit(c, { trigger, continuity }, options, { content: '', durationMs });
          return undefined;
        },
        deps.appendContext,
      );
      tx.pendingInterruption = undefined;
    },

    markSettlementPending: async (tx, identity, terminalProviderSeq) => {
      const record = requireJournalRecord(tx.db, identity);
      if (record.phase !== 'executing' || record.committedThroughProviderSeq !== terminalProviderSeq) {
        throw new Error(
          `Provider operation '${identity.jobId}'/'${identity.operationId}' did not commit its terminal watermark.`,
        );
      }
      const { controlIntent: _controlIntent, ...settlementRecord } = record;
      const next = providerOperationRecordSchema.parse({
        ...settlementRecord,
        phase: 'settlement-pending',
        terminalProviderSeq,
        settlementIntent: 'release-after-terminal',
        revision: record.revision + 1,
        retryNotBeforeMs: deps.runtime.time.now(),
        retryCount: 0,
        lastError: null,
      });
      updateJournalRecord(tx.db, record, next);
    },

    appendSessionInterrupted: async (tx, _identity, _seq, trigger) => {
      // Recorded, not appended: see the `PortTx.pendingInterruption` doc for why the actual combined append
      // happens in `appendJobTerminal`'s `interrupted` branch instead.
      tx.pendingInterruption = trigger;
    },

    releaseSessionClaim: async (tx, identity) => {
      const ctx = resolveJobContext(deps, identity.jobId);
      releaseSessionJobClaim({
        projectRoot: ctx.projectRoot,
        runtime: deps.runtime,
        db: tx.db,
        commitEvents: commitEventsWithinTx(tx.db, deps.appendContext),
        emitSessionReleased: deps.emitSessionReleased,
        sessionId: ctx.sessionId,
        jobId: identity.jobId,
      });
    },
  };
}

/**
 * Adapts the wire `suspended` event (which carries no cause of its own) into the port's
 * `ApplyProviderEventBody`, which requires one inline. See `ProviderEventApplicationDeps.recordedStopCauseFor`.
 */
function toApplyProviderEventBody(
  deps: ProviderEventApplicationDeps,
  identity: ProviderOperationEventIdentity,
  event: ProviderEventRequest['event'],
): ApplyProviderEventBody {
  if (event.kind !== 'suspended') return event;
  const recordedStopCause = deps.recordedStopCauseFor(identity);
  if (recordedStopCause === null) {
    throw new Error(
      `Received a suspended provider event for job '${identity.jobId}' with no recorded operation.stop.v1 cause.`,
    );
  }
  return { ...event, recordedStopCause };
}

/**
 * The RPC stream adapter (W2.3, W2.5): wires an inbound `provider.event.v1` request into
 * `applyProviderEventAtSeq`. `applyProviderEventAtSeq`'s promise settles only after its transaction commits
 * (`ProviderEventEffectPort.runInTransaction`'s own contract), so the `{ kind: 'ack', ... }` this returns can
 * only ever be observed by the caller after a durable commit — there is no earlier point at which this
 * function could answer `ack`. A thrown identity mismatch, invalid-seq, or effect error propagates as a
 * rejected promise; `connectControlClient`'s `serveInboundRequest` turns that into a `protocol_violation`
 * wire error rather than an `ack` or `replay`, which is the correct answer for a proxy sending something this
 * seam cannot apply.
 */
export function createProviderEventHandler(deps: ProviderEventApplicationDeps): ProviderEventHandler {
  const port = createStoreProviderEventEffectPort(deps);
  return async (request: ProviderEventRequest): Promise<ProviderEventResult> => {
    const identity: ProviderOperationEventIdentity = request.operation;
    const event = toApplyProviderEventBody(deps, identity, request.event);
    const result = await applyProviderEventAtSeq(port, { identity, seq: request.providerSeq, event });
    // A proxied operation never returns through `executeJob`'s local finalization, so this is the only moment
    // anything learns it is over. Without it the launcher holds that job's admission slot forever and the
    // daemon stops accepting work once the pool fills — durable state perfectly correct, coordinator dead.
    //
    // The condition is on what durably happened, not on what arrived. `replay` returns before `applyEffect`
    // runs, so a terminal that lands on a sequence gap has ended nothing and must not release a slot the
    // operation is still using. And `suspended` ends a job exactly as `terminal` does — it appends the job
    // terminal and releases the session claim — so keying on `terminal` alone leaks every aborted and every
    // interrupted proxied operation.
    const endedTheJob = event.kind === 'terminal' || event.kind === 'suspended';
    if (result.kind === 'ack' && endedTheJob) {
      notifyProviderOperationSettlementPending(identity);
      deps.operations.settled(identity);
    }
    return result;
  };
}
