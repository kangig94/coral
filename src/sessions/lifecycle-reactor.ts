import { backendLog } from '../infra/backend-log.js';
import { errorMessage } from '../infra/error-format.js';
import type { TimePort, TimerHandle } from '../infra/port-types.js';
import {
  ProviderArtifactProtocolInvariantError,
  type ArtifactCleanupRuntime,
  type DiscardOutcome,
  type ProviderArtifactDiscardReconciliation,
} from '../providers/contract.js';
import type { ProviderBindingCatalog } from '../providers/catalog.js';
import type { BoundProvider } from '../providers/bound-provider-contract.js';
import {
  RecoveryContainment,
  type RecoveryDisposition,
  type RecoveryFault,
  type RecoveryObligationId,
  type RecoveryQuarantinePort,
  type RecoveryReceipt,
  type RecoverySettlementFact,
  type RecoverySubject,
} from '../recovery/containment.js';
import type { RecoveryRetryPolicy, RecoverySourceFactoryPlan } from '../recovery/source-registry.js';
import { rawRetentionContinuationRowSchema, RecoveryQuarantineStore } from '../recovery/quarantine.js';
import {
  retentionWorkItemRecoverySource,
  type P4RetentionComponent,
  type RawRetentionWorkItem,
} from './retention-work-item-recovery-source.js';
import {
  retentionReleasePairComponentSource,
  type RawRetentionReleaseAndTerminalRow,
  type RetentionReleasePairComponent,
} from './retention-release-pair-recovery-source.js';
import {
  sessionContinuationLeaseRecoverySource,
  type RawPendingContinuationLeaseRow,
  type SessionContinuationLeaseComponent,
} from './continuation-lease-recovery-source.js';
import {
  sessionProjectionRecoverySource,
  type RawSessionProjectionEnvelope,
  type SessionProjectionComponent,
} from './projection-recovery-source.js';
import {
  terminalRetentionOutcomeRecoverySource,
  type RawTerminalRetentionOutcomeRow,
  type TerminalRetentionOutcomeComponent,
} from './terminal-retention-outcome-recovery-source.js';
import type { AppendedEvent, CommitEventsFn, PostCommitObserver } from '../store/append.js';
import type { Database } from '../store/db.js';
import { decodeStoredBody, type StoreReadContext } from '../store/body-codec.js';
import { decodeEventRefs } from '../store/envelope.js';
import type { EventsRow } from '../store/schema.js';
import { collectArtifactHandles } from './artifact-discard.js';
import { sessionContinuationLeaseExpiredEvent } from './continuation-lease-events.js';
import {
  archiveProviderArtifactsForJob,
  deriveProviderArtifactActionDescriptor,
  deriveProviderArtifactSourceRevision,
  ProviderArtifactArchiveInvariantError,
  type ProviderArtifactActionDescriptor,
} from './provider-artifact-archive.js';
import { listProjectionSessionEntries, readProjectionSessionEntriesById } from './projections.js';
import {
  appendRetentionDiscardCompleted,
  appendRetentionDiscardFailed,
  appendRetentionDiscardRequested,
  hasTerminalRetentionDiscardOutcome,
  readNextRetentionDiscardAttempt,
} from './retention-outbox.js';
import {
  hasUnterminalRetentionDiscardRequest,
  isProtectiveContinuationLease,
  providerSessionSchema,
  sessionControllerFromProfile,
  type ExpiredContinuationLease,
  type RetentionDiscardCompletedOutcome,
  type ProviderSession,
  providerSessionProvider,
} from './entry.js';
import {
  sessionClaimReleasedBodySchema,
  sessionRetentionDiscardCompletedBodySchema,
  sessionRetentionDiscardFailedBodySchema,
} from './event-bodies.js';
import { projectionSessionStoredRowSchema } from './projections.js';
import {
  sessionRetentionWorkKey,
  type SessionRetentionPair,
  type SessionRetentionWork,
  type RecoverySessionRetentionWork,
  type RetentionDiscardContinuation,
  hydrateRecoverySessionRetentionWork,
  retentionRecoveryFact,
  RETENTION_ATTEMPT_OBLIGATION,
  RETENTION_DISCARD_CONTINUATION_KIND,
  RETENTION_PROVIDER_DISCARD_OBLIGATION,
  RETENTION_TERMINAL_OBLIGATION,
  RETENTION_WORK_OBLIGATIONS,
} from './retention-work.js';
import { runSessionStartupRecovery } from './startup-recovery.js';

export type LifecycleReactorOptions = {
  readonly db: () => Database;
  readonly readCtx: StoreReadContext;
  readonly providers: ProviderBindingCatalog;
  readonly runtime: ArtifactCleanupRuntime;
  readonly time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  readonly commitEvents: CommitEventsFn;
  readonly signal: AbortSignal;
  readonly log?: (message: string) => void;
};

const SESSION_COMPONENT_OBLIGATION = 'session.retention.session-component' as RecoveryObligationId;
const LEASE_COMPONENT_OBLIGATION = 'session.retention.lease-component' as RecoveryObligationId;
const LEASE_EXPIRY_OBLIGATION = 'session.retention.lease-expiry' as RecoveryObligationId;
const OUTCOME_COMPONENT_OBLIGATION = 'session.retention.outcome-component' as RecoveryObligationId;
const RELEASE_COMPONENT_OBLIGATION = 'session.retention.release-terminal-component' as RecoveryObligationId;

function validateProjectionCoordinates(
  row: RawPendingContinuationLeaseRow,
  entry: ProviderSession,
  label: string,
): void {
  if (entry.sessionId !== row.session_id) {
    throw new TypeError(`${label} key '${row.session_id}' contradicts entry '${entry.sessionId}'.`);
  }
  if (
    row.controller !== sessionControllerFromProfile(entry.controllerProfile) ||
    row.resumable !== (entry.state === 'ready' ? 1 : 0) ||
    row.conversation_ref !== (entry.conversationRef ?? null)
  ) {
    throw new TypeError(`${label} '${row.session_id}' has contradictory denormalized fields.`);
  }
}

function hydrateSessionProjectionComponent(raw: RawSessionProjectionEnvelope): SessionProjectionComponent {
  const row = projectionSessionStoredRowSchema.parse(raw.row);
  const retentionContinuations = raw.retentionContinuations.map((continuation) =>
    rawRetentionContinuationRowSchema.parse(continuation),
  );
  const rawEntry = JSON.parse(row.entry) as unknown;
  if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
    throw new TypeError(`Projection session '${row.session_id}' has a non-object entry.`);
  }
  const hasContinuationLeaseField = Object.prototype.hasOwnProperty.call(rawEntry, 'continuationLease');
  const { continuationLease: _lease, ...baseEntry } = rawEntry as Record<string, unknown>;
  const entry = providerSessionSchema.parse(baseEntry);
  validateProjectionCoordinates(row, entry, 'Projection session');
  return {
    kind: 'session',
    row,
    entry,
    hasContinuationLeaseField,
    retentionContinuations,
  };
}

