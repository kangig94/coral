import { z } from 'zod';

import { errorMessage } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import type { TimePort } from '../../infra/port-types.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { JobLaunch } from '../../jobs/records.js';
import { jobsRegistry } from '../../jobs/events.js';
import { jobLaunchRequestBodySchema } from '../../jobs/launch.js';
import { decodeProjectionJobExecutionOwner, decodeProjectionJobStoredRow } from '../../jobs/projection-row.js';
import type { Database } from '../../store/db.js';
import { decodeStoredBody, type StoreReadContext } from '../../store/body-codec.js';
import { createEventBodyCodec } from '../../store/event-body-codec.js';
import { rowToCoralEvent } from '../../store/envelope.js';
import { composeReducers } from '../../store/reducers.js';
import type { EventsRow } from '../../store/schema.js';
import {
  RecoveryContainment,
  type RecoveryDisposition,
  type RecoveryObligationId,
  type RecoveryPolicy,
  type RecoveryQuarantinePort,
  type RecoveryReceipt,
  type RecoverySettlementFact,
  type RecoverySubject,
} from '../../recovery/containment.js';
import type { RecoveryRetryPolicy, RecoverySourceFactoryPlan } from '../../recovery/source-registry.js';
import { RecoveryQuarantineStore } from '../../recovery/quarantine.js';
import {
  discussionCandidateRecoverySource,
  type RawDiscussionCandidateEnvelope,
} from './discussion-candidate-recovery-source.js';
import {
  discussionSourceRecoverySource,
  type DiscussionSourceCoordinate,
  type RawDiscussionSourceRow,
} from './discussion-source-recovery-source.js';
import type { DiscussContext, LiveDiscussSession } from './types.js';
import { ABORT_REASON } from './errors.js';
import type { DiscussSessionStore } from './session-store.js';
import {
  discussKindFromEventType,
  makeEvent,
  type DiscussDomainEvent,
  type PersistedDiscussSnapshot,
  isWithinLiveSessionBoundary,
} from '../events.js';
import { persistedDiscussSnapshotSchema } from '../projections.js';
import { discussRegistry } from '../event-registry.js';
import { buildWatchEvents } from '../watch.js';
import { nowIsoString } from '../../infra/time.js';
import { isAbortError, throwIfAborted } from '../../runtime/abort.js';
import { providerScopeSchema } from '../../infra/provider-scope.js';
import { isManualParticipant } from './runtime-build.js';
import { attachSession, detachSession, getSession } from './registry.js';
import { appendRuntimeEvents, isAbortEnded, readSessionEvents } from './persistence.js';
import { runDiscussionStartupRecovery } from './startup-recovery.js';

const SOURCE_COORDINATE_OBLIGATION = 'discussion.source-coordinate' as RecoveryObligationId;
const RECONCILE_OBLIGATION = 'discussion.owned-job-reconciliation' as RecoveryObligationId;
const ATTACH_OBLIGATION = 'discussion.attach' as RecoveryObligationId;
const RESUME_OBLIGATION = 'discussion.resume' as RecoveryObligationId;
const ATTACH_CLEANUP_OBLIGATION = 'discussion.attach-cleanup' as RecoveryObligationId;
const CANDIDATE_OBLIGATIONS = [
  RECONCILE_OBLIGATION,
  ATTACH_OBLIGATION,
  RESUME_OBLIGATION,
  ATTACH_CLEANUP_OBLIGATION,
] as const;
const DISCUSSION_RESUME_CONTINUATION = 'discussion-resume.v1';

const discussionResumeObligationSchema = z.enum([
  RECONCILE_OBLIGATION,
  ATTACH_OBLIGATION,
  RESUME_OBLIGATION,
  ATTACH_CLEANUP_OBLIGATION,
]);
const discussionResumeContinuationSchema = z
  .object({
    v: z.literal(1),
    subjectRevision: z.string().min(1),
    sourceId: z.string().min(1),
    sessionId: z.string().min(1),
    reconciliationResultRefs: z.array(z.string().min(1)),
    invocationContextRefs: z
      .object({
        projectRoot: z.string().min(1),
        providerScope: providerScopeSchema,
      })
      .strict(),
    completedObligationIds: z.array(discussionResumeObligationSchema),
  })
  .strict();

type DiscussionResumeContinuation = z.infer<typeof discussionResumeContinuationSchema>;
type DiscussionOwnedLaunch = Pick<JobLaunch, 'jobId' | 'sessionId' | 'discussionRun' | 'createdAt'>;

