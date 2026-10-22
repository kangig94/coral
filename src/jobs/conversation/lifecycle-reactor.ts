import { z } from 'zod';

import type { Database } from '../../store/db.js';
import { decodeStoredBody, type StoreReadContext } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';
import type { CommitEventsFn, PostCommitObserver } from '../../store/append.js';
import type { TimePort } from '../../infra/port-types.js';
import { errorMessage } from '../../infra/error-format.js';
import type { ArtifactCleanupRuntime } from '../../providers/contract.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { BoundProvider } from '../../providers/bound-provider-contract.js';
import type { JobConversation } from './entry.js';
import type { RecoveryObservation } from '../../recovery/phase-observation.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoverySubject,
  type RecoveryObligationId,
} from '../../recovery/containment.js';
import { eventRevisionFields } from '../../recovery/row-revision-fields.js';
import type { RecoverySourceFactoryPlan } from '../../recovery/source-registry.js';
import { RecoveryQuarantineStore } from '../../recovery/quarantine.js';
import type { ExecutionAddress, RetentionSettlement } from '../finishing.js';
import { jobRetentionDiscardRequestedBodySchema, type JobRetentionDiscardRequestedBody } from '../event-bodies.js';
import { jobExecutionOutcomeAcceptedBodySchema } from '../terminal/result.js';
import { readProjectionJobConversation, listProjectionConversationEntries } from './projections.js';
import { collectArtifactHandles } from './artifact-discard.js';
import {
  archiveProviderArtifactsForJob,
  deriveProviderArtifactActionDescriptor,
  deriveProviderArtifactSourceRevision,
} from './provider-artifact-archive.js';

export type LifecycleReactorOptions = {
  readonly db: () => Database;
  readonly readCtx: StoreReadContext;
  readonly providers: ProviderBindingCatalog;
  readonly runtime: ArtifactCleanupRuntime;
  readonly time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  readonly commitEvents: CommitEventsFn;
  readonly signal: AbortSignal;
  readonly log?: (message: string) => void;
  readonly bootId?: () => string;
};

const BOUNDARY = 'job-conversation-retention';
const RETENTION_OBLIGATION = 'job.retention.provider-discard' as RecoveryObligationId;
const reactors = new WeakMap<Database, LifecycleReactor>();
const observedSettlementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed'), outcome: z.enum(['discarded', 'skipped_no_handles', 'provider_declares_none']) }).strict(),
  z.object({ kind: z.literal('failed'), reason: z.string() }).strict(),
]);

function readAccepted(options: LifecycleReactorOptions, address: ExecutionAddress): EventsRow {
  const row = options.db().prepare<[string], EventsRow>(
    `SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ?
      AND type = 'job.execution.outcome.accepted' ORDER BY seq DESC`,
  ).all(address.jobId).find(candidate => jobExecutionOutcomeAcceptedBodySchema.parse(decodeStoredBody(candidate, options.readCtx)).execution === address.execution);
  if (row === undefined) throw new Error(`Job ${address.jobId} execution #${address.execution} has no accepted outcome.`);
  jobExecutionOutcomeAcceptedBodySchema.parse(decodeStoredBody(row, options.readCtx));
  return row;
}

export class LifecycleReactor {
  private admitted = false;
  private readonly inFlight = new Map<string, Promise<RetentionSettlement>>();
  private readonly abort = new AbortController();

  constructor(private readonly options: LifecycleReactorOptions) {
    reactors.set(options.db(), this);
  }

  readContext(): StoreReadContext { return this.options.readCtx; }

  isRetentionAdmitted(): boolean { return this.admitted; }
  admitRetention(): void {
    this.admitted = true;
    const requests = this.options.db().prepare<[], EventsRow>(
      "SELECT * FROM events WHERE stream_kind = 'job' AND type = 'job.retention.discard.requested' ORDER BY seq",
    ).all();
    for (const row of requests) {
      const action = jobRetentionDiscardRequestedBodySchema.parse(decodeStoredBody(row, this.options.readCtx));
      this.scheduleRetention({ jobId: row.stream_id, execution: action.execution }, action);
    }
  }

