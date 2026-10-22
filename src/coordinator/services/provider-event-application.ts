import type { Database } from '../../store/db.js';
import {
  commitWithinOpenTransaction,
  type AppendContext,
  type AppendedEvent,
  type PostCommitObserver,
} from '../../store/append.js';
import type { ExecutionFinisher } from '../../jobs/finishing.js';
import type { Runtime } from '../../runtime/ports.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import { appendJobExecutionOutcomeAccepted } from '../../jobs/terminal/recording.js';
import { buildJobEventRefs } from '../../jobs/refs.js';
import { progressTimingFromProjection } from '../../jobs/progress-timing.js';
import {
  applyProviderEventAtSeq,
  type ApplyProviderEventBody,
  type ProviderEventEffectPort,
  type ProviderOperationEventIdentity,
} from '../../jobs/provider-event.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { ProviderInterruptionCause, ProviderStopCause } from '../../providers/contract.js';
import { providerProxyRekeyRefusalEvent } from '../../providers/proxy-failure.js';
import { isRecord } from '../../infra/json.js';
import type { SessionContinuityState } from '../../sessions/fault.js';
import { decodeBody } from '../../store/body-codec.js';
import { readJobOpened, readLatestExecutionRequest } from '../../jobs/execution-state.js';
import { jobContinuityCheckpointedBodySchema } from '../../jobs/event-bodies.js';
import { providerArtifactIdentityKey } from '../../providers/artifact-identity.js';
import { appendProviderTerminalInCommit, appendSessionInterruptedTerminalInCommit } from './terminal-materializer.js';
import type { ProviderEventHandler } from '../../provider-proxy/control-client.js';
import type { ProviderEventRequest, ProviderEventResult } from '../../provider-proxy/protocol.js';
import {
  compareAndSwapProviderOperation,
  providerOperationMutationAdmission,
  readProviderOperation,
} from '../../store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '../../store/provider-operation-record.js';
import { notifyProviderOperationSettlementPending } from './provider-operation-reconciler.js';

interface PortTx {
  readonly db: Database;
  /** Every batch committed directly on a job stream inside this transaction, handed on once it commits. */
  readonly appended: AppendedEvent[];
  pendingInterruption?: ProviderInterruptionCause;
}

export interface ProviderEventApplicationDeps {
  readonly executionFinisher: ExecutionFinisher;
  readonly db: Database;
  readonly progressStore: Pick<JobProgressStore, 'readStatus' | 'readLaunchProjection' | 'readRuntimeProjection'>;
  /** The same `AppendContext` (reducers/bodyCodec/providers/now) every other journal writer in this process
   *  composes against. Not derivable from `progressStore` alone — `JobStore` builds its own and keeps
   *  `providers`/`reducers` private, so the caller that already has one (composition) must supply it. */
  readonly appendContext: AppendContext;
  readonly providerRegistry: Pick<ProviderBindingCatalog, 'rehydrateBinding' | 'renderBindingFailure'>;
  readonly runtime: Runtime;
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
   * Receives the job-stream batches this handler commits, only after `COMMIT`. This handler commits on the
   * raw database and reaches no other post-commit observer, so a job terminal it records owes its effects to
   * this call alone.
   */
  readonly observeCommitted: PostCommitObserver;
}

function eventReadContext(deps: ProviderEventApplicationDeps) {
  return {
    schemas: deps.appendContext.reducers.schemas,
    streamKinds: deps.appendContext.reducers.streamKinds,
    bodyCodec: deps.appendContext.bodyCodec,
  };
}