type DiscussionStartupRuntime = {
  readonly getDatabase: () => Database;
  readonly time: Pick<TimePort, 'now'>;
  readonly resolveProjectSource: (projectRoot: string) => string;
  readonly resumeLoop: (ctx: DiscussContext, sessionId: string, invocationCtx: InvocationContext) => void;
  readonly completedResumes: Set<string>;
};

type DiscussionStartupContextResolver = (ctx: InvocationContext) => DiscussContext;

type HydratedDiscussionCandidate = {
  readonly envelope: RawDiscussionCandidateEnvelope;
  readonly sourceId: string;
  readonly discussionEvents: DiscussDomainEvent[];
  readonly ownedJobs: readonly DiscussionOwnedLaunch[];
  readonly completed: Set<RecoveryObligationId>;
  readonly facts: Map<RecoveryObligationId, RecoverySettlementFact>;
  continuation: DiscussionResumeContinuation;
  snapshot: PersistedDiscussSnapshot;
  ctx: DiscussContext | null;
  continuationPersisted: boolean;
  cleanupAttachedSession: boolean;
  retainAttachedSession: boolean;
  resumeAttempted: boolean;
};

const discussionStartupRuntimes = new WeakMap<DiscussionStartupContextResolver, DiscussionStartupRuntime>();
const discussionRecoveryReducers = composeReducers(jobsRegistry, discussRegistry);
const discussionRecoveryReadContext: StoreReadContext = {
  schemas: discussionRecoveryReducers.schemas,
  streamKinds: discussionRecoveryReducers.streamKinds,
  bodyCodec: createEventBodyCodec(),
};

export function registerDiscussionStartupRuntime(
  getDiscussContext: DiscussionStartupContextResolver,
  runtime: Omit<DiscussionStartupRuntime, 'completedResumes'>,
): void {
  discussionStartupRuntimes.set(getDiscussContext, {
    ...runtime,
    completedResumes: new Set(),
  });
}

function recoveryFact(
  obligation: RecoveryObligationId,
  outcome: RecoverySettlementFact['outcome'],
  authorityRef?: string,
): RecoverySettlementFact {
  return {
    obligation,
    outcome,
    ...(authorityRef === undefined ? {} : { authorityRef }),
  };
}

function completeObligation(
  candidate: HydratedDiscussionCandidate,
  obligation: RecoveryObligationId,
  outcome: RecoverySettlementFact['outcome'],
  authorityRef?: string,
): void {
  candidate.completed.add(obligation);
  candidate.facts.set(obligation, recoveryFact(obligation, outcome, authorityRef));
}

function discussEventFromRaw(row: EventsRow, snapshot: PersistedDiscussSnapshot): DiscussDomainEvent {
  const decoded = decodeStoredBody(row, discussionRecoveryReadContext);
  rowToCoralEvent(row, decoded);
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError(`Discussion event ${row.seq} has a non-object body.`);
  }
  const body = decoded as Record<string, unknown>;
  const { sourceSeq, ...payload } = body;
  const kind = discussKindFromEventType(row.type);
  if (kind === null) throw new TypeError(`Unknown discussion event type '${row.type}'.`);
  const projectRoot = row.project ?? snapshot.projectRoot;
  if (projectRoot.length === 0) throw new TypeError(`Discussion '${row.stream_id}' has no project scope.`);

  return {
    v: 1,
    sessionId: row.stream_id,
    projectRoot,
    topic: snapshot.state.topic,
    seq: typeof sourceSeq === 'number' ? sourceSeq : row.seq,
    kind,
    ts: row.ts,
    payload,
  } as DiscussDomainEvent;
}

function ownedLaunchesFromRaw(envelope: RawDiscussionCandidateEnvelope): DiscussionOwnedLaunch[] {
  const launches: DiscussionOwnedLaunch[] = [];
  for (const rawJob of envelope.ownedJobs) {
    const projection = decodeProjectionJobStoredRow(rawJob.projection);
    const owner = decodeProjectionJobExecutionOwner(projection);
    if (owner.kind !== 'discussion' || owner.id !== envelope.discussion.discuss_id) {
      throw new TypeError(`Job '${projection.job_id}' is not owned by discussion '${envelope.discussion.discuss_id}'.`);
    }

    let launch: z.infer<typeof jobLaunchRequestBodySchema> | null = null;
    for (const row of rawJob.events) {
      const body = decodeStoredBody(row, discussionRecoveryReadContext);
      rowToCoralEvent(row, body);
      if (row.type !== 'job.launch.requested') continue;
      if (launch !== null) throw new TypeError(`Job '${projection.job_id}' has duplicate launch declarations.`);
      launch = jobLaunchRequestBodySchema.parse(body);
    }
    if (launch === null) throw new TypeError(`Job '${projection.job_id}' has no launch declaration.`);
    if (
      launch.jobKind !== 'provider' ||
      launch.owner.kind !== 'discussion' ||
      launch.owner.id !== envelope.discussion.discuss_id
    ) {
      throw new TypeError(`Job '${projection.job_id}' launch contradicts its discussion ownership.`);
    }
    launches.push({
      jobId: projection.job_id,
      sessionId: launch.sessionId,
      ...(launch.discussionRun === undefined ? {} : { discussionRun: launch.discussionRun }),
      createdAt: launch.createdAt,
    });
  }
  return launches;
}