  private scheduleRetention(address: ExecutionAddress, action: JobRetentionDiscardRequestedBody): void {
    const entry = readProjectionJobConversation(this.options.db(), address.jobId);
    if (entry === null || !entry.finishing || entry.execution !== address.execution) return;
    void this.settleRetention(address, action).catch(error => {
      this.options.log?.(`Retention remains owned by execution #${address.execution} of ${address.jobId}: ${errorMessage(error)}\n`);
    });
  }

  readonly observe: PostCommitObserver = events => {
    const quarantine = new RecoveryQuarantineStore(this.options.db(), this.options.time);
    for (const event of events) {
      if (this.admitted && event.stream.kind === 'job' && event.type === 'job.retention.discard.requested') {
        const action = jobRetentionDiscardRequestedBodySchema.parse(event.body);
        this.scheduleRetention({ jobId: event.stream.id, execution: action.execution }, action);
      }
      if (event.type !== 'job.execution.ended' || event.stream.kind !== 'job') continue;
      const execution = (event.body as { execution: number }).execution;
      const entry = readProjectionJobConversation(this.options.db(), event.stream.id);
      if (entry === null) continue;
      const accepted = readAccepted(this.options, { jobId: event.stream.id, execution });
      for (const attempt of entry.retentionDiscard.attempts) {
        if (attempt.execution !== execution) continue;
        const removed = quarantine.delete({ boundary: BOUNDARY, subject: {
          key: `${event.stream.id}:${execution}:${attempt.attempt}`,
          revision: canonicalRecoveryRevision(eventRevisionFields(accepted)),
        } });
        if (!removed) this.options.log?.(`Retention observation remains for ${event.stream.id} execution #${execution}.\n`);
      }
    }
  };

  async scanStartup(signal: AbortSignal, observation?: RecoveryObservation): Promise<void> {
    signal.throwIfAborted();
    observation?.record(BOUNDARY, { subjects: listProjectionConversationEntries(this.options.db()).filter(entry => entry.finishing).length });
  }

  async retentionAction(address: ExecutionAddress): Promise<Omit<JobRetentionDiscardRequestedBody, 'execution'>> {
    const entry = readProjectionJobConversation(this.options.db(), address.jobId);
    if (entry === null || entry.execution !== address.execution || !entry.finishing) {
      throw new Error(`Job ${address.jobId} execution #${address.execution} is not finishing.`);
    }
    const bound = this.options.providers.rehydrateBinding(entry.binding);
    let handles = entry.artifactHandles.filter(handle => handle.execution === address.execution).map(handle => handle.handle);
    if (bound.ok) handles = collectArtifactHandles(entry, bound.value, this.options.runtime, { execution: address.execution });
    const attempt = entry.retentionDiscard.attempts.filter(item => item.execution === address.execution)
      .reduce((maximum, item) => Math.max(maximum, item.attempt), 0) + 1;
    return { attempt, handles };
  }

  settleRetention(address: ExecutionAddress, action: JobRetentionDiscardRequestedBody): Promise<RetentionSettlement> {
    const key = `${address.jobId}:${address.execution}`;
    const active = this.inFlight.get(key);
    if (active !== undefined) return active;
    const task = this.settle(address, action);
    this.inFlight.set(key, task);
    void task.then(() => this.inFlight.delete(key), () => this.inFlight.delete(key));
    return task;
  }