function hydrateSessionContinuationLeaseComponent(
  raw: RawPendingContinuationLeaseRow,
  nowMs: number,
): SessionContinuationLeaseComponent {
  const row = projectionSessionStoredRowSchema.parse(raw);
  const entry = providerSessionSchema.parse(JSON.parse(row.entry) as unknown);
  validateProjectionCoordinates(row, entry, 'Continuation lease projection');
  if (entry.continuationLease === undefined) {
    throw new TypeError(`Continuation lease projection '${row.session_id}' has no lease.`);
  }
  const overdueLease =
    entry.continuationLease.status === 'pending' && Date.parse(entry.continuationLease.expiresAt) <= nowMs
      ? entry.continuationLease
      : null;
  if (overdueLease === null) {
    return {
      kind: 'lease',
      row,
      persistedEntry: entry,
      effectiveEntry: entry,
      protectsRetention: isProtectiveContinuationLease(entry.continuationLease, nowMs),
      overdueLease: null,
    };
  }
  const expiredAt = new Date(nowMs).toISOString();
  const expiredLease: ExpiredContinuationLease = {
    staleJobId: overdueLease.staleJobId,
    workflowId: overdueLease.workflowId,
    workflowSlotId: overdueLease.workflowSlotId,
    replacementGeneration: overdueLease.replacementGeneration,
    reason: overdueLease.reason,
    expiresAt: overdueLease.expiresAt,
    recordedAt: overdueLease.recordedAt,
    status: 'expired',
    expiredAt,
  };
  return {
    kind: 'lease',
    row,
    persistedEntry: entry,
    effectiveEntry: {
      ...entry,
      continuationLease: expiredLease,
      lastUsedAt: expiredAt,
      version: entry.version + 1,
    },
    protectsRetention: false,
    overdueLease,
  };
}

function hydrateTerminalRetentionOutcomeComponent(
  row: RawTerminalRetentionOutcomeRow,
  readCtx: StoreReadContext,
): TerminalRetentionOutcomeComponent {
  const decoded = decodeStoredBody(row, readCtx);
  if (row.type === 'session.retention.discard.failed') {
    const body = sessionRetentionDiscardFailedBodySchema.parse(decoded);
    if (body.sessionId !== row.stream_id) {
      throw new TypeError(`Retention failure event ${row.seq} contradicts its session stream.`);
    }
    return { kind: 'terminal-outcome', row, sessionId: body.sessionId, terminal: true };
  }
  if (row.type !== 'session.retention.discard.completed') {
    throw new TypeError(`Unexpected retention outcome event '${row.type}'.`);
  }
  const body = sessionRetentionDiscardCompletedBodySchema.parse(decoded);
  if (body.sessionId !== row.stream_id) {
    throw new TypeError(`Retention completion event ${row.seq} contradicts its session stream.`);
  }
  return {
    kind: 'terminal-outcome',
    row,
    sessionId: body.sessionId,
    terminal: body.outcome !== 'skipped_protected',
  };
}

function hydrateRetentionReleasePairComponent(
  row: RawRetentionReleaseAndTerminalRow,
  readCtx: StoreReadContext,
): RetentionReleasePairComponent {
  const decoded = decodeStoredBody(row, readCtx);
  const refs = decodeEventRefs(row);
  if (row.type === 'session.claim.released') {
    const body = sessionClaimReleasedBodySchema.parse(decoded);
    const sessionId = refs?.sessionId ?? row.stream_id;
    const jobId = refs?.jobId ?? body.jobId;
    if (sessionId !== row.stream_id || body.entry.sessionId !== sessionId || body.jobId !== jobId) {
      throw new TypeError(`Session release event ${row.seq} has contradictory session/job coordinates.`);
    }
    return { kind: 'release', row, sessionId, jobId, entry: body.entry };
  }
  if (row.type !== 'job.terminal.recorded') {
    throw new TypeError(`Unexpected retention pair event '${row.type}'.`);
  }
  // The retention pair reads nothing out of a terminal body — only its stream, refs and seq — and a
  // corrupt body already fails `decodeStoredBody` above. Re-validating jobs' own event shape here
  // would make sessions depend on jobs at runtime for a value it discards.
  const sessionId = refs?.sessionId;
  if (sessionId === undefined) {
    throw new TypeError(`Job terminal event ${row.seq} has no refs.sessionId.`);
  }
  return { kind: 'terminal', row, sessionId, jobId: row.stream_id };
}

function recoveryFact(
  obligation: RecoveryObligationId,
  outcome: RecoverySettlementFact['outcome'],
  authorityRef?: string,
): RecoverySettlementFact {
  return { obligation, outcome, ...(authorityRef === undefined ? {} : { authorityRef }) };
}

function componentFaultDisposition<Raw, Item>(fault: RecoveryFault<Raw, Item>): RecoveryDisposition {
  return fault.stage === 'scan'
    ? { kind: 'fatal', error: fault.error }
    : {
        kind: 'quarantine',
        detail: `P4 ${fault.stage} failed for ${fault.subject.key}: ${errorMessage(fault.error)}`,
      };
}

function appendedRetentionPair(event: AppendedEvent): SessionRetentionPair | null {
  if (event.type === 'job.terminal.recorded') {
    const sessionId = event.refs?.sessionId;
    return event.stream.kind === 'job' && typeof sessionId === 'string' && sessionId.length > 0
      ? { sessionId, jobId: event.stream.id }
      : null;
  }
  if (event.type !== 'session.claim.released') return null;
  const sessionId = event.refs?.sessionId ?? (event.stream.kind === 'session' ? event.stream.id : undefined);
  const jobId = event.refs?.jobId;
  return typeof sessionId === 'string' && sessionId.length > 0 && typeof jobId === 'string' && jobId.length > 0
    ? { sessionId, jobId }
    : null;
}

function isContinuationLeaseEvent(event: AppendedEvent): boolean {
  return (
    event.type === 'session.continuation_lease.recorded' ||
    event.type === 'session.continuation_lease.claimed' ||
    event.type === 'session.continuation_lease.cleared' ||
    event.type === 'session.continuation_lease.expired'
  );
}

function isRetentionSkippedOrCancelled(event: AppendedEvent): boolean {
  if (event.type !== 'session.retention.discard.completed') {
    return false;
  }
  return (event.body as { outcome?: unknown }).outcome === 'skipped_protected';
}

const lifecycleReactorsByDatabase = new WeakMap<Database, LifecycleReactor>();

export class LifecycleReactor {
  private readonly pendingBySession = new Map<string, Set<string>>();
  private readonly inFlightPairs = new Set<string>();
  private readonly rerunPairs = new Set<string>();
  private drainPromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private recoveryRerunRequested = false;
  private containedRecoveryDepth = 0;
  private continuationLeaseTimer: TimerHandle | null = null;
  private readonly disposeAbort = new AbortController();
  private readonly lifetimeSignal: AbortSignal;

  private readonly options: LifecycleReactorOptions;
  constructor(options: LifecycleReactorOptions) {
    this.options = options;
    this.lifetimeSignal = AbortSignal.any([options.signal, this.disposeAbort.signal]);
  }

