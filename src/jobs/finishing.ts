import type { TimePort } from '../infra/port-types.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { PostCommitObserver } from '../store/append.js';
import type { CommitEventsFn } from '../store/append.js';
import type { Database } from '../store/db.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import { jobExecutionRequestedBodySchema, type JobOpenedBody } from './launch.js';
import { readJobOpened } from './execution-state.js';
import {
  jobRetentionDiscardRequestedBodySchema,
  jobRetentionDiscardCompletedBodySchema,
  jobRetentionDiscardFailedBodySchema,
  type JobRetentionDiscardRequestedBody,
} from './event-bodies.js';
import {
  jobExecutionEndedBodySchema,
  jobExecutionOutcomeAcceptedBodySchema,
  type JobExecutionOutcomeAcceptedBody,
} from './terminal/result.js';
import { appendJobExecutionEnded } from './terminal/recording.js';

export interface ExecutionAddress {
  readonly jobId: string;
  readonly execution: number;
}

interface AcceptedExecution {
  readonly job: JobOpenedBody;
  readonly accepted: JobExecutionOutcomeAcceptedBody;
  readonly causeRef: CauseRef;
  readonly retention: JobRetentionDiscardRequestedBody | null;
  readonly retentionClosed: boolean;
}

export type ExecutionFinishingState =
  | { readonly kind: 'unaccepted' }
  | ({ readonly kind: 'finishing' | 'ended' } & AcceptedExecution);

export function readExecutionFinishingState(
  db: Database,
  address: ExecutionAddress,
  ctx: StoreReadContext,
): ExecutionFinishingState {
  const job = readJobOpened(db, address.jobId, ctx);
  if (job === null) throw new Error(`Job '${address.jobId}' is not opened.`);
  const rows = db
    .prepare<[string], { seq: number; type: string; stream_kind: 'job'; body: Uint8Array }>(
      `SELECT seq, type, stream_kind, body FROM events WHERE stream_kind = 'job' AND stream_id = ?
     AND type IN ('job.execution.requested', 'job.execution.outcome.accepted', 'job.execution.ended',
       'job.retention.discard.requested', 'job.retention.discard.completed', 'job.retention.discard.failed') ORDER BY seq`,
    )
    .all(address.jobId);
  let requested = false;
  let accepted: AcceptedExecution | null = null;
  let ended = false;
  for (const row of rows) {
    if (row.type === 'job.execution.requested') {
      const request = decodeBody(row, jobExecutionRequestedBodySchema, ctx);
      if (request.execution > address.execution) break;
      requested = request.execution === address.execution;
    } else if (requested && row.type === 'job.execution.outcome.accepted') {
      accepted = {
        job,
        accepted: decodeBody(row, jobExecutionOutcomeAcceptedBodySchema, ctx),
        causeRef: { stream: { kind: 'job', id: address.jobId }, seq: row.seq },
        retention: null,
        retentionClosed: false,
      };
    } else if (accepted !== null && row.type === 'job.retention.discard.requested') {
      accepted = { ...accepted, retention: decodeBody(row, jobRetentionDiscardRequestedBodySchema, ctx) };
    } else if (
      accepted !== null &&
      (row.type === 'job.retention.discard.completed' || row.type === 'job.retention.discard.failed')
    ) {
      if (row.type === 'job.retention.discard.completed') decodeBody(row, jobRetentionDiscardCompletedBodySchema, ctx);
      else decodeBody(row, jobRetentionDiscardFailedBodySchema, ctx);
      accepted = { ...accepted, retentionClosed: true };
    } else if (accepted !== null && row.type === 'job.execution.ended') {
      const end = decodeBody(row, jobExecutionEndedBodySchema, ctx);
      if (
        end.execution !== address.execution ||
        end.causeRef.seq !== accepted.causeRef.seq ||
        end.causeRef.stream.kind !== 'job' ||
        end.causeRef.stream.id !== address.jobId
      )
        throw new Error('Execution end does not cite its accepted outcome.');
      ended = true;
    }
  }
  if (!requested) throw new Error(`Execution #${address.execution} of job '${address.jobId}' is not requested.`);
  return accepted === null ? { kind: 'unaccepted' } : { ...accepted, kind: ended ? 'ended' : 'finishing' };
}

