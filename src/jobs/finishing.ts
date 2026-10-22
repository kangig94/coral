import { z } from 'zod';
import { executionRetryStatusSchema, type ExecutionRetryStatus } from './records.js';
import { executionFinishingRecoverySource } from './execution-finishing-recovery-source.js';
import { RecoveryQuarantineStore } from '../recovery/quarantine.js';
import {
  canonicalRecoveryRevision,
  type RecoverySubject,
  type RecoveryQuarantineRemedy,
} from '../recovery/containment.js';
import { eventRevisionFields } from '../recovery/row-revision-fields.js';
import type { RecoverySourceFactoryPlan } from '../recovery/source-registry.js';
import type { EventsRow } from '../store/schema.js';
import { raceWithSignal } from '../infra/promise-signal.js';
import { backendLog } from '../infra/backend-log.js';
import { errorMessage } from '../infra/error-format.js';
import { executionAddressKey, type ExecutionAddress } from './execution-address.js';
import type { TimePort } from '../infra/port-types.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { PostCommitObserver } from '../store/append.js';
import type { CommitEventsFn } from '../store/append.js';
import { SuccessionWriterParkedError, type Database } from '../store/db.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import { jobExecutionRequestedBodySchema, type JobOpenedBody } from './launch.js';
import { readJobOpened, readExecutionLifecycleEvents } from './execution-journal.js';
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
  const rows = readExecutionLifecycleEvents(db, address.jobId);
  let requested = false;
  const state: { accepted: AcceptedExecution | null } = { accepted: null };
  let ended = false;
  for (const row of rows) {
    if (row.type === 'job.execution.requested') {
      const request = decodeBody(row, jobExecutionRequestedBodySchema, ctx);
      if (request.execution > address.execution) break;
      requested = request.execution === address.execution;
    } else if (requested && row.type === 'job.execution.outcome.accepted') {
      state.accepted = {
        job,
        accepted: decodeBody(row, jobExecutionOutcomeAcceptedBodySchema, ctx),
        causeRef: { stream: { kind: 'job', id: address.jobId }, seq: row.seq },
        retention: null,
        retentionClosed: false,
      };
    } else if (state.accepted !== null && row.type === 'job.retention.discard.requested') {
      state.accepted = { ...state.accepted, retention: decodeBody(row, jobRetentionDiscardRequestedBodySchema, ctx) };
    } else if (
      state.accepted !== null &&
      (row.type === 'job.retention.discard.completed' || row.type === 'job.retention.discard.failed')
    ) {
      if (row.type === 'job.retention.discard.completed') decodeBody(row, jobRetentionDiscardCompletedBodySchema, ctx);
      else decodeBody(row, jobRetentionDiscardFailedBodySchema, ctx);
      state.accepted = { ...state.accepted, retentionClosed: true };
    } else if (state.accepted !== null && row.type === 'job.execution.ended') {
      const end = decodeBody(row, jobExecutionEndedBodySchema, ctx);
      if (
        end.execution !== address.execution ||
        end.causeRef.seq !== state.accepted.causeRef.seq ||
        end.causeRef.stream.kind !== 'job' ||
        end.causeRef.stream.id !== address.jobId
      )
        throw new Error('Execution end does not cite its accepted outcome.');
      ended = true;
    }
  }
  if (!requested) throw new Error(`Execution #${address.execution} of job '${address.jobId}' is not requested.`);
  return state.accepted === null ? { kind: 'unaccepted' } : { ...state.accepted, kind: ended ? 'ended' : 'finishing' };
}

