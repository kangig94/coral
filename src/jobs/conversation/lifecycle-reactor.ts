import { retentionRecoverySource } from './retention-recovery-source.js';
import { readExecutionAcceptedOutcomeEvent } from '../execution-journal.js';
import { z } from 'zod';
import { isAbsolute } from 'node:path';

import type { Database } from '../../store/db.js';
import { decodeStoredBody, type StoreReadContext } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';
import type { CommitEventsFn, PostCommitObserver } from '../../store/append.js';
import type { TimePort } from '../../infra/port-types.js';
import { errorMessage } from '../../infra/error-format.js';
import type { ArtifactCleanupRuntime } from '../../providers/contract.js';
import {
  providerArtifactDiscardWasIssued,
  reconcileProviderArtifactDiscard,
  sealProviderArtifactDiscard,
} from '../../providers/capability.js';
import { withJobArtifactGuard } from './artifact-guard.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { BoundProvider } from '../../providers/bound-provider-contract.js';
import type { JobConversation } from './entry.js';
import type { RecoveryObservation } from '../../recovery/phase-observation.js';
import {
  RecoveryContainment,
  canonicalRecoveryRevision,
  type RecoverySubject,
  type RecoveryObligationId,
} from '../../recovery/containment.js';
import { eventRevisionFields } from '../../recovery/row-revision-fields.js';
import type { RecoverySourceFactoryPlan } from '../../recovery/source-registry.js';
import { RecoveryQuarantineStore } from '../../recovery/quarantine.js';
import { EXECUTION_RETRY_MS, type RetentionSettlement } from '../finishing.js';
import { executionKey, retentionActionKey, type ExecutionAddress } from '../execution-address.js';
import { jobRetentionDiscardRequestedBodySchema, type JobRetentionDiscardRequestedBody } from '../event-bodies.js';
import { readProjectionJobConversation, listProjectionConversationEntries } from './read-queries.js';
import { collectArtifactHandles } from './artifact-discard.js';
import {
  archiveProviderArtifactsForJob,
  cleanupConversationRestoreStages,
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
  z
    .object({
      kind: z.literal('completed'),
      outcome: z.enum(['discarded', 'skipped_no_handles', 'provider_declares_none']),
    })
    .strict(),
  z.object({ kind: z.literal('failed'), reason: z.string() }).strict(),
]);
const observationProgressSchema = z
  .object({ kind: z.literal('observing'), attempts: z.number().int().min(0).max(6) })
  .strict();

type RetentionOutcome = Extract<RetentionSettlement, { kind: 'completed' | 'failed' }>;
interface RetentionWork {
  readonly address: ExecutionAddress;
  readonly action: JobRetentionDiscardRequestedBody;
  readonly entry: JobConversation;
  readonly accepted: EventsRow;
  readonly previousAttempts: number | null;
  readonly subject: RecoverySubject;
  readonly quarantine: RecoveryQuarantineStore;
  readonly remember: (outcome: RetentionOutcome) => RetentionSettlement;
}

export class LifecycleReactor {
  private admitted = false;
  private readonly inFlight = new Map<string, Promise<RetentionSettlement>>();
  private readonly observed = new Map<string, Extract<RetentionSettlement, { kind: 'completed' | 'failed' }>>();
  private readonly abort = new AbortController();

  private readonly options: LifecycleReactorOptions;

  constructor(options: LifecycleReactorOptions) {
    this.options = options;
  }

  private checkActive(): void {
    this.options.signal.throwIfAborted();
    this.abort.signal.throwIfAborted();
  }

  readContext(): StoreReadContext {
    return this.options.readCtx;
  }

  isRetentionAdmitted(): boolean {
    return this.admitted;
  }
  admitRetention(): void {
    this.checkActive();
    reactors.set(this.options.db(), this);
    this.admitted = true;
    const requests = this.options
      .db()
      .prepare<
        [],
        EventsRow
      >("SELECT * FROM events WHERE stream_kind = 'job' AND type = 'job.retention.discard.requested' ORDER BY seq")
      .all();
    for (const row of requests) {
      const action = jobRetentionDiscardRequestedBodySchema.parse(decodeStoredBody(row, this.options.readCtx));
      this.scheduleRetention({ jobId: row.stream_id, execution: action.execution }, action);
    }
  }