function continuationFromRaw(
  envelope: RawDiscussionCandidateEnvelope,
  snapshot: PersistedDiscussSnapshot,
  sourceId: string,
): DiscussionResumeContinuation | null {
  const raw = envelope.continuation;
  if (raw === null) return null;
  if (raw.continuation_kind !== DISCUSSION_RESUME_CONTINUATION || raw.continuation_key === null) {
    throw new TypeError(`Discussion '${snapshot.sessionId}' has an invalid recovery continuation.`);
  }
  const continuation = discussionResumeContinuationSchema.parse(JSON.parse(raw.continuation_key));
  if (continuation.sessionId !== snapshot.sessionId || continuation.sourceId !== sourceId) {
    throw new TypeError(`Discussion '${snapshot.sessionId}' recovery continuation names another subject.`);
  }
  if (new Set(continuation.completedObligationIds).size !== continuation.completedObligationIds.length) {
    throw new TypeError(`Discussion '${snapshot.sessionId}' recovery continuation repeats an obligation.`);
  }
  return continuation.subjectRevision === envelope.inputRevision.value ? continuation : null;
}

function hydrateDiscussionCandidate(
  envelope: RawDiscussionCandidateEnvelope,
  resolveProjectSource: (projectRoot: string) => string,
): HydratedDiscussionCandidate {
  const snapshot = persistedDiscussSnapshotSchema.parse(JSON.parse(envelope.discussion.state));
  if (snapshot.sessionId !== envelope.discussion.discuss_id) {
    throw new TypeError(`Discussion projection key '${envelope.discussion.discuss_id}' contradicts its snapshot.`);
  }
  const sourceId = resolveProjectSource(snapshot.projectRoot);
  const persisted = continuationFromRaw(envelope, snapshot, sourceId);
  const continuation: DiscussionResumeContinuation = persisted ?? {
    v: 1,
    subjectRevision: envelope.inputRevision.value,
    sourceId,
    sessionId: snapshot.sessionId,
    reconciliationResultRefs: [],
    invocationContextRefs: {
      projectRoot: snapshot.projectRoot,
      providerScope: snapshot.providerScope,
    },
    completedObligationIds: [],
  };

  return {
    envelope,
    sourceId,
    snapshot,
    discussionEvents: envelope.discussionEvents.map((row) => discussEventFromRaw(row, snapshot)),
    ownedJobs: ownedLaunchesFromRaw(envelope),
    continuation,
    completed: new Set(continuation.completedObligationIds),
    facts: new Map(),
    ctx: null,
    continuationPersisted: false,
    cleanupAttachedSession: false,
    retainAttachedSession: false,
    resumeAttempted: false,
  };
}

function buildOwnedJobReconciliationEvents(
  snapshot: PersistedDiscussSnapshot,
  launch: DiscussionOwnedLaunch,
  ctx: DiscussContext,
): DiscussDomainEvent[] {
  if (launch.sessionId === null || launch.discussionRun === undefined) {
    throw new Error(`Discussion-owned job '${launch.jobId}' has no durable run descriptor.`);
  }
  const { agent, purpose, attempt } = launch.discussionRun;
  const run = snapshot.runtime.agentRuns[agent];
  if (run === undefined) {
    throw new Error(`Discussion-owned job '${launch.jobId}' names unknown agent '${agent}'.`);
  }
  if (run.executionSessionId !== undefined && run.executionSessionId !== launch.sessionId) {
    throw new Error(`Discussion agent '${agent}' is already bound to another provider session.`);
  }
  if (run.currentJobId !== undefined && run.currentJobId !== launch.jobId) {
    throw new Error(`Discussion agent '${agent}' already has active job '${run.currentJobId}'.`);
  }
  if (run.currentJobId === launch.jobId) return [];

  let seq = snapshot.lastAppliedSeq + 1;
  const events: DiscussDomainEvent[] = [];
  if (run.executionSessionId === undefined) {
    events.push(
      makeEvent(
        snapshot.sessionId,
        snapshot.projectRoot,
        snapshot.state.topic,
        seq++,
        'agent.run.bound',
        nowIsoString(ctx.runtime.time),
        { agent, executionSessionId: launch.sessionId },
      ),
    );
  }
  events.push(
    makeEvent(
      snapshot.sessionId,
      snapshot.projectRoot,
      snapshot.state.topic,
      seq,
      'agent.job.started',
      nowIsoString(ctx.runtime.time),
      { agent, jobId: launch.jobId, purpose, attempt },
    ),
  );
  return events;
}