export type RetentionSettlement =
  | { readonly kind: 'pending' }
  | { readonly kind: 'awaiting-issuer'; readonly actionId: string }
  | { readonly kind: 'not-owned' }
  | { readonly kind: 'completed'; readonly outcome: 'discarded' | 'skipped_no_handles' | 'provider_declares_none' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ExecutionFinishingPorts {
  readonly time: Pick<TimePort, 'sleep'>;
  readonly recovery?: {
    readonly db: () => Database;
    readonly readCtx: StoreReadContext;
    readonly time: Pick<TimePort, 'now'>;
  };
  readonly log?: (message: string) => void;
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

export const EXECUTION_RETRY_MS = 500;
const EXECUTION_REDRIVE_MS = 5000;

export const EXECUTION_FINISHING_BOUNDARY = 'job-execution-finishing';
const MAX_EXECUTION_RETRIES = 6;

export class ExecutionAcceptanceRefusedError extends Error {}

function executionRequestEvent(db: Database, address: ExecutionAddress): EventsRow {
  const row = db
    .prepare<
      [string, number],
      EventsRow
    >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' AND json_extract(CAST(body AS TEXT), '$.execution') = ?")
    .get(address.jobId, address.execution);
  if (row === undefined) throw new Error(`Execution request missing for ${executionAddressKey(address)}.`);
  return row;
}

function finishingSubject(db: Database, address: ExecutionAddress): RecoverySubject {
  return {
    key: executionAddressKey(address),
    revision: canonicalRecoveryRevision(eventRevisionFields(executionRequestEvent(db, address))),
  };
}

export function readExecutionRetryStatus(db: Database, address: ExecutionAddress): ExecutionRetryStatus | null {
  const record = RecoveryQuarantineStore.readOnly(db).readEntry(
    EXECUTION_FINISHING_BOUNDARY,
    executionAddressKey(address),
  );
  if (record === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(record.detail);
  } catch {
    return null;
  }
  const parsed = executionRetryStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function listExecutionRetryStatuses(db: Database): {
  statuses: Array<{ jobId: string; execution: number; status: ExecutionRetryStatus }>;
  skipped: number;
} {
  const rows = db
    .prepare<[string], { job_id: string; execution: number }>(
      `SELECT p.job_id, p.execution FROM recovery_quarantine q JOIN projection_jobs p
     ON q.subject_key = p.job_id || ':' || p.execution WHERE q.boundary_id = ?`,
    )
    .all(EXECUTION_FINISHING_BOUNDARY);
  const statuses = rows.flatMap((row) => {
    let status: ExecutionRetryStatus | null;
    try {
      status = readExecutionRetryStatus(db, { jobId: row.job_id, execution: row.execution });
    } catch (error: unknown) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return [];
      throw error;
    }
    return status === null ? [] : [{ jobId: row.job_id, execution: row.execution, status }];
  });
  return { statuses, skipped: rows.length - statuses.length };
}

function finishingRemedy(subject: RecoverySubject): RecoveryQuarantineRemedy {
  return {
    kind: 'recovery-quarantine-clear',
    command:
      subject.revision.kind === 'fingerprint'
        ? {
            kind: 'clear',
            boundary: EXECUTION_FINISHING_BOUNDARY,
            key: subject.key,
            revision: `fingerprint:${subject.revision.value}`,
          }
        : { kind: 'list' },
  } as const;
}

export class ExecutionFinisher {
  readonly #ports: ExecutionFinishingPorts;
  readonly #lifetime = new AbortController();
  readonly #producers = new Map<string, Promise<CauseRef>>();
  readonly #finalizers = new Map<string, Promise<void>>();
  readonly #redriveResults = new Map<string, () => void>();
  readonly #redrives = new Map<string, () => void>();
  readonly #admissions = new Map<string, { address: ExecutionAddress; completion: Promise<void> }>();
  readonly #statuses = new Map<string, ExecutionRetryStatus>();

  constructor(ports: ExecutionFinishingPorts) {
    this.#ports = ports;
  }

  readContext(): StoreReadContext {
    const recovery = this.#ports.recovery;
    if (recovery === undefined) throw new Error('Execution finishing recovery is unavailable.');
    return recovery.readCtx;
  }

  state(address: ExecutionAddress): ExecutionFinishingState {
    return this.#ports.read(address);
  }

  get signal(): AbortSignal {
    return this.#lifetime.signal;
  }

  status(address: ExecutionAddress): ExecutionRetryStatus | null {
    return this.#statuses.get(executionAddressKey(address)) ?? null;
  }

  admissionStatuses(): Array<{ jobId: string; execution: number; status: ExecutionRetryStatus }> {
    return [...this.#admissions.values()].flatMap(({ address }) => {
      const status = this.status(address);
      return status?.stage === 'accept' ? [{ ...address, status }] : [];
    });
  }

  admissionStatus(jobId: string): ExecutionRetryStatus | null {
    return this.admissionStatuses().find((entry) => entry.jobId === jobId)?.status ?? null;
  }

  readonly observeCommitted: PostCommitObserver = (events) => {
    for (const event of events) {
      if (event.stream.kind !== 'job' || event.type !== 'job.execution.outcome.accepted') continue;
      const body = jobExecutionOutcomeAcceptedBodySchema.parse(event.body);
      this.schedule({ jobId: event.stream.id, execution: body.execution });
    }
  };

  schedule(address: ExecutionAddress): void {
    this.#redrives.get(executionAddressKey(address))?.();
    void this.finish(address).catch((error: unknown) => {
      if (!this.signal.aborted)
        (this.#ports.log ?? backendLog.warn)(
          `Execution finishing failed for ${executionAddressKey(address)}: ${errorMessage(error)}`,
        );
    });
  }

  owns(address: ExecutionAddress): boolean {
    const key = executionAddressKey(address);
    return this.#producers.has(key) || this.#finalizers.has(key) || this.#admissions.has(key);
  }

  adoptAdmission(
    address: ExecutionAddress,
    reconcile: () => Promise<void>,
  ): Readonly<{ kind: 'adopted'; completion: Promise<void> }> {
    const key = executionAddressKey(address);
    const existing = this.#admissions.get(key);
    if (existing !== undefined) return { kind: 'adopted', completion: existing.completion };
    const completion = Promise.resolve().then(async () => {
      for (let attempt = 0; ; attempt++) {
        this.signal.throwIfAborted();
        try {
          await reconcile();
          if (this.#statuses.get(key)?.stage === 'accept') this.#clearStatus(address);
          return;
        } catch (error: unknown) {
          await this.#retry(address, 'accept', error, attempt);
          if (attempt >= MAX_EXECUTION_RETRIES) attempt = -1;
        }
      }
    });
    this.#admissions.set(key, { address, completion });
    void completion.then(
      () => this.#admissions.delete(key),
      () => this.#admissions.delete(key),
    );
    return { kind: 'adopted', completion };
  }

  accept(address: ExecutionAddress, writeOriginalOutcome: Parameters<CommitEventsFn>[0]): Promise<CauseRef> {
    const key = executionAddressKey(address);
    const existing = this.#producers.get(key);
    if (existing !== undefined) return existing;
    const producer = Promise.resolve().then(() => this.#accept(address, writeOriginalOutcome));
    this.#producers.set(key, producer);
    void producer.then(
      () => this.#producers.delete(key),
      () => this.#producers.delete(key),
    );
    return producer;
  }

  finish(address: ExecutionAddress): Promise<void> {
    const key = executionAddressKey(address);
    const existing = this.#finalizers.get(key);
    if (existing !== undefined) return existing;
    const finalizer = Promise.resolve().then(() => this.#finish(address));
    this.#finalizers.set(key, finalizer);
    void finalizer.then(
      () => this.#finalizers.delete(key),
      () => this.#finalizers.delete(key),
    );
    return finalizer;
  }

  #setStatus(address: ExecutionAddress, status: ExecutionRetryStatus): void {
    const key = executionAddressKey(address);
    const previous = this.#statuses.get(key);
    if (JSON.stringify(previous) === JSON.stringify(status)) return;
    const recovery = this.#ports.recovery;
    if (recovery !== undefined && !(status.stage === 'accept' && this.#admissions.has(key))) {
      const db = recovery.db();
      const persisted = new RecoveryQuarantineStore(db, recovery.time).upsert({
        boundary: EXECUTION_FINISHING_BOUNDARY,
        subject: finishingSubject(db, address),
        state: status.kind === 'blocked' ? 'active' : 'continuation',
        stage: 'settle',
        errorMessage: status.reason,
        detail: JSON.stringify(status),
        remedy: finishingRemedy(finishingSubject(db, address)),
        ...(status.kind === 'blocked' ? {} : { continuation: { kind: 'job-execution-finishing.v1', key } }),
      });
      if (
        !persisted &&
        RecoveryQuarantineStore.readOnly(db).read(EXECUTION_FINISHING_BOUNDARY, key)?.state !== 'retrying'
      )
        throw new Error(`Execution finishing status lost authority for ${key}.`);
    }
    this.#statuses.set(key, status);
    (this.#ports.log ?? backendLog.warn)(
      `Execution ${key} ${status.stage} ${status.kind}: ${status.reason}; successor=${status.successor}.`,
    );
  }

  #clearStatus(address: ExecutionAddress): void {
    const key = executionAddressKey(address);
    if (this.#statuses.get(key)?.stage === 'accept' && this.#admissions.has(key)) {
      this.#statuses.delete(key);
      return;
    }
    const recovery = this.#ports.recovery;
    if (recovery !== undefined) {
      const db = recovery.db();
      new RecoveryQuarantineStore(db, recovery.time).delete({
        boundary: EXECUTION_FINISHING_BOUNDARY,
        subject: finishingSubject(db, address),
      });
    }
    this.#statuses.delete(executionAddressKey(address));
  }

  async redrive(address: ExecutionAddress, signal: AbortSignal = this.signal): Promise<void> {
    const key = executionAddressKey(address);
    const reblocked = new Promise<void>((resolve) => this.#redriveResults.set(key, resolve));
    this.#redrives.get(key)?.();
    const complete = async () => {
      const admission = this.#admissions.get(key);
      if (admission !== undefined) {
        await admission.completion;
        return;
      }
      const producer = this.#producers.get(key);
      if (producer !== undefined) await producer;
      if (this.state(address).kind === 'unaccepted') return;
      await this.finish(address);
    };
    try {
      await raceWithSignal(Promise.race([complete(), reblocked]), signal, () => {
        throw signal.reason;
      });
    } finally {
      this.#redriveResults.delete(key);
    }
  }

  async #retry(
    address: ExecutionAddress,
    stage: ExecutionRetryStatus['stage'],
    error: unknown,
    attempts: number,
  ): Promise<void> {
    this.signal.throwIfAborted();
    if (error instanceof SuccessionWriterParkedError) {
      await this.#await(error.unparked);
      return;
    }
    const exhausted = attempts >= MAX_EXECUTION_RETRIES;
    try {
      this.#setStatus(address, {
        stage,
        kind: exhausted ? 'blocked' : 'retrying',
        reason: errorMessage(error),
        successor:
          exhausted && !this.#admissions.has(executionAddressKey(address)) ? 'recovery-quarantine' : 'live-retry',
      });
    } catch (statusError: unknown) {
      if (statusError instanceof SuccessionWriterParkedError) await this.#await(statusError.unparked);
      else await this.#await(this.#ports.time.sleep(EXECUTION_REDRIVE_MS, { signal: this.signal }));
      return;
    }
    if (exhausted) {
      const key = executionAddressKey(address);
      this.#redriveResults.get(key)?.();
      try {
        const redrive = new Promise<void>((resolve) => this.#redrives.set(key, resolve));
        await this.#await(
          this.#admissions.has(key)
            ? Promise.race([redrive, this.#ports.time.sleep(EXECUTION_REDRIVE_MS, { signal: this.signal })])
            : redrive,
        );
      } finally {
        this.#redrives.delete(key);
      }
      return;
    }
    await raceWithSignal(
      this.#ports.time.sleep(Math.min(EXECUTION_REDRIVE_MS, EXECUTION_RETRY_MS * 2 ** Math.min(attempts, 4)), {
        signal: this.signal,
      }),
      this.signal,
      () => {
        throw this.signal.reason;
      },
    );
  }

  async #accept(address: ExecutionAddress, writeOriginalOutcome: Parameters<CommitEventsFn>[0]): Promise<CauseRef> {
    let attempts = 0;
    for (;;) {
      this.signal.throwIfAborted();
      try {
        const state = this.#ports.read(address);
        if (state.kind !== 'unaccepted') {
          this.#clearStatus(address);
          if (state.kind === 'finishing') this.schedule(address);
          return state.causeRef;
        }
        this.#ports.commit(writeOriginalOutcome);
        if (this.#ports.read(address).kind === 'unaccepted')
          throw new Error('Outcome acceptance did not commit an accepted outcome.');
      } catch (error: unknown) {
        if (error instanceof SuccessionWriterParkedError) {
          await this.#retry(address, 'accept', error, attempts);
          continue;
        }
        let confirmed: ExecutionFinishingState;
        try {
          confirmed = this.#ports.read(address);
        } catch (readError: unknown) {
          await this.#retry(address, 'accept', readError, attempts++);
          continue;
        }
        if (confirmed.kind !== 'unaccepted') {
          this.#clearStatus(address);
          if (confirmed.kind === 'finishing') this.schedule(address);
          return confirmed.causeRef;
        }
        if (error instanceof ExecutionAcceptanceRefusedError) {
          this.#clearStatus(address);
          throw error;
        }
        await this.#retry(address, 'accept', error, attempts++);
      }
    }
  }

  async #requestRetention(address: ExecutionAddress, state: AcceptedExecution): Promise<boolean> {
    if (
      state.job.jobKind !== 'provider' ||
      state.job.conversation.retention !== 'discard_provider_artifacts_on_terminal' ||
      state.retention !== null
    )
      return false;
    const action = await this.#await(this.#ports.retentionAction(address));
    this.signal.throwIfAborted();
    this.#ports.commit((c) => {
      c.append({
        type: 'job.retention.discard.requested',
        stream: { kind: 'job', id: address.jobId },
        body: { execution: address.execution, ...action },
      });
      return undefined;
    });
    return true;
  }

  #settleRetention(address: ExecutionAddress, state: AcceptedExecution): Promise<RetentionSettlement | null> {
    return state.retention !== null && !state.retentionClosed
      ? this.#await(this.#ports.settleRetention(address, state.retention))
      : Promise.resolve(null);
  }

  #closeExecution(
    address: ExecutionAddress,
    state: AcceptedExecution,
    settlement: Extract<RetentionSettlement, { kind: 'completed' | 'failed' }> | null,
  ): void {
    this.signal.throwIfAborted();
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
  }

  #await<T>(operation: Promise<T>): Promise<T> {
    return raceWithSignal(operation, this.signal, () => {
      throw this.signal.reason;
    });
  }

  async #hold(address: ExecutionAddress, reason: string, successor: ExecutionRetryStatus['successor']): Promise<void> {
    this.#setStatus(address, { stage: 'finish', kind: 'retrying', reason, successor });
    this.#redriveResults.get(executionAddressKey(address))?.();
    await this.#await(this.#ports.time.sleep(EXECUTION_RETRY_MS, { signal: this.signal }));
  }

  async #finish(address: ExecutionAddress): Promise<void> {
    let attempts = 0;
    for (;;) {
      this.signal.throwIfAborted();
      let unaccepted = false;
      try {
        const state = this.#ports.read(address);
        unaccepted = state.kind === 'unaccepted';
        if (state.kind === 'unaccepted') throw new Error('Finalization requires a committed accepted outcome.');
        if (state.kind === 'ended') {
          this.#clearStatus(address);
          return;
        }
        if (await this.#await(this.#ports.quiesce(address, state.accepted))) {
          if (await this.#requestRetention(address, state)) continue;
          const settlement = await this.#settleRetention(address, state);
          if (settlement?.kind === 'not-owned') {
            this.#clearStatus(address);
            return;
          }
          if (settlement?.kind === 'awaiting-issuer') {
            await this.#hold(
              address,
              `Discard action ${settlement.actionId} requires authoritative issuer release before sealing.`,
              'discard-issuer-release',
            );
            continue;
          }
          if (settlement === null || settlement.kind !== 'pending') {
            this.#closeExecution(address, state, settlement);
            continue;
          }
        }
        await this.#hold(address, 'Awaiting authoritative operation release or retention settlement.', 'live-retry');
      } catch (error: unknown) {
        this.signal.throwIfAborted();
        if (error instanceof SuccessionWriterParkedError) {
          await this.#retry(address, 'finish', error, attempts);
          continue;
        }
        if (unaccepted) throw error;
        let failure = error;
        try {
          const confirmed = this.#ports.read(address);
          if (confirmed.kind === 'ended') {
            this.#clearStatus(address);
            return;
          }
        } catch (readError: unknown) {
          failure = readError;
        }
        await this.#retry(address, 'finish', failure, attempts++);
      }
    }
  }

  async dispose(): Promise<void> {
    this.#lifetime.abort();
    await Promise.allSettled([
      ...this.#producers.values(),
      ...this.#finalizers.values(),
      ...[...this.#admissions.values()].map(({ completion }) => completion),
    ]);
    this.#statuses.clear();
  }
}