  private scheduleRetention(address: ExecutionAddress, action: JobRetentionDiscardRequestedBody): void {
    const entry = readProjectionJobConversation(this.options.db(), address.jobId);
    if (entry === null || !entry.finishing || entry.execution !== address.execution) return;
    void this.settleRetention(address, action).catch((error) => {
      this.options.log?.(
        `Retention remains owned by execution #${address.execution} of ${address.jobId}: ${errorMessage(error)}\n`,
      );
    });
  }

  readonly observe: PostCommitObserver = (events) => {
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
      const accepted = readExecutionAcceptedOutcomeEvent(this.options.db(), this.options.readCtx, {
        jobId: event.stream.id,
        execution,
      });
      for (const attempt of entry.retentionDiscard.attempts) {
        if (attempt.execution !== execution) continue;
        this.observed.delete(retentionActionKey({ jobId: event.stream.id, execution, attempt: attempt.attempt }));
        const removed = quarantine.delete({
          boundary: BOUNDARY,
          subject: {
            key: retentionActionKey({ jobId: event.stream.id, execution, attempt: attempt.attempt }),
            revision: canonicalRecoveryRevision(eventRevisionFields(accepted)),
          },
        });
        if (!removed)
          this.options.log?.(`Retention observation remains for ${event.stream.id} execution #${execution}.\n`);
      }
    }
  };

  async scanStartup(signal: AbortSignal, observation?: RecoveryObservation): Promise<void> {
    signal.throwIfAborted();
    this.checkActive();
    reactors.set(this.options.db(), this);
    await RecoveryContainment.each(retentionRecoverySource(this.options.db(), this.options.readCtx), {
      signal,
      quarantine: new RecoveryQuarantineStore(this.options.db(), this.options.time),
      processLocalCleanup: { kind: 'not-required' },
      hydrate: (row) => ({
        jobId: row.stream_id,
        action: jobRetentionDiscardRequestedBodySchema.parse(decodeStoredBody(row, this.options.readCtx)),
      }),
      requiredObligations: () => [],
      settle: ({ jobId, action }) => {
        const entry = readProjectionJobConversation(this.options.db(), jobId);
        return entry?.finishing && entry.execution === action.execution
          ? {
              kind: 'deferred',
              authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
              detail: 'Retention resumes after provider-operation admission.',
            }
          : { kind: 'advanced', outcome: 'settled', facts: [], detail: 'Execution no longer owns retention.' };
      },
      onFault: (fault) => {
        if (fault.stage === 'scan') throw fault.error;
        return { kind: 'quarantine', detail: errorMessage(fault.error) };
      },
    });
    observation?.record(BOUNDARY, {
      subjects: listProjectionConversationEntries(this.options.db()).filter((entry) => entry.finishing).length,
    });
  }

  async retentionAction(address: ExecutionAddress): Promise<Omit<JobRetentionDiscardRequestedBody, 'execution'>> {
    const entry = readProjectionJobConversation(this.options.db(), address.jobId);
    if (entry === null || entry.execution !== address.execution || !entry.finishing) {
      throw new Error(`Job ${address.jobId} execution #${address.execution} is not finishing.`);
    }
    let handles = entry.artifactHandles
      .filter((handle) => handle.execution === address.execution)
      .map((handle) => handle.handle);
    try {
      const bound = this.options.providers.rehydrateBinding(entry.binding);
      if (bound.ok)
        handles = collectArtifactHandles(entry, bound.value, this.options.runtime, { execution: address.execution });
    } catch (error: unknown) {
      this.options.log?.(
        `Retention handle discovery unavailable for ${executionKey(address.jobId, address.execution)}: ${errorMessage(error)}; successor=retention settlement.\n`,
      );
    }
    const attempt =
      entry.retentionDiscard.attempts
        .filter((item) => item.execution === address.execution)
        .reduce((maximum, item) => Math.max(maximum, item.attempt), 0) + 1;
    return { attempt, handles };
  }

  settleRetention(address: ExecutionAddress, action: JobRetentionDiscardRequestedBody): Promise<RetentionSettlement> {
    const key = executionKey(address.jobId, address.execution);
    const active = this.inFlight.get(key);
    if (active !== undefined) return active;
    const task = this.settle(address, action);
    this.inFlight.set(key, task);
    void task.then(
      () => this.inFlight.delete(key),
      () => this.inFlight.delete(key),
    );
    return task;
  }

  private async settle(
    address: ExecutionAddress,
    action: JobRetentionDiscardRequestedBody,
  ): Promise<RetentionSettlement> {
    this.checkActive();
    const entry = readProjectionJobConversation(this.options.db(), address.jobId);
    if (action.execution !== address.execution) {
      throw new Error(`Retention does not own job ${address.jobId} execution #${address.execution}.`);
    }
    if (entry === null || !entry.finishing || entry.execution !== address.execution) {
      return { kind: 'not-owned' };
    }
    const closed = entry.retentionDiscard.attempts.find(
      (attempt) =>
        attempt.execution === address.execution && attempt.attempt === action.attempt && attempt.status !== 'requested',
    );
    if (closed !== undefined)
      return observedSettlementSchema.parse(
        closed.status === 'failed'
          ? { kind: 'failed', reason: closed.reason }
          : { kind: 'completed', outcome: closed.outcome },
      );
    const accepted = readExecutionAcceptedOutcomeEvent(this.options.db(), this.options.readCtx, address);
    const subject: RecoverySubject = {
      key: retentionActionKey({ ...address, attempt: action.attempt }),
      revision: canonicalRecoveryRevision(eventRevisionFields(accepted)),
    };
    const quarantine = new RecoveryQuarantineStore(this.options.db(), this.options.time);
    const { continuation, previousAttempts } = this.readRetentionContinuation(subject);
    if (continuation !== null) return continuation;
    const remember = (
      settlement: Extract<RetentionSettlement, { kind: 'completed' | 'failed' }>,
    ): RetentionSettlement => {
      this.checkActive();
      this.observed.set(subject.key, settlement);
      const persisted = quarantine.upsert({
        boundary: BOUNDARY,
        subject,
        state: 'continuation',
        stage: 'settle',
        errorMessage: 'Retention outcome awaits its journal commit.',
        detail: 'The observed retention outcome is preserved until execution finalization commits.',
        continuation: { kind: 'job-retention-outcome.v1', key: JSON.stringify(settlement) },
      });
      if (!persisted) throw new Error(`Retention outcome lost authority for ${subject.key}.`);
      return settlement;
    };
    const observed = this.observed.get(subject.key);
    if (observed !== undefined) return remember(observed);
    return this.settleArtifacts({ address, action, entry, accepted, previousAttempts, subject, quarantine, remember });
  }

  private readRetentionContinuation(subject: RecoverySubject): {
    continuation: RetentionOutcome | null;
    previousAttempts: number | null;
  } {
    const previous = this.options
      .db()
      .prepare<
        [string, string],
        { continuation_key: string | null }
      >('SELECT continuation_key FROM recovery_quarantine WHERE boundary_id = ? AND subject_key = ?')
      .get(BOUNDARY, subject.key);
    const continuationKey = previous?.continuation_key ?? null;
    const continuation: unknown = continuationKey === null ? null : JSON.parse(continuationKey);
    const progress = observationProgressSchema.safeParse(continuation);
    return {
      continuation: continuation !== null && !progress.success ? observedSettlementSchema.parse(continuation) : null,
      previousAttempts: progress.success ? progress.data.attempts : null,
    };
  }

  private validateRetentionHandles(work: RetentionWork): RetentionSettlement | null {
    const { address, action, entry, remember } = work;
    if (
      !entry.retentionDiscard.attempts.some(
        (attempt) =>
          attempt.execution === address.execution &&
          attempt.attempt === action.attempt &&
          attempt.status === 'requested' &&
          JSON.stringify(attempt.handles) === JSON.stringify(action.handles),
      )
    )
      throw new Error('Retention requires its committed request before any effect.');
    return z.array(z.string().refine(isAbsolute)).safeParse(action.handles).success
      ? null
      : remember({ kind: 'failed', reason: 'Native artifact handles must be absolute; native artifacts kept.' });
  }

  private async providerCleanupReadiness(
    work: RetentionWork,
    issued: boolean,
  ): Promise<{ kind: 'ready'; provider: BoundProvider | null } | { kind: 'unavailable'; reason: string }> {
    try {
      const bound = this.options.providers.rehydrateBinding(work.entry.binding);
      if (!bound.ok)
        return issued
          ? { kind: 'ready', provider: null }
          : { kind: 'unavailable', reason: `Provider binding unavailable: ${bound.failure.reason}` };
      if (!issued) {
        const ready = await bound.value.readiness('recovery', this.options.runtime.storage);
        if (!ready.ok) return { kind: 'unavailable', reason: `Provider cleanup unavailable: ${ready.failure.reason}` };
        collectArtifactHandles(work.entry, bound.value, this.options.runtime, { execution: work.address.execution });
      }
      return { kind: 'ready', provider: bound.value };
    } catch (error: unknown) {
      if (!issued) return { kind: 'unavailable', reason: `Provider cleanup unavailable: ${errorMessage(error)}` };
      this.options.log?.(
        `Provider cleanup unavailable for ${work.subject.key}: ${errorMessage(error)}; successor=original discard reconciliation.\n`,
      );
      return { kind: 'ready', provider: null };
    }
  }

  private async archiveArtifacts(
    descriptor: Parameters<typeof archiveProviderArtifactsForJob>[0]['descriptor'],
  ): Promise<{ kind: 'archived'; missing: boolean } | { kind: 'failed'; reason: string }> {
    try {
      const archive = await archiveProviderArtifactsForJob({ runtime: this.options.runtime, descriptor });
      return { kind: 'archived', missing: archive.artifacts.every((artifact) => artifact.status === 'missing') };
    } catch (error: unknown) {
      return { kind: 'failed', reason: `Archive failed: ${errorMessage(error)}` };
    }
  }

  private async settleArtifacts(work: RetentionWork): Promise<RetentionSettlement> {
    const { address, action, entry, accepted, remember } = work;
    const invalid = this.validateRetentionHandles(work);
    if (invalid !== null) return invalid;
    const descriptor = deriveProviderArtifactActionDescriptor({
      entry,
      jobId: address.jobId,
      handles: action.handles,
      sourceRevision: deriveProviderArtifactSourceRevision({ ...address, accepted }),
      archivedAt: accepted.ts,
    });
    const discardOptions = {
      handles: action.handles,
      actionId: descriptor.discardActionId,
      payloadHash: descriptor.discardPayloadHash,
      runtime: this.options.runtime,
    };
    const issued = providerArtifactDiscardWasIssued(discardOptions);
    const failBeforeDiscard = async (reason: string): Promise<RetentionSettlement> => {
      const detail = `${reason}; ${issued ? 'the original discard may already have applied' : 'native artifacts kept'}.`;
      if (issued) {
        const seal = await sealProviderArtifactDiscard(discardOptions, detail);
        if (seal.kind === 'awaiting-issuer') return seal;
      }
      return remember({ kind: 'failed', reason: detail });
    };
    try {
      await cleanupConversationRestoreStages(this.options.runtime, address.jobId, address.execution, action.handles);
    } catch (error: unknown) {
      return failBeforeDiscard(`Restore stage cleanup failed: ${errorMessage(error)}`);
    }
    const readiness = await this.providerCleanupReadiness(work, issued);
    if (readiness.kind === 'unavailable') return failBeforeDiscard(readiness.reason);
    const { provider } = readiness;
    if (!issued && provider?.artifacts.kind === 'none')
      return remember({ kind: 'completed', outcome: 'provider_declares_none' });
    const complete = async (outcome: 'discarded' | 'skipped_no_handles'): Promise<RetentionSettlement> => {
      this.checkActive();
      if (provider !== null) await this.discardResidue(provider, entry);
      return remember({ kind: 'completed', outcome });
    };
    if (action.handles.length === 0) return complete('skipped_no_handles');
    this.checkActive();
    const archive = await this.archiveArtifacts(descriptor);
    if (archive.kind === 'failed') return failBeforeDiscard(archive.reason);
    if (archive.missing) return complete('skipped_no_handles');
    const artifacts = provider?.artifacts.kind === 'managed' ? provider.artifacts : null;
    if (!issued && artifacts === null) return failBeforeDiscard('Provider artifact cleanup is unavailable');
    return this.observeDiscardRemoval(work, { issued, artifacts, discardOptions, complete });
  }

  private observeDiscardRemoval(
    work: RetentionWork,
    discard: {
      issued: boolean;
      artifacts: Extract<BoundProvider['artifacts'], { kind: 'managed' }> | null;
      discardOptions: Parameters<typeof reconcileProviderArtifactDiscard>[0];
      complete: (outcome: 'discarded' | 'skipped_no_handles') => Promise<RetentionSettlement>;
    },
  ): Promise<RetentionSettlement> {
    const { address, previousAttempts, subject, quarantine, remember } = work;
    const { issued, artifacts, discardOptions, complete } = discard;
    return withJobArtifactGuard<RetentionSettlement>(this.options.runtime, address.jobId, async () => {
      this.checkActive();
      const current = readProjectionJobConversation(this.options.db(), address.jobId);
      if (current === null || current.execution !== address.execution || !current.finishing) {
        return { kind: 'not-owned' };
      }
      const reconcile = async () => {
        try {
          return issued || artifacts === null
            ? await reconcileProviderArtifactDiscard(discardOptions)
            : await artifacts.reconcileDiscard(discardOptions);
        } catch (error: unknown) {
          this.options.log?.(
            `Discard evidence unavailable for ${executionKey(address.jobId, address.execution)}: ${errorMessage(error)}; successor=bounded removal observation.\n`,
          );
          return { kind: 'unknown' } as const;
        }
      };
      let attempts = previousAttempts ?? 0;
      const observe = async () => {
        this.checkActive();
        if (attempts >= 6) return { kind: 'unknown' } as const;
        attempts++;
        const persisted = quarantine.upsert({
          boundary: BOUNDARY,
          subject,
          state: 'continuation',
          stage: 'settle',
          errorMessage: 'Discard removal evidence is being observed.',
          detail: `Removal observation ${attempts} of 6 for the original discard action.`,
          continuation: { kind: 'job-retention-outcome.v1', key: JSON.stringify({ kind: 'observing', attempts }) },
        });
        if (!persisted) throw new Error(`Retention observation lost authority for ${subject.key}.`);
        return reconcile();
      };
      let outcome = await observe();
      this.checkActive();
      if (outcome.kind === 'not-applied' && !issued && previousAttempts === null && artifacts !== null) {
        try {
          await artifacts.discardArtifacts(discardOptions);
        } catch (error: unknown) {
          this.options.log?.(`Retention discard observation failed: ${errorMessage(error)}\n`);
        }
        outcome = await observe();
      }
      while (outcome.kind === 'unknown' && attempts < 6) {
        await this.options.runtime.time.sleep(EXECUTION_RETRY_MS, { signal: this.abort.signal });
        outcome = await observe();
      }
      if (outcome.kind === 'applied')
        return complete(outcome.outcome.kind === 'skipped_no_handles' ? 'skipped_no_handles' : 'discarded');
      const reason =
        outcome.kind === 'definitive-failure'
          ? outcome.reason
          : outcome.kind === 'unknown'
            ? 'Discard removal evidence is unknown after six observations; native absence or kept bytes cannot be asserted.'
            : 'Native removal was not applied; surviving native artifacts remain.';
      const seal = await sealProviderArtifactDiscard(discardOptions, reason);
      if (seal.kind === 'awaiting-issuer') {
        this.options.log?.(
          `Retention observation exhausted for ${subject.key}; successor=discard issuer release for ${seal.actionId}.\n`,
        );
        return seal;
      }
      return remember({ kind: 'failed', reason });
    });
  }

  private async discardResidue(bound: BoundProvider, entry: JobConversation): Promise<void> {
    if (
      bound.artifacts.kind !== 'managed' ||
      bound.artifacts.discardResidue === undefined ||
      entry.conversationRef === undefined
    )
      return;
    try {
      const residue = await bound.artifacts.discardResidue({
        conversationRef: entry.conversationRef,
        since: Date.parse(entry.createdAt),
        runtime: this.options.runtime,
      });
      for (const kept of residue.retained)
        this.options.log?.(`Residue retained for ${entry.jobId}: ${kept.path} (${kept.reason})\n`);
    } catch (error) {
      this.options.log?.(`Residue discard failed for ${entry.jobId}: ${errorMessage(error)}\n`);
    }
  }

  async discardConversationArtifacts(jobId: string): Promise<void> {
    const entry = readProjectionJobConversation(this.options.db(), jobId);
    if (entry === null || !entry.finishing) return;
    const address = { jobId, execution: entry.execution };
    const action = entry.retentionDiscard.attempts.find(
      (attempt) => attempt.execution === address.execution && attempt.status === 'requested',
    );
    if (action === undefined) return;
    const result = await this.settleRetention(address, {
      execution: address.execution,
      attempt: action.attempt,
      handles: action.handles,
    });
    if (result.kind === 'failed') this.options.log?.(`${result.reason}\n`);
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(this.inFlight.values());
  }
  async dispose(): Promise<void> {
    this.abort.abort();
    const settlements = await Promise.allSettled(this.inFlight.values());
    for (const settlement of settlements) {
      if (
        settlement.status === 'fulfilled' ||
        settlement.reason === this.abort.signal.reason ||
        (this.options.signal.aborted && settlement.reason === this.options.signal.reason)
      )
        continue;
      if (settlement.reason instanceof Error) throw settlement.reason;
      throw new Error(errorMessage(settlement.reason));
    }
  }
}