  private async readyBoundProvider(entry: ProviderSession, operation: string): Promise<BoundProvider | null> {
    const providerName = providerSessionProvider(entry);
    const binding = this.options.providers.rehydrateBinding(entry.binding);
    if (!binding.ok || binding.value.name !== providerName) {
      this.log(
        `${operation} skipped for session ${entry.sessionId}: ${
          binding.ok
            ? `binding provider '${binding.value.name}' does not match session provider '${providerName}'`
            : this.options.providers.renderBindingFailure(binding.failure)
        }.`,
      );
      return null;
    }
    const readiness = await binding.value.readiness('recovery', this.options.runtime.storage);
    if (!readiness.ok) {
      this.log(
        `${operation} skipped for session ${entry.sessionId}: ${this.options.providers.renderBindingFailure(readiness.failure)}`,
      );
      return null;
    }
    return binding.value;
  }

  readonly observe: PostCommitObserver = (appended) => {
    if (this.lifetimeSignal.aborted) return;
    const queuePairs = new Map<string, SessionRetentionPair>();
    const skippedSessionIds = new Set<string>();
    let sawContinuationLeaseEvent = false;
    for (const event of appended) {
      if (isContinuationLeaseEvent(event)) {
        sawContinuationLeaseEvent = true;
      }
      const pair = appendedRetentionPair(event);
      if (pair !== null) {
        queuePairs.set(sessionRetentionWorkKey(pair.sessionId, pair.jobId), pair);
      }
      if (this.containedRecoveryDepth === 0 && isRetentionSkippedOrCancelled(event)) {
        const sessionId = event.refs?.sessionId ?? (event.stream.kind === 'session' ? event.stream.id : undefined);
        if (typeof sessionId === 'string' && sessionId.length > 0) skippedSessionIds.add(sessionId);
      }
    }

    if (sawContinuationLeaseEvent) {
      void this.runContainedRecovery(this.lifetimeSignal).catch((error: unknown) => {
        this.log(`Continuation lease recovery failed: ${errorMessage(error)}`);
      });
    }
    for (const pair of queuePairs.values()) this.enqueue(pair.sessionId, pair.jobId);
    for (const sessionId of skippedSessionIds) {
      const jobId = this.latestTerminalJobId(sessionId);
      if (jobId !== null) this.enqueue(sessionId, jobId);
    }
    this.scheduleDrain();
  };

  async scanStartup(signal: AbortSignal): Promise<void> {
    await this.runContainedRecovery(AbortSignal.any([this.lifetimeSignal, signal]));
    await this.waitForIdle();
  }

  private runContainedRecovery(signal: AbortSignal): Promise<void> {
    if (this.recoveryPromise !== null) {
      this.recoveryRerunRequested = true;
      return this.recoveryPromise;
    }
    const promise = (async () => {
      do {
        this.recoveryRerunRequested = false;
        await this.performContainedRecovery(signal);
      } while (this.recoveryRerunRequested && !signal.aborted);
    })().finally(() => {
      if (this.recoveryPromise === promise) this.recoveryPromise = null;
    });
    this.recoveryPromise = promise;
    return promise;
  }

  createRecoveryPolicies(
    quarantine: RecoveryQuarantinePort,
    timerCandidates: SessionContinuationLeaseComponent[],
  ): {
    readonly sessions: RecoveryRetryPolicy<RawSessionProjectionEnvelope, SessionProjectionComponent>;
    readonly continuationLeases: RecoveryRetryPolicy<RawPendingContinuationLeaseRow, SessionContinuationLeaseComponent>;
    readonly terminalOutcomes: RecoveryRetryPolicy<RawTerminalRetentionOutcomeRow, TerminalRetentionOutcomeComponent>;
    readonly releasePairs: RecoveryRetryPolicy<RawRetentionReleaseAndTerminalRow, RetentionReleasePairComponent>;
    readonly retentionWork: RecoveryRetryPolicy<RawRetentionWorkItem, RecoverySessionRetentionWork>;
  } {
    return {
      sessions: {
        processLocalCleanup: { kind: 'not-required' },
        issueReceipts: true,
        hydrate: hydrateSessionProjectionComponent,
        requiredObligations: () => [SESSION_COMPONENT_OBLIGATION],
        settle: (component) => ({
          kind: 'advanced',
          outcome: 'settled',
          facts: [
            recoveryFact(SESSION_COMPONENT_OBLIGATION, 'done', `projection_sessions:${component.row.session_id}`),
          ],
          detail: 'session projection component hydrated',
        }),
        onFault: componentFaultDisposition,
      },
      continuationLeases: {
        processLocalCleanup: { kind: 'not-required' },
        issueReceipts: true,
        hydrate: (raw) => hydrateSessionContinuationLeaseComponent(raw, this.options.time.now()),
        requiredObligations: () => [LEASE_COMPONENT_OBLIGATION, LEASE_EXPIRY_OBLIGATION],
        settle: (component) => {
          if (component.overdueLease === null) {
            if (component.persistedEntry.continuationLease?.status === 'pending') timerCandidates.push(component);
            return {
              kind: 'advanced',
              outcome: 'settled',
              facts: [
                recoveryFact(LEASE_COMPONENT_OBLIGATION, 'done', `projection_sessions:${component.row.session_id}`),
                recoveryFact(LEASE_EXPIRY_OBLIGATION, 'not-applicable'),
              ],
              detail: 'continuation lease hydrated for timer scheduling',
            };
          }
          const expiredLease = component.effectiveEntry.continuationLease;
          if (expiredLease?.status !== 'expired') {
            throw new Error(`Continuation lease '${component.row.session_id}' did not hydrate an expiry transition.`);
          }
          this.options.commitEvents((commit) => {
            commit.append(sessionContinuationLeaseExpiredEvent(component.effectiveEntry, expiredLease));
            return undefined;
          });
          return {
            kind: 'advanced',
            outcome: 'settled',
            facts: [
              recoveryFact(LEASE_COMPONENT_OBLIGATION, 'done', `projection_sessions:${component.row.session_id}`),
              recoveryFact(
                LEASE_EXPIRY_OBLIGATION,
                'done',
                `session.continuation_lease.expired:${component.row.session_id}`,
              ),
            ],
            detail: 'overdue continuation lease expired atomically',
          };
        },
        onFault: componentFaultDisposition,
      },
      terminalOutcomes: {
        processLocalCleanup: { kind: 'not-required' },
        issueReceipts: true,
        hydrate: (raw) => hydrateTerminalRetentionOutcomeComponent(raw, this.options.readCtx),
        requiredObligations: () => [OUTCOME_COMPONENT_OBLIGATION],
        settle: (component) => ({
          kind: 'advanced',
          outcome: 'settled',
          facts: [recoveryFact(OUTCOME_COMPONENT_OBLIGATION, 'done', `events:${component.row.seq}`)],
          detail: 'terminal retention outcome hydrated',
        }),
        onFault: componentFaultDisposition,
      },
      releasePairs: {
        processLocalCleanup: { kind: 'not-required' },
        issueReceipts: true,
        hydrate: (raw) => hydrateRetentionReleasePairComponent(raw, this.options.readCtx),
        requiredObligations: () => [RELEASE_COMPONENT_OBLIGATION],
        settle: (component) => ({
          kind: 'advanced',
          outcome: 'settled',
          facts: [recoveryFact(RELEASE_COMPONENT_OBLIGATION, 'done', `events:${component.row.seq}`)],
          detail: 'release or terminal component hydrated',
        }),
        onFault: componentFaultDisposition,
      },
      retentionWork: {
        processLocalCleanup: { kind: 'not-required' },
        hydrate: hydrateRecoverySessionRetentionWork,
        requiredObligations: () => RETENTION_WORK_OBLIGATIONS,
        settle: (work) => this.enforceRetention(work),
        onFault: (fault) => {
          if (
            fault.error instanceof ProviderArtifactArchiveInvariantError ||
            fault.error instanceof ProviderArtifactProtocolInvariantError
          ) {
            return { kind: 'fatal', error: fault.error };
          }
          return componentFaultDisposition(fault);
        },
      },
    };
  }