export type RetentionSettlement =
  | { readonly kind: 'pending' }
  | { readonly kind: 'completed'; readonly outcome: 'discarded' | 'skipped_no_handles' | 'provider_declares_none' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ExecutionFinishingPorts {
  readonly time: Pick<TimePort, 'sleep'>;
  readonly commit: CommitEventsFn;
  readonly read: (address: ExecutionAddress) => ExecutionFinishingState;
  /** Only authoritative operation, reservation and cleanup release may return true. */
  readonly quiesce: (address: ExecutionAddress, accepted: JobExecutionOutcomeAcceptedBody) => Promise<boolean>;
  readonly retentionAction: (address: ExecutionAddress) => Promise<Omit<JobRetentionDiscardRequestedBody, 'execution'>>;
  /** Reconcile the original ledger action; a retry cannot issue a different action or replay a sealed one. */
  readonly settleRetention: (
    address: ExecutionAddress,
    action: JobRetentionDiscardRequestedBody,
  ) => Promise<RetentionSettlement>;
}

const RETRY_MS = 500;

function executionKey(address: ExecutionAddress): string {
  return `${address.jobId}:${address.execution}`;
}

export class ExecutionFinisher {
  readonly #ports: ExecutionFinishingPorts;
  readonly #producers = new Map<string, Promise<CauseRef>>();
  readonly #finalizers = new Map<string, Promise<void>>();

  constructor(ports: ExecutionFinishingPorts) {
    this.#ports = ports;
  }

  readonly observeCommitted: PostCommitObserver = (events) => {
    for (const event of events) {
      if (event.stream.kind !== 'job' || event.type !== 'job.execution.outcome.accepted') continue;
      const body = jobExecutionOutcomeAcceptedBodySchema.parse(event.body);
      void this.finish({ jobId: event.stream.id, execution: body.execution });
    }
  };

  owns(address: ExecutionAddress): boolean {
    const key = executionKey(address);
    return this.#producers.has(key) || this.#finalizers.has(key);
  }

  accept(address: ExecutionAddress, writeOriginalOutcome: Parameters<CommitEventsFn>[0]): Promise<CauseRef> {
    const key = executionKey(address);
    const existing = this.#producers.get(key);
    if (existing !== undefined) return existing;
    const producer = this.#accept(address, writeOriginalOutcome);
    this.#producers.set(key, producer);
    void producer.then(
      () => this.#producers.delete(key),
      () => this.#producers.delete(key),
    );
    return producer;
  }

  finish(address: ExecutionAddress): Promise<void> {
    const key = executionKey(address);
    const existing = this.#finalizers.get(key);
    if (existing !== undefined) return existing;
    const finalizer = this.#finish(address);
    this.#finalizers.set(key, finalizer);
    void finalizer.then(
      () => this.#finalizers.delete(key),
      () => this.#finalizers.delete(key),
    );
    return finalizer;
  }

  async #accept(address: ExecutionAddress, writeOriginalOutcome: Parameters<CommitEventsFn>[0]): Promise<CauseRef> {
    for (;;) {
      try {
        const state = this.#ports.read(address);
        if (state.kind !== 'unaccepted') {
          if (state.kind === 'finishing') void this.finish(address);
          return state.causeRef;
        }
        this.#ports.commit(writeOriginalOutcome);
      } catch {
        // An uncertain write must be read back before another append is attempted.
      }
      await this.#ports.time.sleep(RETRY_MS);
    }
  }

  async #finish(address: ExecutionAddress): Promise<void> {
    for (;;) {
      let state: ExecutionFinishingState;
      try {
        state = this.#ports.read(address);
      } catch {
        await this.#ports.time.sleep(RETRY_MS);
        continue;
      }
      if (state.kind === 'unaccepted') throw new Error('Finalization requires a committed accepted outcome.');
      if (state.kind === 'ended') return;
      try {
        if (await this.#ports.quiesce(address, state.accepted)) {
          const owesRetention =
            state.job.jobKind === 'provider' &&
            state.job.conversation.retention === 'discard_provider_artifacts_on_terminal';
          if (owesRetention && state.retention === null) {
            const action = await this.#ports.retentionAction(address);
            this.#ports.commit((c) => {
              c.append({
                type: 'job.retention.discard.requested',
                stream: { kind: 'job', id: address.jobId },
                body: { execution: address.execution, ...action },
              });
              return undefined;
            });
            continue;
          }
          const settlement =
            state.retention !== null && !state.retentionClosed
              ? await this.#ports.settleRetention(address, state.retention)
              : null;
          if (settlement === null || settlement.kind !== 'pending') {
            this.#ports.commit((c) => {
              if (settlement !== null && state.retention !== null) {
                const body =
                  settlement.kind === 'completed'
                    ? { ...state.retention, outcome: settlement.outcome }
                    : { ...state.retention, reason: settlement.reason };
                c.append({
                  type: `job.retention.discard.${settlement.kind}`,
                  stream: { kind: 'job', id: address.jobId },
                  body,
                });
              }
              appendJobExecutionEnded(c, { ...address, causeRef: state.causeRef });
              return undefined;
            });
            continue;
          }
        }
      } catch {
        // Effect progress remains owned by the operation and retention continuation.
      }
      await this.#ports.time.sleep(RETRY_MS);
    }
  }
}