function resolveJobContext(deps: ProviderEventApplicationDeps, jobId: string) {
  const readCtx = eventReadContext(deps);
  const job = readJobOpened(deps.db, jobId, readCtx);
  const request = readLatestExecutionRequest(deps.db, jobId, readCtx);
  if (job?.jobKind !== 'provider' || request === null)
    throw new Error(`Provider event for job '${jobId}' has no requested provider execution.`);
  return {
    execution: request.request.execution,
    provider: job.conversation.provider,
    binding: job.conversation.binding,
    projectRoot: job.projectRoot,
    namespace: request.request.backendNamespace,
    project: job.projectRoot,
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

function derivedInterruptionContinuity(deps: ProviderEventApplicationDeps, jobId: string): SessionContinuityState {
  const row = deps.db
    .prepare<
      [string],
      { type: string; stream_kind: 'job'; body: Uint8Array }
    >("SELECT type, stream_kind, body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.continuity.checkpointed' ORDER BY seq DESC LIMIT 1")
    .get(jobId);
  if (row === undefined) return 'unavailable';
  const { snapshot } = decodeBody(row, jobContinuityCheckpointedBodySchema, eventReadContext(deps));
  return snapshot.conversationRef !== null ? 'pre_checkpoint_preserved' : 'unavailable';
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
  const mutationAdmission = providerOperationMutationAdmission(deps.db);
  const commitInTx = (tx: PortTx, cb: Parameters<typeof commitWithinOpenTransaction>[1]): void => {
    tx.appended.push(...commitWithinOpenTransaction(tx.db, cb, deps.appendContext));
  };
  return {
    runInTransaction: (execute) =>
      mutationAdmission.run('provider-event-transaction', async () => {
        const run = async (): Promise<unknown> => {
          deps.db.exec('BEGIN IMMEDIATE');
          const tx: PortTx = { db: deps.db, appended: [] };
          let result: unknown;
          try {
            result = await execute(tx);
            deps.db.exec('COMMIT');
          } catch (error) {
            try {
              deps.db.exec('ROLLBACK');
            } catch {
              // Preserve the original failure that triggered the rollback.
            }
            throw error;
          }
          // Outside the guard above: the transaction is durable here, and a failure from an observer must
          // not reach a ROLLBACK issued against it.
          deps.observeCommitted(tx.appended);
          return result;
        };
        // The chain must survive a rejection, or one failed event would wedge every later one behind it.
        const pending = transactionChains.get(deps.db) ?? Promise.resolve();
        const settled = pending.then(run, run);
        transactionChains.set(
          deps.db,
          settled.catch(() => undefined),
        );
        return (await settled) as Awaited<ReturnType<typeof execute>>;
      }),

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
      commitInTx(tx, (c) => {
        c.append({
          type: 'job.execution.progress',
          stream: { kind: 'job', id: identity.jobId },
          namespace: ctx.namespace,
          project: ctx.project,
          refs: buildJobEventRefs({ jobId: identity.jobId }),
          body: { execution: ctx.execution, kind: 'message', message: body.message, timing },
        });
        return undefined;
      });
    },

    appendConversationEvent: async (tx, identity, _seq, body) => {
      const ctx = resolveJobContext(deps, identity.jobId);
      if (body.kind === 'continuity') {
        const bound = deps.providerRegistry.rehydrateBinding(ctx.binding);
        if (!bound.ok) throw new Error(deps.providerRegistry.renderBindingFailure(bound.failure));
        const decoded = bound.value.decodeContinuity(body.providerContinuity);
        if (!decoded.ok) throw new Error(deps.providerRegistry.renderBindingFailure(decoded.failure));
        commitInTx(tx, (c) => {
          c.append({
            type: 'job.continuity.checkpointed',
            stream: { kind: 'job', id: identity.jobId },
            body: {
              execution: ctx.execution,
              snapshot: {
                conversationRef: body.conversationRef,
                resumable: body.resumable,
                providerContinuity: isRecord(decoded.value) ? decoded.value : null,
              },
            },
          });
          return undefined;
        });
      } else {
        commitInTx(tx, (c) => {
          c.append({
            type: 'job.artifact.recorded',
            stream: { kind: 'job', id: identity.jobId },
            body: {
              execution: ctx.execution,
              provider: ctx.provider,
              handle: body.handle,
              identity: body.identity,
              identityKey: providerArtifactIdentityKey(ctx.provider, body.identity),
            },
          });
          return undefined;
        });
      }
    },

    acceptExecutionOutcome: async (tx, identity, _seq, disposition) => {
      const ctx = resolveJobContext(deps, identity.jobId);
      const durationMs = elapsedDurationMs(deps, identity.jobId);
      const options = {
        jobId: identity.jobId,
        execution: ctx.execution,
        namespace: ctx.namespace,
        project: ctx.project,
      };

      if (disposition.kind === 'direct') {
        commitInTx(tx, (c) => {
          appendProviderTerminalInCommit(c, disposition.body, options);
          return undefined;
        });
        return;
      }

      if (disposition.kind === 'abort') {
        commitInTx(tx, (c) => {
          appendJobExecutionOutcomeAccepted(c, {
            ...options,
            terminal: { content: '', durationMs, outcome: { kind: 'aborted', reason: disposition.reason } },
          });
          return undefined;
        });
        return;
      }

      const trigger = tx.pendingInterruption;
      if (trigger === undefined) {
        throw new Error(
          `Interrupted terminal for job '${identity.jobId}' has no recorded interruption trigger — ` +
            `appendJobInterrupted must run first in the same transaction.`,
        );
      }
      const continuity = derivedInterruptionContinuity(deps, identity.jobId);
      commitInTx(tx, (c) => {
        appendSessionInterruptedTerminalInCommit(c, { trigger, continuity }, options, { content: '', durationMs });
        return undefined;
      });
      tx.pendingInterruption = undefined;
    },

    markSettlementPending: async (tx, identity, terminalProviderSeq) => {
      const record = requireJournalRecord(tx.db, identity);
      if (record.phase !== 'executing' || record.committedThroughProviderSeq !== terminalProviderSeq) {
        throw new Error(
          `Provider operation '${identity.jobId}'/'${identity.operationId}' did not commit its terminal watermark.`,
        );
      }
      const next = providerOperationRecordSchema.parse({
        ...record,
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

    appendJobInterrupted: async (tx, _identity, _seq, trigger) => {
      tx.pendingInterruption = trigger;
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
  if (event.kind === 'terminal' || event.kind === 'suspended') {
    const record = readJournalRecord(deps.db, identity);
    if (
      (record?.phase === 'executing' || record?.phase === 'settlement-pending') &&
      record.controlIntent.kind === 'rekey-refusal-containment'
    ) {
      return providerProxyRekeyRefusalEvent(
        resolveJobContext(deps, identity.jobId).provider,
        record.controlIntent.reason,
      );
    }
  }
  if (event.kind !== 'suspended') return event;
  const recordedStopCause = deps.recordedStopCauseFor(identity);
  if (recordedStopCause === null) {
    throw new Error(
      `Received a suspended provider event for job '${identity.jobId}' with no recorded operation.stop.v1 cause.`,
    );
  }
  if (recordedStopCause === 'coordinator_rekey_refused') {
    return providerProxyRekeyRefusalEvent(resolveJobContext(deps, identity.jobId).provider);
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
  const mutationAdmission = providerOperationMutationAdmission(deps.db);
  return (request: ProviderEventRequest): Promise<ProviderEventResult> =>
    mutationAdmission.run(
      `provider-event:${request.operation.jobId}:${request.operation.operationId}:${request.providerSeq}`,
      async () => {
        const identity: ProviderOperationEventIdentity = request.operation;
        const event = toApplyProviderEventBody(deps, identity, request.event);
        const result = await applyProviderEventAtSeq(port, { identity, seq: request.providerSeq, event });
        const acceptedOutcome = event.kind === 'terminal' || event.kind === 'suspended';
        if (result.kind === 'ack' && acceptedOutcome) {
          notifyProviderOperationSettlementPending(identity);
          const { execution } = resolveJobContext(deps, identity.jobId);
          void deps.executionFinisher.finish({ jobId: identity.jobId, execution });
        }
        return result;
      },
      request.operation,
    );
}