export async function reconcileDiscussionOwnedJobs(
  ctx: DiscussContext,
  sessionId: string,
): Promise<PersistedDiscussSnapshot> {
  const owned = ctx.jobStatusReader
    .listOwned(sessionId)
    .slice()
    .sort((left, right) =>
      left.launch.createdAt === right.launch.createdAt
        ? left.launch.jobId.localeCompare(right.launch.jobId)
        : left.launch.createdAt.localeCompare(right.launch.createdAt),
    );
  const started = new Set(
    readSessionEvents(ctx, sessionId)
      .filter((event) => event.kind === 'agent.job.started')
      .map((event) => event.payload.jobId),
  );

  for (const { launch } of owned) {
    if (started.has(launch.jobId)) continue;
    const reconciled = await appendRuntimeEvents(ctx, sessionId, (current) =>
      buildOwnedJobReconciliationEvents(current, launch, ctx),
    );
    if (reconciled === null) {
      throw new Error(`Failed to reconcile discussion-owned job '${launch.jobId}'.`);
    }
    started.add(launch.jobId);
  }

  const reconciled = ctx.store.load(sessionId);
  if (reconciled === null) throw new Error(`Discuss session not found after job reconciliation: ${sessionId}`);
  return reconciled;
}

export type RecoveredDiscussResume = {
  ctx: DiscussContext;
  sessionId: string;
  invocationCtx: InvocationContext;
};

function shouldResumeRecoveredSession(snapshot: PersistedDiscussSnapshot): boolean {
  const { controlPhase } = snapshot.runtime;
  if (controlPhase === 'synthesize' || controlPhase === 'evaluate_epoch' || controlPhase === 'collect_follow_up') {
    return true;
  }

  if (snapshot.state.status === 'ended') {
    return false;
  }

  if (snapshot.state.status === 'speaking') {
    if (!snapshot.state.current_speaker) {
      return false;
    }
    return !isManualParticipant(snapshot, snapshot.state.current_speaker);
  }

  if (controlPhase === 'observer_wait') {
    return true;
  }

  return snapshot.state.status === 'bidding';
}

async function reconcileDiscussionOwnedJobsFromEnvelope(
  ctx: DiscussContext,
  candidate: HydratedDiscussionCandidate,
): Promise<readonly string[]> {
  const owned = [...candidate.ownedJobs].sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.jobId.localeCompare(right.jobId)
      : left.createdAt.localeCompare(right.createdAt),
  );
  const started = new Set(
    candidate.discussionEvents
      .filter((event) => event.kind === 'agent.job.started')
      .map((event) => event.payload.jobId),
  );
  const resultRefs: string[] = [];

  for (const launch of owned) {
    if (started.has(launch.jobId)) continue;
    const events = buildOwnedJobReconciliationEvents(candidate.snapshot, launch, ctx);
    if (events.length > 0) {
      candidate.snapshot = await ctx.store.append(
        candidate.snapshot.sessionId,
        candidate.snapshot.lastAppliedSeq,
        events,
      );
      candidate.discussionEvents.push(...events);
      for (const event of events) resultRefs.push(`discuss:${event.sessionId}:${event.seq}`);
    }
    started.add(launch.jobId);
  }
  return resultRefs;
}

function refreshContinuation(candidate: HydratedDiscussionCandidate): DiscussionResumeContinuation {
  candidate.continuation = {
    ...candidate.continuation,
    reconciliationResultRefs: [...candidate.continuation.reconciliationResultRefs],
    invocationContextRefs: {
      projectRoot: candidate.snapshot.projectRoot,
      providerScope: candidate.snapshot.providerScope,
    },
    completedObligationIds: CANDIDATE_OBLIGATIONS.filter((obligation) => candidate.completed.has(obligation)),
  };
  return candidate.continuation;
}