  private async performContainedRecovery(signal: AbortSignal): Promise<void> {
    const db = this.options.db();
    const quarantine = new RecoveryQuarantineStore(db, this.options.time);
    const timerCandidates: SessionContinuationLeaseComponent[] = [];
    const policies = this.createRecoveryPolicies(quarantine, timerCandidates);
    lifecycleReactorsByDatabase.set(db, this);

    this.containedRecoveryDepth += 1;
    try {
      await runSessionStartupRecovery({
        sessions: { source: sessionProjectionRecoverySource(db), policy: { signal, quarantine, ...policies.sessions } },
        continuationLeases: {
          source: sessionContinuationLeaseRecoverySource(db),
          policy: { signal, quarantine, ...policies.continuationLeases },
        },
        terminalOutcomes: {
          source: terminalRetentionOutcomeRecoverySource(db),
          policy: { signal, quarantine, ...policies.terminalOutcomes },
        },
        releasePairs: {
          source: retentionReleasePairComponentSource(db),
          policy: { signal, quarantine, ...policies.releasePairs },
        },
        retentionWork: {
          settle: async (receipts) => {
            await RecoveryContainment.each(retentionWorkItemRecoverySource(receipts), {
              signal,
              quarantine,
              ...policies.retentionWork,
            });
          },
        },
      });
      this.scheduleContinuationLeaseTimer(timerCandidates);
    } finally {
      this.containedRecoveryDepth -= 1;
    }
  }

  async dispose(): Promise<void> {
    this.disposeAbort.abort();
    this.clearContinuationLeaseTimer();
    while (this.drainPromise !== null || this.recoveryPromise !== null) {
      await Promise.allSettled([this.drainPromise, this.recoveryPromise].filter((promise) => promise !== null));
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.drainPromise !== null || this.recoveryPromise !== null) {
      await Promise.all([this.drainPromise, this.recoveryPromise].filter((promise) => promise !== null));
    }
  }

  /**
   * Discard a completed session's provider native artifacts on demand, bypassing
   * the retention policy gate — used when an owning lifecycle concludes (e.g. a
   * discussion is fully synthesized) for sessions that were retained across turns.
   * Best-effort and event-free; the reactor remains the single site permitted to
   * invoke `discardArtifacts` (see `tests/invariants/cleanup-discipline.test.ts`).
   */
  async discardSessionArtifacts(sessionId: string): Promise<void> {
    const entry = readProjectionSessionEntriesById(this.options.db(), [sessionId]).get(sessionId);
    if (!entry) return;
    const bound = await this.readyBoundProvider(entry, 'On-demand artifact discard');
    if (bound === null) return;
    if (bound.artifacts.kind !== 'managed') {
      this.log(
        `On-demand artifact discard skipped for session ${sessionId}: provider '${providerSessionProvider(entry)}' declares no artifacts.`,
      );
      return;
    }
    const handles = collectArtifactHandles(entry, bound, this.options.runtime);
    if (handles.length === 0) return;
    const handlesByJob = new Map<string, string[]>();
    const metadataByHandle = new Map(entry.artifactHandles.map((artifact) => [artifact.handle, artifact]));
    for (const handle of handles) {
      const jobId = metadataByHandle.get(handle)?.sourceJobId ?? this.latestTerminalJobId(sessionId);
      if (jobId === null) {
        this.log(`On-demand artifact discard skipped for session ${sessionId}: no persisted job envelope.`);
        continue;
      }
      const jobHandles = handlesByJob.get(jobId) ?? [];
      jobHandles.push(handle);
      handlesByJob.set(jobId, jobHandles);
    }
    for (const [jobId, jobHandles] of handlesByJob) {
      const terminal = this.readTerminalEvent(sessionId, jobId);
      const release = this.readReleaseEvent(sessionId, jobId);
      if (terminal === null || release === null) continue;
      const descriptor = deriveProviderArtifactActionDescriptor({
        entry: release.entry,
        jobId,
        handles: jobHandles,
        sourceRevision: deriveProviderArtifactSourceRevision({
          sessionId,
          jobId,
          release: release.row,
          terminal,
        }),
        archivedAt: terminal.ts,
      });
      await this.archiveArtifactsBeforeDiscard(descriptor);
      try {
        const reconciled = await bound.artifacts.reconcileDiscard({
          handles: jobHandles,
          actionId: descriptor.discardActionId,
          payloadHash: descriptor.discardPayloadHash,
          runtime: this.options.runtime,
        });
        if (reconciled.kind === 'applied') continue;
        if (reconciled.kind === 'definitive-failure') {
          this.log(`On-demand artifact discard failed for session ${sessionId}: ${reconciled.reason}`);
          continue;
        }
        if (reconciled.kind === 'unknown') {
          this.log(`On-demand artifact discard remains unknown for session ${sessionId}; replay was not attempted.`);
          continue;
        }
        await bound.artifacts.discardArtifacts({
          handles: jobHandles,
          actionId: descriptor.discardActionId,
          payloadHash: descriptor.discardPayloadHash,
          runtime: this.options.runtime,
        });
      } catch (error: unknown) {
        if (
          error instanceof ProviderArtifactArchiveInvariantError ||
          error instanceof ProviderArtifactProtocolInvariantError
        ) {
          throw error;
        }
        this.log(`On-demand artifact discard failed for session ${sessionId}: ${errorMessage(error)}`);
      }
    }
  }

