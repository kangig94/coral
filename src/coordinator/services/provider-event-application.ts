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
import { readProviderOperationRuntimeMeta, writeProviderOperationRuntimeMeta } from '../../jobs/runtime-meta-store.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { ProviderInterruptionCause, ProviderStopCause } from '../../providers/contract.js';
import { isRecord } from '../../infra/json.js';
import { SessionManager } from '../../sessions/shell.js';
import { releaseSessionJobClaim, type SessionReleasedEmitter } from '../../sessions/job-release.js';
import type { SessionContinuityState } from '../../sessions/fault.js';
import { appendProviderTerminalInCommit, appendSessionInterruptedTerminalInCommit } from './terminal-materializer.js';
import type { ProviderEventHandler } from '../../provider-proxy/control-client.js';
import type { ProviderEventRequest, ProviderEventResult } from '../../provider-proxy/protocol.js';

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

function readMeta(db: Database, identity: ProviderOperationEventIdentity) {
  return readProviderOperationRuntimeMeta(db, identity.jobId, identity.operationId);
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
 * Builds the real store-backed `ProviderEventEffectPort` — the production implementation of the seam
 * `applyProviderEventAtSeq` was built against, with no production caller until this module and its RPC
 * adapter below are wired into a live proxy control connection.
 */
export function createStoreProviderEventEffectPort(
  deps: ProviderEventApplicationDeps,
): ProviderEventEffectPort<PortTx> {
  /**
   * Serializes transactions on this connection, because this one is held open across an `await` and
   * `withImmediate`'s synchronous version is not.
   *
   * The events that reach here are concurrent by design and by delivery. The proxy drains each operation
   * sequentially but runs different operations' pumps at the same time over one socket, and
   * `control-client.ts` dispatches each inbound frame with `void serveInboundRequest(...)` rather than
   * awaiting it — so two events genuinely arrive interleaved. Without this chain the second would issue
   * `BEGIN IMMEDIATE` while the first still held one, and SQLite refuses a transaction inside a transaction.
   * That failure is worse than it first looks: the event gets no ACK, and the proxy's drain loop stops on a
   * reply it cannot read as ack-or-replay, leaving that operation's events buffered until something else
   * happens to restart its pump.
   */
  let transactions: Promise<unknown> = Promise.resolve();

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
          deps.db.exec('ROLLBACK');
          throw error;
        }
      };
      // The chain must survive a rejection, or one failed event would wedge every later one behind it.
      const settled = transactions.then(run, run);
      transactions = settled.catch(() => undefined);
      return (await settled) as Awaited<ReturnType<typeof execute>>;
    },

    verifyIdentity: async (tx, identity) => {
      const meta = readMeta(tx.db, identity);
      return (
        meta !== null && meta.buildSetId === identity.buildSetId && meta.proxyInstanceId === identity.proxyInstanceId
      );
    },

    readWatermark: async (tx, identity) => {
      const meta = readMeta(tx.db, identity);
      if (meta === null) {
        // `verifyIdentity` already refused an absent locator before this can be reached in the real
        // `applyProviderEventAtSeq` sequence; a null read here means the locator vanished mid-transaction.
        throw new Error(`No committed runtime meta for operation '${identity.jobId}'/'${identity.operationId}'.`);
      }
      return meta.committedThroughProviderSeq;
    },

    advanceWatermark: async (tx, identity, seq) => {
      const meta = readMeta(tx.db, identity);
      if (meta === null) {
        throw new Error(`No committed runtime meta for operation '${identity.jobId}'/'${identity.operationId}'.`);
      }
      writeProviderOperationRuntimeMeta(tx.db, { ...meta, committedThroughProviderSeq: seq });
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

      // disposition.kind === 'interrupted'
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
    return applyProviderEventAtSeq(port, { identity, seq: request.providerSeq, event });
  };
}