  private async settle(address: ExecutionAddress, action: JobRetentionDiscardRequestedBody): Promise<RetentionSettlement> {
    this.options.signal.throwIfAborted();
    this.abort.signal.throwIfAborted();
    const entry = readProjectionJobConversation(this.options.db(), address.jobId);
    if (entry === null || !entry.finishing || entry.execution !== address.execution || action.execution !== address.execution) {
      throw new Error(`Retention does not own job ${address.jobId} execution #${address.execution}.`);
    }
    const accepted = readAccepted(this.options, address);
    const subject: RecoverySubject = {
      key: `${address.jobId}:${address.execution}:${action.attempt}`,
      revision: canonicalRecoveryRevision(eventRevisionFields(accepted)),
    };
    const quarantine = new RecoveryQuarantineStore(this.options.db(), this.options.time);
    const previous = this.options.db().prepare<[string, string], { continuation_key: string | null }>(
      'SELECT continuation_key FROM recovery_quarantine WHERE boundary_id = ? AND subject_key = ?',
    ).get(BOUNDARY, subject.key);
    if (previous?.continuation_key !== null && previous?.continuation_key !== undefined) {
      return observedSettlementSchema.parse(JSON.parse(previous.continuation_key));
    }
    const remember = (settlement: Exclude<RetentionSettlement, { kind: 'pending' }>): RetentionSettlement => {
      const persisted = quarantine.upsert({
        boundary: BOUNDARY, subject, state: 'continuation', stage: 'settle',
        errorMessage: 'Retention outcome awaits its journal commit.',
        continuation: { kind: 'job-retention-outcome.v1', key: JSON.stringify(settlement) },
      });
      if (!persisted) throw new Error(`Retention outcome lost authority for ${subject.key}.`);
      return settlement;
    };
    const bound = this.options.providers.rehydrateBinding(entry.binding);
    if (!bound.ok) return remember({ kind: 'failed', reason: `Provider binding unavailable: ${bound.failure.reason}; native artifacts kept.` });
    const ready = await bound.value.readiness('recovery', this.options.runtime.storage);
    if (!ready.ok) return remember({ kind: 'failed', reason: `Provider cleanup unavailable: ${ready.failure.reason}; native artifacts kept.` });
    if (bound.value.artifacts.kind === 'none') return remember({ kind: 'completed', outcome: 'provider_declares_none' });
    const complete = async (outcome: 'discarded' | 'skipped_no_handles'): Promise<RetentionSettlement> => {
      await this.discardResidue(bound.value, entry);
      return remember({ kind: 'completed', outcome });
    };
    if (action.handles.length === 0) return complete('skipped_no_handles');
    const descriptor = deriveProviderArtifactActionDescriptor({
      entry, jobId: address.jobId, handles: action.handles,
      sourceRevision: deriveProviderArtifactSourceRevision({ ...address, accepted }), archivedAt: accepted.ts,
    });
    try {
      await archiveProviderArtifactsForJob({ runtime: this.options.runtime, descriptor });
    } catch (error) {
      return remember({ kind: 'failed', reason: `Archive failed; native artifacts kept: ${errorMessage(error)}` });
    }
    const artifacts = bound.value.artifacts;
    const reconcile = () => artifacts.reconcileDiscard({ handles: action.handles, actionId: descriptor.discardActionId,
      payloadHash: descriptor.discardPayloadHash, runtime: this.options.runtime });
    const prior = await reconcile();
    if (prior.kind === 'applied') return complete('discarded');
    if (prior.kind === 'definitive-failure') return remember({ kind: 'failed', reason: prior.reason });
    if (prior.kind === 'unknown') return { kind: 'pending' };
    try {
      await artifacts.discardArtifacts({ handles: action.handles, actionId: descriptor.discardActionId,
        payloadHash: descriptor.discardPayloadHash, runtime: this.options.runtime });
    } catch (error) {
      this.options.log?.(`Retention discard observation failed: ${errorMessage(error)}\n`);
    }
    const outcome = await reconcile();
    if (outcome.kind === 'applied') return complete('discarded');
    if (outcome.kind === 'definitive-failure') return remember({ kind: 'failed', reason: outcome.reason });
    return { kind: 'pending' };
  }