  async enforceRetention(work: SessionRetentionWork): Promise<RecoveryDisposition> {
    const recoveryWork: RecoverySessionRetentionWork = isRecoveryRetentionWork(work)
      ? work
      : this.legacyRecoveryWork(work);
    const { jobId, sessionId } = recoveryWork;
    if (hasTerminalRetentionDiscardOutcome(this.options.db(), this.options.readCtx, sessionId)) {
      return this.retentionAdvanced('retention outcome already terminal', 'not-applicable');
    }

    const bound = await this.readyBoundProvider(recoveryWork.entry, 'Retention discard');
    if (bound === null) {
      throw new Error(`Retention provider binding is unavailable for session ${sessionId}.`);
    }
    const recoveredContinuation = recoveryWork.recovery.continuation;
    let continuation: RetentionDiscardContinuation;
    if (recoveredContinuation === null) {
      const handles = collectArtifactHandles(recoveryWork.entry, bound, this.options.runtime, { jobId });
      const attempt = readNextRetentionDiscardAttempt(this.options.db(), this.options.readCtx, sessionId, 0);
      const descriptor = deriveProviderArtifactActionDescriptor({
        entry: recoveryWork.entry,
        jobId,
        handles,
        sourceRevision: recoveryWork.recovery.sourceRevision,
        archivedAt: recoveryWork.recovery.archivedAt,
      });
      continuation = {
        v: 1,
        sessionId,
        jobId,
        sourceRevision: recoveryWork.recovery.sourceRevision,
        attempt,
        handles,
        descriptor,
        terminalCauseRef: recoveryWork.recovery.terminalCauseRef,
        completedObligationIds: [],
        stage: 'prepared',
      };
    } else {
      continuation = recoveredContinuation;
      this.assertContinuationDescriptor(recoveryWork.entry, continuation);
    }
    this.persistRetentionContinuation(recoveryWork, continuation);

    if (continuation.stage === 'prepared') {
      appendRetentionDiscardRequested(this.options.commitEvents, {
        sessionId,
        attempt: continuation.attempt,
        handles: continuation.handles,
      });
      continuation = this.advanceContinuation(continuation, {
        stage: 'requested',
        completed: RETENTION_ATTEMPT_OBLIGATION,
      });
      this.persistRetentionContinuation(recoveryWork, continuation);
    }

    const freshEntry = this.readFreshProviderSession(sessionId);
    if (freshEntry === null || this.hasRetentionProtection(freshEntry)) {
      return this.completeRetentionNoEffect(recoveryWork, continuation, 'skipped_protected');
    }
    if (bound.artifacts.kind === 'none') {
      return this.completeRetentionNoEffect(recoveryWork, continuation, 'provider_declares_none');
    }
    if (continuation.handles.length === 0) {
      return this.completeRetentionNoEffect(recoveryWork, continuation, 'skipped_no_handles');
    }

    await this.archiveArtifactsBeforeDiscard(continuation.descriptor);
    if (continuation.stage === 'requested') {
      continuation = { ...continuation, stage: 'discard-pending' };
      this.persistRetentionContinuation(recoveryWork, continuation);
      try {
        const outcome = await bound.artifacts.discardArtifacts({
          handles: continuation.handles,
          actionId: continuation.descriptor.discardActionId,
          payloadHash: continuation.descriptor.discardPayloadHash,
          runtime: this.options.runtime,
        });
        continuation = this.recordAppliedDiscard(continuation, outcome);
        this.persistRetentionContinuation(recoveryWork, continuation);
      } catch (error: unknown) {
        const reconciled = await this.reconcileDiscard(bound, continuation);
        if (reconciled.kind === 'definitive-failure') {
          return this.failRetention(recoveryWork, continuation, reconciled.reason);
        }
        if (reconciled.kind === 'applied') {
          continuation = this.recordAppliedDiscard(continuation, reconciled.outcome);
          this.persistRetentionContinuation(recoveryWork, continuation);
        } else if (reconciled.kind === 'unknown') {
          return this.deferUnknownProviderOutcome(
            continuation,
            `provider discard outcome remains unknown: ${errorMessage(error)}`,
          );
        } else {
          throw error;
        }
      }
    } else if (continuation.stage === 'discard-pending') {
      const reconciled = await this.reconcileDiscard(bound, continuation);
      if (reconciled.kind === 'unknown') {
        return this.deferUnknownProviderOutcome(continuation, 'provider discard reconciliation remains unknown');
      }
      if (reconciled.kind === 'definitive-failure') {
        return this.failRetention(recoveryWork, continuation, reconciled.reason);
      }
      if (reconciled.kind === 'not-applied') {
        try {
          const outcome = await bound.artifacts.discardArtifacts({
            handles: continuation.handles,
            actionId: continuation.descriptor.discardActionId,
            payloadHash: continuation.descriptor.discardPayloadHash,
            runtime: this.options.runtime,
          });
          continuation = this.recordAppliedDiscard(continuation, outcome);
          this.persistRetentionContinuation(recoveryWork, continuation);
        } catch (error: unknown) {
          const replayReconciliation = await this.reconcileDiscard(bound, continuation);
          if (replayReconciliation.kind === 'definitive-failure') {
            return this.failRetention(recoveryWork, continuation, replayReconciliation.reason);
          }
          if (replayReconciliation.kind === 'applied') {
            continuation = this.recordAppliedDiscard(continuation, replayReconciliation.outcome);
            this.persistRetentionContinuation(recoveryWork, continuation);
          } else if (replayReconciliation.kind === 'unknown') {
            return this.deferUnknownProviderOutcome(
              continuation,
              `provider discard replay outcome remains unknown: ${errorMessage(error)}`,
            );
          } else {
            throw error;
          }
        }
      } else {
        continuation = this.recordAppliedDiscard(continuation, reconciled.outcome);
        this.persistRetentionContinuation(recoveryWork, continuation);
      }
    }

    const observed = continuation.observedOutcome;
    if (continuation.stage !== 'discard-applied' || observed?.kind !== 'applied') {
      throw new Error(`Retention discard '${continuation.descriptor.discardActionId}' has no durable applied outcome.`);
    }
    try {
      appendRetentionDiscardCompleted(this.options.commitEvents, {
        sessionId,
        attempt: continuation.attempt,
        handles: continuation.handles,
        outcome: observed.outcome as RetentionDiscardCompletedOutcome,
      });
    } catch (error: unknown) {
      return this.deferFailedDurableClose(continuation, `retention completion append failed: ${errorMessage(error)}`);
    }
    this.clearRetentionContinuation(recoveryWork, continuation);
    return this.retentionAdvanced(
      'retention discard reconciled and completed',
      'done',
      continuation.descriptor.discardActionId,
    );
  }

  private async archiveArtifactsBeforeDiscard(descriptor: ProviderArtifactActionDescriptor): Promise<void> {
    try {
      await archiveProviderArtifactsForJob({ runtime: this.options.runtime, descriptor });
    } catch (error: unknown) {
      if (error instanceof ProviderArtifactArchiveInvariantError) throw error;
      this.log(
        `Provider artifact archive failed for session ${descriptor.sessionId} job ${descriptor.jobId}: ${errorMessage(error)}`,
      );
    }
  }

  private legacyRecoveryWork(work: SessionRetentionWork): RecoverySessionRetentionWork {
    const terminal = this.readTerminalEvent(work.sessionId, work.jobId);
    const release = this.readReleaseEvent(work.sessionId, work.jobId);
    if (terminal === null || release === null) {
      throw new Error(
        `Retention work ${sessionRetentionWorkKey(work.sessionId, work.jobId)} has no complete envelope.`,
      );
    }
    const sourceRevision = deriveProviderArtifactSourceRevision({
      sessionId: work.sessionId,
      jobId: work.jobId,
      release: release.row,
      terminal,
    });
    const subject: RecoverySubject = {
      key: sessionRetentionWorkKey(work.sessionId, work.jobId),
      revision: { kind: 'fingerprint', value: sourceRevision },
    };
    return {
      ...work,
      entry: release.entry,
      recovery: {
        subject,
        sourceRevision,
        terminalCauseRef: { stream: { kind: 'job', id: work.jobId }, seq: terminal.seq },
        archivedAt: terminal.ts,
        continuation: null,
      },
    };
  }