function continuationToken(candidate: HydratedDiscussionCandidate): { kind: string; key: string } {
  return {
    kind: DISCUSSION_RESUME_CONTINUATION,
    key: JSON.stringify(refreshContinuation(candidate)),
  };
}

async function persistDiscussionContinuation(
  boundary: string,
  candidate: HydratedDiscussionCandidate,
  quarantine: RecoveryQuarantinePort,
): Promise<void> {
  const persisted = await quarantine.upsert({
    boundary,
    subject: candidate.envelope.subject,
    state: 'continuation',
    stage: 'settle',
    errorMessage: '',
    detail: 'discussion recovery obligations remain in settlement',
    continuation: continuationToken(candidate),
  });
  if (!persisted) {
    throw new Error(`Discussion recovery continuation lost authority for '${candidate.snapshot.sessionId}'.`);
  }
  candidate.continuationPersisted = true;
}

async function clearDiscussionContinuation(
  boundary: string,
  candidate: HydratedDiscussionCandidate,
  quarantine: RecoveryQuarantinePort,
): Promise<void> {
  const deleted = await quarantine.delete({
    boundary,
    subject: candidate.envelope.subject,
  });
  if (!deleted) {
    throw new Error(`Discussion recovery continuation could not clear '${candidate.snapshot.sessionId}'.`);
  }
  candidate.continuationPersisted = false;
}

function completedCandidateFacts(candidate: HydratedDiscussionCandidate): readonly RecoverySettlementFact[] {
  return CANDIDATE_OBLIGATIONS.map((obligation) => {
    const fact = candidate.facts.get(obligation);
    if (fact === undefined) throw new Error(`Discussion recovery did not report '${obligation}'.`);
    return fact;
  });
}

function inactiveCandidateDisposition(): RecoveryDisposition {
  return {
    kind: 'advanced',
    outcome: 'settled',
    facts: CANDIDATE_OBLIGATIONS.map((obligation) => recoveryFact(obligation, 'not-applicable')),
    detail: 'discussion is outside the live recovery boundary',
  };
}

async function settleDiscussionCandidate(
  boundary: string,
  candidate: HydratedDiscussionCandidate,
  quarantine: RecoveryQuarantinePort,
  runtime: DiscussionStartupRuntime,
  resolveContext: (snapshot: PersistedDiscussSnapshot) => DiscussContext,
  resolveInvocationContext: (snapshot: PersistedDiscussSnapshot) => InvocationContext,
): Promise<RecoveryDisposition> {
  if (isAbortEnded(candidate.discussionEvents) || !isWithinLiveSessionBoundary(candidate.snapshot)) {
    return inactiveCandidateDisposition();
  }

  await persistDiscussionContinuation(boundary, candidate, quarantine);
  const ctx = resolveContext(candidate.snapshot);
  candidate.ctx = ctx;

  const reconciliationResultRefs = await reconcileDiscussionOwnedJobsFromEnvelope(ctx, candidate);
  candidate.continuation = {
    ...candidate.continuation,
    reconciliationResultRefs: [
      ...new Set([...candidate.continuation.reconciliationResultRefs, ...reconciliationResultRefs]),
    ],
  };
  completeObligation(
    candidate,
    RECONCILE_OBLIGATION,
    'done',
    `discuss:${candidate.snapshot.sessionId}:${candidate.snapshot.lastAppliedSeq}`,
  );
  await persistDiscussionContinuation(boundary, candidate, quarantine);

  const existing = getSession(ctx, candidate.snapshot.sessionId);
  if (existing === undefined) {
    attachSession(
      ctx,
      candidate.snapshot,
      {
        baseCursor: 0,
        events: buildWatchEvents(candidate.discussionEvents),
      },
      false,
    );
  }
  candidate.cleanupAttachedSession = true;
  completeObligation(candidate, ATTACH_OBLIGATION, 'done');
  await persistDiscussionContinuation(boundary, candidate, quarantine);

  const shouldResume = shouldResumeRecoveredSession(candidate.snapshot);
  if (shouldResume) {
    const invocationCtx = resolveInvocationContext(candidate.snapshot);
    candidate.retainAttachedSession = true;
    const processKey = `${candidate.sourceId}:${candidate.snapshot.sessionId}`;
    if (!runtime.completedResumes.has(processKey)) {
      candidate.resumeAttempted = true;
      runtime.resumeLoop(ctx, candidate.snapshot.sessionId, invocationCtx);
      runtime.completedResumes.add(processKey);
    }
    completeObligation(candidate, RESUME_OBLIGATION, 'done');
  } else {
    candidate.retainAttachedSession = true;
    completeObligation(candidate, RESUME_OBLIGATION, 'not-applicable');
  }
  completeObligation(candidate, ATTACH_CLEANUP_OBLIGATION, 'not-applicable');
  await persistDiscussionContinuation(boundary, candidate, quarantine);

  const facts = completedCandidateFacts(candidate);
  await clearDiscussionContinuation(boundary, candidate, quarantine);
  runtime.completedResumes.delete(`${candidate.sourceId}:${candidate.snapshot.sessionId}`);
  return {
    kind: 'advanced',
    outcome: 'settled',
    facts,
    detail: 'discussion recovery obligations settled',
  };
}