  private async discardResidue(bound: BoundProvider, entry: JobConversation): Promise<void> {
    if (bound.artifacts.kind !== 'managed' || bound.artifacts.discardResidue === undefined || entry.conversationRef === undefined) return;
    try {
      const residue = await bound.artifacts.discardResidue({ conversationRef: entry.conversationRef,
        since: Date.parse(entry.createdAt), runtime: this.options.runtime });
      for (const kept of residue.retained) this.options.log?.(`Residue retained for ${entry.jobId}: ${kept.path} (${kept.reason})\n`);
    } catch (error) {
      this.options.log?.(`Residue discard failed for ${entry.jobId}: ${errorMessage(error)}\n`);
    }
  }

  async discardConversationArtifacts(jobId: string): Promise<void> {
    const entry = readProjectionJobConversation(this.options.db(), jobId);
    if (entry === null || !entry.finishing) return;
    const address = { jobId, execution: entry.execution };
    const action = await this.retentionAction(address);
    const result = await this.settleRetention(address, { ...action, execution: address.execution });
    if (result.kind === 'failed') this.options.log?.(`${result.reason}\n`);
  }

  listLifecycleConversationEntries(db: Database = this.options.db()) {
    return listProjectionConversationEntries(db);
  }

  async waitForIdle(): Promise<void> { await Promise.all(this.inFlight.values()); }
  async dispose(): Promise<void> { this.abort.abort(); await this.waitForIdle(); }
}

export function isLifecycleRetentionAdmitted(db: Database): boolean {
  return reactors.get(db)?.isRetentionAdmitted() === true;
}

export function createRetentionWorkRetryPlan(
  db: Database, subject: RecoverySubject, signal: AbortSignal,
  _quarantine?: import('../../recovery/containment.js').RecoveryQuarantinePort,
): RecoverySourceFactoryPlan<EventsRow, { row: EventsRow; address: ExecutionAddress; action: JobRetentionDiscardRequestedBody }> {
  const reactor = reactors.get(db);
  if (reactor === undefined) throw new Error('Conversation retention is not initialized.');
  return {
    source: defineRecoverySource({
      boundary: BOUNDARY, scanSubject: subject,
      scan: () => db.prepare<[], EventsRow>(
        `SELECT * FROM events WHERE stream_kind = 'job' AND type = 'job.retention.discard.requested' ORDER BY seq`,
      ).all(),
      subject: row => ({ key: `${row.stream_id}:${row.seq}`, revision: canonicalRecoveryRevision(eventRevisionFields(row)) }),
    }),
    policy: {
      requiredObligations: () => [RETENTION_OBLIGATION],
      hydrate: row => {
        const action = jobRetentionDiscardRequestedBodySchema.parse(decodeStoredBody(row, reactor.readContext()));
        return { row, address: { jobId: row.stream_id, execution: action.execution }, action };
      },
      settle: async item => {
        signal.throwIfAborted();
        const entry = readProjectionJobConversation(db, item.address.jobId);
        if (entry === null || !entry.finishing || entry.execution !== item.address.execution) {
          return { kind: 'advanced', outcome: 'settled', facts: [{ obligation: RETENTION_OBLIGATION, outcome: 'not-applicable' }], detail: 'Execution no longer owns retention.' };
        }
        const result = await reactor.settleRetention(item.address, item.action);
        return result.kind === 'pending'
          ? { kind: 'deferred', authoritativeSource: { kind: 'unchanged-and-still-enumerable' }, detail: 'Retention outcome remains unknown.' }
          : { kind: 'advanced', outcome: 'settled', facts: [{ obligation: RETENTION_OBLIGATION, outcome: 'done' }], detail: 'Retention outcome reconciled.' };
      },
      onFault: fault => ({ kind: 'quarantine', detail: errorMessage(fault.error) }),
    },
  };
}

export function createLifecycleReactor(options: LifecycleReactorOptions): LifecycleReactor {
  return new LifecycleReactor(options);
}