export function isLifecycleRetentionAdmitted(db: Database): boolean {
  return reactors.get(db)?.isRetentionAdmitted() === true;
}

export function createRetentionWorkRetryPlan(
  db: Database,
  subject: RecoverySubject,
  signal: AbortSignal,
): RecoverySourceFactoryPlan<
  EventsRow,
  { row: EventsRow; address: ExecutionAddress; action: JobRetentionDiscardRequestedBody }
> {
  const reactor = reactors.get(db);
  if (reactor === undefined) throw new Error('Conversation retention is not initialized.');
  if (!reactor.isRetentionAdmitted()) throw new Error('Conversation retention is not admitted.');
  return {
    source: retentionRecoverySource(db, reactor.readContext(), subject),
    policy: {
      processLocalCleanup: { kind: 'not-required' },
      requiredObligations: () => [RETENTION_OBLIGATION],
      hydrate: (row) => {
        const action = jobRetentionDiscardRequestedBodySchema.parse(decodeStoredBody(row, reactor.readContext()));
        return { row, address: { jobId: row.stream_id, execution: action.execution }, action };
      },
      settle: async (item) => {
        signal.throwIfAborted();
        const entry = readProjectionJobConversation(db, item.address.jobId);
        if (entry === null || !entry.finishing || entry.execution !== item.address.execution) {
          return {
            kind: 'advanced',
            outcome: 'settled',
            facts: [{ obligation: RETENTION_OBLIGATION, outcome: 'not-applicable' }],
            detail: 'Execution no longer owns retention.',
          };
        }
        const result = await reactor.settleRetention(item.address, item.action);
        return result.kind === 'pending' || result.kind === 'awaiting-issuer'
          ? {
              kind: 'deferred',
              authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
              detail:
                result.kind === 'awaiting-issuer'
                  ? `Removal observation exhausted; successor=original discard issuer release for ${result.actionId}.`
                  : 'Retention outcome remains unknown.',
            }
          : {
              kind: 'advanced',
              outcome: 'settled',
              facts: [{ obligation: RETENTION_OBLIGATION, outcome: 'done' }],
              detail: 'Retention outcome reconciled.',
            };
      },
      onFault: (fault) => ({ kind: 'quarantine', detail: errorMessage(fault.error) }),
    },
  };
}

export function createLifecycleReactor(options: LifecycleReactorOptions): LifecycleReactor {
  return new LifecycleReactor(options);
}