function candidateFaultDisposition(
  fault: Parameters<RecoveryPolicy<RawDiscussionCandidateEnvelope, HydratedDiscussionCandidate>['onFault']>[0],
): RecoveryDisposition {
  if (fault.stage !== 'settle') {
    return {
      kind: 'quarantine',
      detail: `discussion candidate ${fault.stage} failed: ${errorMessage(fault.error)}`,
    };
  }
  if (!fault.item.continuationPersisted) {
    return {
      kind: 'quarantine',
      detail: `discussion continuation persistence failed: ${errorMessage(fault.error)}`,
    };
  }
  if (fault.item.retainAttachedSession) {
    completeObligation(fault.item, ATTACH_CLEANUP_OBLIGATION, 'not-applicable');
  }
  if (fault.item.resumeAttempted) {
    try {
      backendLog.warn(
        `Discuss resume remains retryable for session ${fault.item.snapshot.sessionId}: ${errorMessage(fault.error)}`,
      );
    } catch {
      // Resume diagnostics are best-effort and never select the disposition.
    }
  }
  return {
    kind: 'deferred',
    continuation: continuationToken(fault.item),
    detail: `discussion recovery remains retryable: ${errorMessage(fault.error)}`,
  };
}

async function releaseCandidateAttachment(
  boundary: string,
  candidate: HydratedDiscussionCandidate,
  quarantine: RecoveryQuarantinePort,
  runtime: DiscussionStartupRuntime,
): Promise<{ readonly kind: 'released' } | { readonly kind: 'incomplete'; readonly error: unknown }> {
  if (candidate.ctx === null || !candidate.cleanupAttachedSession || candidate.retainAttachedSession) {
    return { kind: 'released' };
  }
  try {
    detachSession(candidate.ctx, candidate.snapshot.sessionId);
    runtime.completedResumes.delete(`${candidate.sourceId}:${candidate.snapshot.sessionId}`);
    candidate.cleanupAttachedSession = false;
    completeObligation(candidate, ATTACH_CLEANUP_OBLIGATION, 'done');
    if (candidate.continuationPersisted) {
      await persistDiscussionContinuation(boundary, candidate, quarantine);
    }
    return { kind: 'released' };
  } catch (error) {
    return { kind: 'incomplete', error };
  }
}

function buildAbortEndEventsForShutdown(
  ctx: DiscussContext,
  sessionId: string,
  snapshot: PersistedDiscussSnapshot,
): DiscussDomainEvent[] {
  if (!isWithinLiveSessionBoundary(snapshot) || isAbortEnded(readSessionEvents(ctx, sessionId))) {
    return [];
  }

  return [
    makeEvent(
      snapshot.sessionId,
      snapshot.projectRoot,
      snapshot.state.topic,
      snapshot.lastAppliedSeq + 1,
      'session.ended',
      nowIsoString(ctx.runtime.time),
      {
        endReasonContent: ABORT_REASON,
        force: true,
        reason: ABORT_REASON,
      },
    ),
  ];
}

function logShutdownPersistFailure(scope: string, error: unknown): void {
  backendLog.error(`Discuss shutdown persist failed for ${scope}`, error);
}

export async function persistAbortEndForShutdown(
  ctx: DiscussContext,
  sessionId: string,
  _session: LiveDiscussSession,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (options.signal !== undefined) {
    throwIfAborted(options.signal, 'discuss_shutdown_persist_live');
  }
  await appendRuntimeEvents(ctx, sessionId, (current) => buildAbortEndEventsForShutdown(ctx, sessionId, current));
}