  private latestTerminalJobId(sessionId: string): string | null {
    return (
      this.options
        .db()
        .prepare<[string], { stream_id: string }>(
          `SELECT stream_id
             FROM events
            WHERE type = 'job.terminal.recorded'
              AND json_extract(refs, '$.sessionId') = ?
            ORDER BY seq DESC
            LIMIT 1`,
        )
        .get(sessionId)?.stream_id ?? null
    );
  }

  private readReleaseEvent(
    sessionId: string,
    jobId: string,
  ): { readonly row: EventsRow; readonly entry: ProviderSession } | null {
    const row = this.options
      .db()
      .prepare<[string, string], EventsRow>(
        `SELECT *
           FROM events
          WHERE type = 'session.claim.released'
            AND stream_id = ?
            AND json_extract(refs, '$.jobId') = ?
          ORDER BY seq DESC
          LIMIT 1`,
      )
      .get(sessionId, jobId);
    if (row === undefined) return null;
    const body = sessionClaimReleasedBodySchema.parse(decodeStoredBody(row, this.options.readCtx));
    if (body.entry.sessionId !== sessionId || body.jobId !== jobId) {
      throw new ProviderArtifactArchiveInvariantError(
        `On-demand artifact release envelope contradicts ${sessionId}/${jobId}.`,
      );
    }
    return { row, entry: body.entry };
  }

  private assertContinuationDescriptor(entry: ProviderSession, continuation: RetentionDiscardContinuation): void {
    const expected = deriveProviderArtifactActionDescriptor({
      entry,
      jobId: continuation.jobId,
      handles: continuation.handles,
      sourceRevision: continuation.sourceRevision,
      archivedAt: continuation.descriptor.archivedAt,
    });
    if (JSON.stringify(expected) !== JSON.stringify(continuation.descriptor)) {
      throw new ProviderArtifactProtocolInvariantError(
        `Retention action '${continuation.descriptor.operationId}' conflicts with its persisted payload.`,
      );
    }
  }

  private persistRetentionContinuation(
    work: RecoverySessionRetentionWork,
    continuation: RetentionDiscardContinuation,
  ): void {
    const persisted = new RecoveryQuarantineStore(this.options.db(), this.options.time).upsert({
      boundary: 'session-retention-work',
      subject: work.recovery.subject,
      state: 'continuation',
      stage: 'settle',
      errorMessage: 'retention discard remains in progress',
      detail: `retention discard stage ${continuation.stage}`,
      continuation: {
        kind: RETENTION_DISCARD_CONTINUATION_KIND,
        key: JSON.stringify(continuation),
      },
    });
    if (!persisted) {
      throw new Error(`Retention continuation lost authority for ${work.recovery.subject.key}.`);
    }
  }

  private clearRetentionContinuation(
    work: RecoverySessionRetentionWork,
    continuation: RetentionDiscardContinuation,
  ): void {
    const deleted = new RecoveryQuarantineStore(this.options.db(), this.options.time).delete({
      boundary: 'session-retention-work',
      subject: work.recovery.subject,
    });
    if (!deleted) {
      throw new Error(`Retention continuation completion lost authority for ${continuation.sessionId}.`);
    }
  }

  private advanceContinuation(
    continuation: RetentionDiscardContinuation,
    change: { readonly stage: RetentionDiscardContinuation['stage']; readonly completed: RecoveryObligationId },
  ): RetentionDiscardContinuation {
    return {
      ...continuation,
      stage: change.stage,
      completedObligationIds: [...new Set([...continuation.completedObligationIds, change.completed])],
    };
  }

  private recordAppliedDiscard(
    continuation: RetentionDiscardContinuation,
    outcome: DiscardOutcome,
  ): RetentionDiscardContinuation {
    return {
      ...continuation,
      stage: 'discard-applied',
      observedOutcome: { kind: 'applied', outcome: outcome.kind },
      completedObligationIds: [
        ...new Set([...continuation.completedObligationIds, RETENTION_PROVIDER_DISCARD_OBLIGATION]),
      ],
    };
  }

  private async reconcileDiscard(
    bound: BoundProvider,
    continuation: RetentionDiscardContinuation,
  ): Promise<ProviderArtifactDiscardReconciliation> {
    if (bound.artifacts.kind !== 'managed') {
      throw new ProviderArtifactProtocolInvariantError(
        `Retention action '${continuation.descriptor.operationId}' lost its managed artifact capability.`,
      );
    }
    return bound.artifacts.reconcileDiscard({
      handles: continuation.handles,
      actionId: continuation.descriptor.discardActionId,
      payloadHash: continuation.descriptor.discardPayloadHash,
      runtime: this.options.runtime,
    });
  }

  private deferUnknownProviderOutcome(continuation: RetentionDiscardContinuation, detail: string): RecoveryDisposition {
    return this.retentionDeferred(continuation, detail);
  }

  private deferFailedDurableClose(continuation: RetentionDiscardContinuation, detail: string): RecoveryDisposition {
    return this.retentionDeferred(continuation, detail);
  }

  private retentionDeferred(continuation: RetentionDiscardContinuation, detail: string): RecoveryDisposition {
    return {
      kind: 'deferred',
      continuation: {
        kind: RETENTION_DISCARD_CONTINUATION_KIND,
        key: JSON.stringify(continuation),
      },
      detail,
    };
  }

  private completeRetentionNoEffect(
    work: RecoverySessionRetentionWork,
    continuation: RetentionDiscardContinuation,
    outcome: Extract<
      RetentionDiscardCompletedOutcome,
      'skipped_protected' | 'provider_declares_none' | 'skipped_no_handles'
    >,
  ): RecoveryDisposition {
    try {
      appendRetentionDiscardCompleted(this.options.commitEvents, {
        sessionId: continuation.sessionId,
        attempt: continuation.attempt,
        handles: continuation.handles,
        outcome,
      });
    } catch (error: unknown) {
      return this.deferFailedDurableClose(continuation, `retention no-effect append failed: ${errorMessage(error)}`);
    }
    this.clearRetentionContinuation(work, continuation);
    return this.retentionAdvanced('retention completed without provider effect', 'not-applicable');
  }