export function createExecutionFinishingRetryPlan(
  finisher: ExecutionFinisher,
  db: Database,
  subject: RecoverySubject,
  signal?: AbortSignal,
): RecoverySourceFactoryPlan<EventsRow, ExecutionAddress> {
  return {
    source: executionFinishingRecoverySource(db, subject),
    policy: {
      processLocalCleanup: { kind: 'not-required' },
      hydrate: (row) => ({
        jobId: row.stream_id,
        execution: decodeBody(row, jobExecutionRequestedBodySchema, finisher.readContext()).execution,
      }),
      requiredObligations: () => [],
      settle: async (address) => {
        await finisher.redrive(address, signal);
        const state = finisher.state(address);
        return state.kind === 'ended'
          ? { kind: 'advanced', outcome: 'settled', facts: [], detail: 'Execution ended.' }
          : finisher.status(address)?.kind === 'retrying'
            ? {
                kind: 'deferred',
                continuation: { kind: 'job-execution-finishing.v1', key: executionAddressKey(address) },
                detail: JSON.stringify(finisher.status(address)),
              }
            : {
                kind: 'quarantine',
                detail: JSON.stringify(finisher.status(address)),
                remedy: finishingRemedy(subject),
              };
      },
      onFault: (fault) => ({ kind: 'quarantine', detail: errorMessage(fault.error) }),
    },
  };
}