export async function persistAbortEndForPersistedShutdownCandidates(
  sources: readonly string[],
  getDiscussStoreForSource: (source: string) => DiscussSessionStore,
  resolveContext: (snapshot: PersistedDiscussSnapshot) => DiscussContext,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const signal = options.signal;
  for (const source of sources) {
    if (signal !== undefined) {
      throwIfAborted(signal, 'discuss_shutdown_source');
    }
    let store: DiscussSessionStore;
    try {
      store = getDiscussStoreForSource(source);
    } catch (error: unknown) {
      logShutdownPersistFailure(`source ${source}`, error);
      continue;
    }

    let candidates: Array<{ sessionId: string }>;
    try {
      candidates = store.listRecoveryCandidates();
    } catch (error: unknown) {
      logShutdownPersistFailure(`source ${source}`, error);
      continue;
    }

    for (const candidate of candidates) {
      if (signal !== undefined) {
        throwIfAborted(signal, 'discuss_shutdown_candidate');
      }
      try {
        const snapshot = store.load(candidate.sessionId);
        if (!snapshot || !isWithinLiveSessionBoundary(snapshot)) {
          continue;
        }

        const ctx = resolveContext(snapshot);
        const events = readSessionEvents(ctx, candidate.sessionId);
        if (isAbortEnded(events)) {
          continue;
        }

        await appendRuntimeEvents(ctx, candidate.sessionId, (current) =>
          buildAbortEndEventsForShutdown(ctx, candidate.sessionId, current),
        );
        if (signal !== undefined) {
          throwIfAborted(signal, 'discuss_shutdown_candidate_persist');
        }
      } catch (error: unknown) {
        if (isAbortError(error)) {
          throw error;
        }
        logShutdownPersistFailure(candidate.sessionId, error);
      }
    }
  }
}

export async function recoverPersistedSessionsFromStore(
  store: DiscussSessionStore,
  resolveContext: (snapshot: PersistedDiscussSnapshot) => DiscussContext,
  resolveInvocationContext: (snapshot: PersistedDiscussSnapshot) => InvocationContext,
): Promise<RecoveredDiscussResume[]> {
  const recovered: RecoveredDiscussResume[] = [];

  for (const candidate of store.listRecoveryCandidates()) {
    const snapshot = store.load(candidate.sessionId);
    if (!snapshot) {
      continue;
    }

    const ctx = resolveContext(snapshot);
    let events = readSessionEvents(ctx, candidate.sessionId);
    const abortEnded = isAbortEnded(events);
    if (abortEnded) {
      continue;
    }

    if (!isWithinLiveSessionBoundary(snapshot)) {
      continue;
    }

    const reconciledSnapshot = await reconcileDiscussionOwnedJobs(ctx, candidate.sessionId);
    events = readSessionEvents(ctx, candidate.sessionId);

    attachSession(
      ctx,
      reconciledSnapshot,
      {
        baseCursor: 0,
        events: buildWatchEvents(events),
      },
      abortEnded,
    );

    if (shouldResumeRecoveredSession(reconciledSnapshot)) {
      recovered.push({
        ctx,
        sessionId: reconciledSnapshot.sessionId,
        invocationCtx: resolveInvocationContext(reconciledSnapshot),
      });
    }
  }

  return recovered;
}

type DiscussStartupDeps = {
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly createInvocationContext: (projectRoot: string) => InvocationContext;
  readonly signal: AbortSignal;
};

type DiscussionRecoveryPolicyContext = {
  readonly runtime: DiscussionStartupRuntime;
  readonly quarantine: RecoveryQuarantinePort;
  readonly resolveContext: (snapshot: PersistedDiscussSnapshot) => DiscussContext;
  readonly resolveInvocationContext: (snapshot: PersistedDiscussSnapshot) => InvocationContext;
};

function discussionRecoveryRuntime(deps: Pick<DiscussStartupDeps, 'getDiscussContext'>): DiscussionStartupRuntime {
  const runtime = discussionStartupRuntimes.get(deps.getDiscussContext);
  if (runtime === undefined) {
    throw new Error('Discussion startup recovery runtime is not registered.');
  }
  return runtime;
}

function createDiscussionSourcePolicy(
  runtime: DiscussionStartupRuntime,
): RecoveryRetryPolicy<RawDiscussionSourceRow, DiscussionSourceCoordinate> {
  return {
    processLocalCleanup: { kind: 'not-required' },
    issueReceipts: true,
    hydrate: (raw) => {
      const snapshot = persistedDiscussSnapshotSchema.parse(JSON.parse(raw.state));
      if (snapshot.sessionId !== raw.discuss_id) {
        throw new TypeError(`Discussion projection key '${raw.discuss_id}' contradicts its snapshot.`);
      }
      return {
        discussId: raw.discuss_id,
        sourceId: runtime.resolveProjectSource(snapshot.projectRoot),
      };
    },
    requiredObligations: () => [SOURCE_COORDINATE_OBLIGATION],
    settle: (coordinate) => ({
      kind: 'advanced',
      outcome: 'settled',
      facts: [recoveryFact(SOURCE_COORDINATE_OBLIGATION, 'done', `discussion-source:${coordinate.sourceId}`)],
      detail: 'discussion source coordinate hydrated',
    }),
    onFault: (fault) => ({
      kind: 'quarantine',
      detail: `discussion source ${fault.stage} failed: ${errorMessage(fault.error)}`,
    }),
  };
}