  private failRetention(
    work: RecoverySessionRetentionWork,
    continuation: RetentionDiscardContinuation,
    reason: string,
  ): RecoveryDisposition {
    const failed: RetentionDiscardContinuation = {
      ...continuation,
      observedOutcome: { kind: 'definitive-failure', reason },
      completedObligationIds: [
        ...new Set([...continuation.completedObligationIds, RETENTION_PROVIDER_DISCARD_OBLIGATION]),
      ],
    };
    this.persistRetentionContinuation(work, failed);
    try {
      appendRetentionDiscardFailed(this.options.commitEvents, {
        sessionId: failed.sessionId,
        attempt: failed.attempt,
        handles: failed.handles,
        reason,
        ...(failed.terminalCauseRef === undefined ? {} : { causeRef: failed.terminalCauseRef }),
      });
    } catch (error: unknown) {
      return this.deferFailedDurableClose(failed, `retention failure append failed: ${errorMessage(error)}`);
    }
    this.clearRetentionContinuation(work, failed);
    return this.retentionAdvanced(
      'definitive provider discard failure recorded',
      'done',
      failed.descriptor.discardActionId,
    );
  }

  private retentionAdvanced(
    detail: string,
    providerOutcome: RecoverySettlementFact['outcome'],
    authorityRef?: string,
    attemptOutcome: RecoverySettlementFact['outcome'] = 'done',
    terminalOutcome: RecoverySettlementFact['outcome'] = 'done',
  ): RecoveryDisposition {
    return {
      kind: 'advanced',
      outcome: 'settled',
      facts: [
        retentionRecoveryFact(RETENTION_PROVIDER_DISCARD_OBLIGATION, providerOutcome, authorityRef),
        retentionRecoveryFact(RETENTION_ATTEMPT_OBLIGATION, attemptOutcome),
        retentionRecoveryFact(RETENTION_TERMINAL_OBLIGATION, terminalOutcome),
      ],
      detail,
    };
  }

  private readFreshProviderSession(sessionId: string): ProviderSession | null {
    return readProjectionSessionEntriesById(this.options.db(), [sessionId]).get(sessionId) ?? null;
  }

  private readRetentionEntryForRequest(sessionId: string): ProviderSession | null {
    const entry = this.readFreshProviderSession(sessionId);
    if (entry === null) {
      return null;
    }
    if (
      entry.activeJobId !== undefined ||
      isProtectiveContinuationLease(entry.continuationLease, this.options.time.now()) ||
      hasUnterminalRetentionDiscardRequest(entry)
    ) {
      return null;
    }
    return entry;
  }

  private hasRetentionProtection(entry: ProviderSession): boolean {
    return (
      entry.activeJobId !== undefined || isProtectiveContinuationLease(entry.continuationLease, this.options.time.now())
    );
  }

  private readTerminalEvent(sessionId: string, jobId: string): EventsRow | null {
    const row = this.options
      .db()
      .prepare<[string, string], EventsRow>(
        `SELECT *
           FROM events
          WHERE type = 'job.terminal.recorded'
            AND stream_id = ?
            AND json_extract(refs, '$.sessionId') = ?
          ORDER BY seq ASC
          LIMIT 1`,
      )
      .get(jobId, sessionId);
    if (row === undefined) {
      return null;
    }
    decodeStoredBody(row, this.options.readCtx);
    return row;
  }

  private enqueue(sessionId: string, jobId: string): void {
    const key = sessionRetentionWorkKey(sessionId, jobId);
    if (this.inFlightPairs.has(key)) {
      this.rerunPairs.add(key);
      return;
    }

    const pending = this.pendingBySession.get(sessionId) ?? new Set<string>();
    pending.add(jobId);
    this.pendingBySession.set(sessionId, pending);
  }