function createDiscussionCandidatePolicy(
  context: DiscussionRecoveryPolicyContext,
): RecoveryRetryPolicy<RawDiscussionCandidateEnvelope, HydratedDiscussionCandidate> {
  const { runtime, quarantine, resolveContext, resolveInvocationContext } = context;
  const boundary = 'discussion-candidate';
  return {
    processLocalCleanup: {
      kind: 'boundary-required',
      release: (candidate) => releaseCandidateAttachment(boundary, candidate, quarantine, runtime),
    },
    hydrate: (envelope) => hydrateDiscussionCandidate(envelope, runtime.resolveProjectSource),
    requiredObligations: () => CANDIDATE_OBLIGATIONS,
    settle: (candidate) =>
      settleDiscussionCandidate(boundary, candidate, quarantine, runtime, resolveContext, resolveInvocationContext),
    onFault: candidateFaultDisposition,
  };
}

function discussionPolicyContext(
  deps: DiscussStartupDeps,
  quarantine: RecoveryQuarantinePort,
): DiscussionRecoveryPolicyContext {
  const runtime = discussionRecoveryRuntime(deps);
  const resolveContext = (snapshot: PersistedDiscussSnapshot): DiscussContext => {
    const base = deps.createInvocationContext(snapshot.projectRoot);
    return deps.getDiscussContext({ ...base, providerScope: snapshot.providerScope });
  };
  const resolveInvocationContext = (snapshot: PersistedDiscussSnapshot): InvocationContext => {
    const base = deps.createInvocationContext(snapshot.projectRoot);
    return { ...base, providerScope: snapshot.providerScope };
  };
  return { runtime, quarantine, resolveContext, resolveInvocationContext };
}

/** Returns the exact-subject discussion-source retry plan. */
export function createDiscussionSourceRetryPlan(
  deps: DiscussStartupDeps,
  subject: RecoverySubject,
): RecoverySourceFactoryPlan<RawDiscussionSourceRow, DiscussionSourceCoordinate> {
  const runtime = discussionRecoveryRuntime(deps);
  return {
    source: discussionSourceRecoverySource(runtime.getDatabase(), subject),
    policy: createDiscussionSourcePolicy(runtime),
  };
}

/** Returns the exact-subject discussion-candidate retry plan. */
export function createDiscussionCandidateRetryPlan(
  deps: DiscussStartupDeps,
  subject: RecoverySubject,
  quarantine: RecoveryQuarantinePort,
): RecoverySourceFactoryPlan<RawDiscussionCandidateEnvelope, HydratedDiscussionCandidate> {
  const context = discussionPolicyContext(deps, quarantine);
  return {
    source: discussionCandidateRecoverySource(context.runtime.getDatabase(), subject),
    policy: createDiscussionCandidatePolicy(context),
  };
}

export type DiscussRunStartup = (deps: DiscussStartupDeps) => Promise<RecoveredDiscussResume[]>;

export const runStartup: DiscussRunStartup = async (deps) => {
  const runtime = discussionRecoveryRuntime(deps);
  const db = runtime.getDatabase();
  const quarantine = new RecoveryQuarantineStore(db, runtime.time);
  const source = discussionSourceRecoverySource(db);
  const context = discussionPolicyContext(deps, quarantine);
  const sourcePolicy: RecoveryPolicy<RawDiscussionSourceRow, DiscussionSourceCoordinate> = {
    signal: deps.signal,
    quarantine,
    ...createDiscussionSourcePolicy(runtime),
  };

  await runDiscussionStartupRecovery({
    source,
    sourcePolicy,
    candidates: {
      settle: async (receipts: readonly RecoveryReceipt<DiscussionSourceCoordinate>[]) => {
        if (receipts.length === 0) return;
        const candidateSource = discussionCandidateRecoverySource(db);
        await RecoveryContainment.each(candidateSource, {
          signal: deps.signal,
          quarantine,
          ...createDiscussionCandidatePolicy(context),
        });
      },
    },
  });

  return [];
};