  private scheduleDrain(): void {
    if (this.drainPromise !== null || !this.hasPendingWork()) {
      return;
    }

    let failed = false;
    const promise = this.drainQueue()
      .catch((error: unknown) => {
        failed = true;
        this.log(`Retention lifecycle reactor failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        if (this.drainPromise === promise) {
          this.drainPromise = null;
        }
        if (!failed && this.hasPendingWork()) {
          this.scheduleDrain();
        }
      });
    this.drainPromise = promise;
  }

  private hasPendingWork(): boolean {
    for (const jobIds of this.pendingBySession.values()) {
      if (jobIds.size > 0) {
        return true;
      }
    }
    return false;
  }

  private nextPendingPair(): SessionRetentionPair | null {
    for (const [sessionId, jobIds] of this.pendingBySession) {
      if (jobIds.size === 0) {
        this.pendingBySession.delete(sessionId);
        continue;
      }
      for (const jobId of jobIds) {
        return { sessionId, jobId };
      }
    }
    return null;
  }

  private releasePendingPair(pair: SessionRetentionPair): void {
    const jobIds = this.pendingBySession.get(pair.sessionId);
    if (jobIds === undefined) return;
    jobIds.delete(pair.jobId);
    if (jobIds.size === 0) this.pendingBySession.delete(pair.sessionId);
  }

  private async drainQueue(): Promise<void> {
    for (;;) {
      const pair = this.nextPendingPair();
      if (pair === null) return;
      const key = sessionRetentionWorkKey(pair.sessionId, pair.jobId);
      if (this.inFlightPairs.has(key)) return;

      this.inFlightPairs.add(key);
      let completed = false;
      try {
        await this.runContainedRecovery(this.lifetimeSignal);
        completed = true;
        if (!this.rerunPairs.delete(key)) this.releasePendingPair(pair);
      } finally {
        if (!completed) this.rerunPairs.delete(key);
        this.inFlightPairs.delete(key);
      }
    }
  }

  listLifecycleSessionEntries(db: Database = this.options.db()): ProviderSession[] {
    return listProjectionSessionEntries(db, undefined, undefined, (sessionId, error) => {
      const subject = sessionId === null ? 'with no decodable session id' : `for ${sessionId}`;
      this.log(`Skipped malformed session projection ${subject} during lifecycle processing: ${errorMessage(error)}`);
    });
  }

  private clearContinuationLeaseTimer(): void {
    if (this.continuationLeaseTimer === null) {
      return;
    }
    this.options.time.clearTimeout(this.continuationLeaseTimer);
    this.continuationLeaseTimer = null;
  }

  private scheduleContinuationLeaseTimer(leases: readonly SessionContinuationLeaseComponent[]): void {
    this.clearContinuationLeaseTimer();

    const nowMs = this.options.time.now();
    let earliestExpiresAt: number | null = null;
    for (const component of leases) {
      const lease = component.persistedEntry.continuationLease;
      if (lease?.status !== 'pending') continue;
      const expiresAt = Date.parse(lease.expiresAt);
      if (expiresAt <= nowMs) {
        earliestExpiresAt = nowMs;
        break;
      }
      if (earliestExpiresAt === null || expiresAt < earliestExpiresAt) {
        earliestExpiresAt = expiresAt;
      }
    }

    if (earliestExpiresAt === null) {
      return;
    }

    this.continuationLeaseTimer = this.options.time.setTimeout(
      () => {
        this.continuationLeaseTimer = null;
        void this.runContainedRecovery(this.lifetimeSignal).catch((error: unknown) => {
          this.log(`Continuation lease timer recovery failed: ${errorMessage(error)}`);
        });
      },
      Math.max(0, earliestExpiresAt - nowMs),
    );
    this.continuationLeaseTimer.unref?.();
  }

  private log(message: string): void {
    if (this.options.log) {
      this.options.log(message);
      return;
    }
    backendLog.warn(message);
  }
}

function isRecoveryRetentionWork(work: SessionRetentionWork): work is RecoverySessionRetentionWork {
  return typeof (work as { readonly recovery?: unknown }).recovery === 'object';
}

function deferredSessionRetryPolicy<Raw, Item>(
  resolve: () => RecoveryRetryPolicy<Raw, Item>,
  issueReceipts = false,
): RecoveryRetryPolicy<Raw, Item> {
  let resolvedPolicy: RecoveryRetryPolicy<Raw, Item> | undefined;
  const policy = (): RecoveryRetryPolicy<Raw, Item> => {
    resolvedPolicy ??= resolve();
    return resolvedPolicy;
  };
  return {
    processLocalCleanup: { kind: 'not-required' },
    ...(issueReceipts ? { issueReceipts: true } : {}),
    hydrate: (raw) => policy().hydrate(raw),
    requiredObligations: (item) => policy().requiredObligations(item),
    settle: (item) => policy().settle(item),
    onFault: (fault) => policy().onFault(fault),
  };
}

function retryReactor(db: Database): LifecycleReactor {
  const reactor = lifecycleReactorsByDatabase.get(db);
  if (reactor === undefined) throw new Error('Session recovery retry policy is not initialized.');
  return reactor;
}

export function createSessionProjectionRetryPlan(
  db: Database,
  subject: RecoverySubject,
  quarantine: RecoveryQuarantinePort,
): RecoverySourceFactoryPlan<RawSessionProjectionEnvelope, SessionProjectionComponent> {
  const policy = () => retryReactor(db).createRecoveryPolicies(quarantine, []).sessions;
  return {
    source: sessionProjectionRecoverySource(db, subject),
    policy: deferredSessionRetryPolicy(policy, true),
  };
}

export function createSessionContinuationLeaseRetryPlan(
  db: Database,
  subject: RecoverySubject,
  quarantine: RecoveryQuarantinePort,
): RecoverySourceFactoryPlan<RawPendingContinuationLeaseRow, SessionContinuationLeaseComponent> {
  const policy = () => retryReactor(db).createRecoveryPolicies(quarantine, []).continuationLeases;
  return {
    source: sessionContinuationLeaseRecoverySource(db, subject),
    policy: deferredSessionRetryPolicy(policy, true),
  };
}

export function createTerminalRetentionOutcomeRetryPlan(
  db: Database,
  subject: RecoverySubject,
  quarantine: RecoveryQuarantinePort,
): RecoverySourceFactoryPlan<RawTerminalRetentionOutcomeRow, TerminalRetentionOutcomeComponent> {
  const policy = () => retryReactor(db).createRecoveryPolicies(quarantine, []).terminalOutcomes;
  return {
    source: terminalRetentionOutcomeRecoverySource(db, subject),
    policy: deferredSessionRetryPolicy(policy, true),
  };
}

export function createRetentionReleasePairRetryPlan(
  db: Database,
  subject: RecoverySubject,
  quarantine: RecoveryQuarantinePort,
): RecoverySourceFactoryPlan<RawRetentionReleaseAndTerminalRow, RetentionReleasePairComponent> {
  const policy = () => retryReactor(db).createRecoveryPolicies(quarantine, []).releasePairs;
  return {
    source: retentionReleasePairComponentSource(db, subject),
    policy: deferredSessionRetryPolicy(policy, true),
  };
}

function retentionWorkPair(subject: RecoverySubject): Readonly<{ sessionId: string; jobId: string }> | null {
  const separator = subject.key.indexOf('\u0000');
  if (separator <= 0 || separator === subject.key.length - 1) return null;
  return { sessionId: subject.key.slice(0, separator), jobId: subject.key.slice(separator + 1) };
}

function hasRetentionWorkInputs(db: Database, pair: Readonly<{ sessionId: string; jobId: string }>): boolean {
  const session = db
    .prepare<[string], { readonly present: number }>(
      `SELECT 1 AS present
         FROM projection_sessions
        WHERE session_id = ?`,
    )
    .get(pair.sessionId);
  const release = db
    .prepare<[string, string], { readonly present: number }>(
      `SELECT 1 AS present
         FROM events
        WHERE type = 'session.claim.released'
          AND stream_id = ?
          AND json_extract(refs, '$.jobId') = ?
        LIMIT 1`,
    )
    .get(pair.sessionId, pair.jobId);
  const terminal = db
    .prepare<[string, string], { readonly present: number }>(
      `SELECT 1 AS present
         FROM events
        WHERE type = 'job.terminal.recorded'
          AND stream_id = ?
          AND json_extract(refs, '$.sessionId') = ?
        LIMIT 1`,
    )
    .get(pair.jobId, pair.sessionId);
  return session !== undefined && release !== undefined && terminal !== undefined;
}

export async function createRetentionWorkRetryPlan(
  db: Database,
  subject: RecoverySubject,
  signal: AbortSignal,
  quarantine: RecoveryQuarantinePort,
): Promise<RecoverySourceFactoryPlan<RawRetentionWorkItem, RecoverySessionRetentionWork>> {
  const reactor = lifecycleReactorsByDatabase.get(db);
  const policy = () => retryReactor(db).createRecoveryPolicies(quarantine, []).retentionWork;
  const pair = retentionWorkPair(subject);
  if (reactor === undefined) {
    if (pair !== null && hasRetentionWorkInputs(db, pair)) {
      throw new Error('Session retention retry policy is not initialized for an existing work item.');
    }
    return {
      source: retentionWorkItemRecoverySource([], subject),
      policy: deferredSessionRetryPolicy(policy),
    };
  }

  if (pair === null) {
    return {
      source: retentionWorkItemRecoverySource([], subject),
      policy: reactor.createRecoveryPolicies(quarantine, []).retentionWork,
    };
  }

  const policies = reactor.createRecoveryPolicies(quarantine, []);
  let receipts: readonly RecoveryReceipt<P4RetentionComponent>[] = [];
  await runSessionStartupRecovery({
    sessions: {
      source: sessionProjectionRecoverySource(db, undefined, pair.sessionId),
      policy: { signal, quarantine, ...policies.sessions },
    },
    continuationLeases: {
      source: sessionContinuationLeaseRecoverySource(db, undefined, pair.sessionId),
      policy: { signal, quarantine, ...policies.continuationLeases },
    },
    terminalOutcomes: {
      source: terminalRetentionOutcomeRecoverySource(db, undefined, pair.sessionId),
      policy: { signal, quarantine, ...policies.terminalOutcomes },
    },
    releasePairs: {
      source: retentionReleasePairComponentSource(db, undefined, pair),
      policy: { signal, quarantine, ...policies.releasePairs },
    },
    retentionWork: {
      settle: async (values) => {
        receipts = values;
      },
    },
  });
  return {
    source: retentionWorkItemRecoverySource(receipts, subject),
    policy: policies.retentionWork,
  };
}

export function createLifecycleReactor(options: LifecycleReactorOptions): LifecycleReactor {
  return new LifecycleReactor(options);
}
