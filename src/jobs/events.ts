import { CoralSetupError } from '../runtime/errors.js';
import { providerSessionProvider, providerSessionSchema, type ProviderSession } from '../sessions/entry.js';
import { readProjectionProviderSession } from '../sessions/projections.js';
import { defineDomainEvent, type DomainAppendValidator, type DomainEventRegistry } from '../store/reducers.js';
import {
  jobProgressBodySchema,
  jobQueueAdmittedBodySchema,
  jobQueueQueuedBodySchema,
  jobRuntimeStartedBodySchema,
} from './event-bodies.js';
import { jobLaunchRequestBodySchema } from './launch.js';
import { jobAbortedBodySchema, jobLaunchRejectedSchema } from './outcome.js';
import {
  reduceJobAborted,
  reduceJobLaunchRejected,
  reduceJobLaunchRequested,
  reduceJobProgress,
  reduceJobQueueAdmitted,
  reduceJobQueueQueued,
  reduceJobRuntimeStarted,
  reduceJobTerminal,
  validateJobTerminalOrder,
} from './projections.js';
import { jobTerminalRecordedBodySchema } from './terminal/result.js';

/**
 * Validates only invariants owned by the job aggregate and ProviderSession.
 * Workflow- and discussion-owned launch policy lives with those aggregate
 * registries; every composed append validator observes the complete batch.
 */
const validateLaunchOwner: DomainAppendValidator = (ctx, inputs) => {
  const sessions = new Map<string, ProviderSession>();
  const launchedJobs = new Set<string>();

  const loadSession = (sessionId: string): ProviderSession | undefined => {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const entry = readProjectionProviderSession(ctx.db, sessionId) ?? undefined;
    if (entry === undefined) return undefined;
    sessions.set(sessionId, entry);
    return entry;
  };

  for (const input of inputs) {
    if (input.stream.kind === 'session' && typeof input.body === 'object' && input.body !== null) {
      const parsed = providerSessionSchema.safeParse((input.body as { entry?: unknown }).entry);
      if (parsed.success) sessions.set(parsed.data.sessionId, parsed.data);
      continue;
    }
    if (input.type !== 'job.launch.requested') continue;
    const launch = jobLaunchRequestBodySchema.parse(input.body);

    const alreadyStored =
      ctx.db
        .prepare<[string], { found: number }>(
          `SELECT 1 AS found FROM events
            WHERE stream_id = ? AND type = 'job.launch.requested'
            LIMIT 1`,
        )
        .get(input.stream.id) !== undefined;
    if (alreadyStored || launchedJobs.has(input.stream.id)) {
      throw new CoralSetupError({
        code: 'job_launch_duplicate',
        userMessage: `Job '${input.stream.id}' already has a launch declaration.`,
        remediation: 'A job stream must contain exactly one job.launch.requested event.',
      });
    }
    launchedJobs.add(input.stream.id);

    if (launch.jobKind === 'kb') {
      if (launch.owner.kind !== 'system-task') {
        throw new CoralSetupError({
          code: 'job_owner_mismatch',
          userMessage: `KB job '${input.stream.id}' requires a system-task owner.`,
          remediation: 'Launch daemon work with an explicit system-task owner.',
        });
      }
      continue;
    }

    if (launch.jobKind === 'workflow') {
      if (launch.owner.kind !== 'workflow' || launch.owner.id !== input.stream.id) {
        throw new CoralSetupError({
          code: 'job_owner_mismatch',
          userMessage: `Workflow job '${input.stream.id}' must own itself as a workflow aggregate.`,
          remediation: 'Use the workflow stream id as its execution owner id.',
        });
      }
      continue;
    }

    const session = loadSession(launch.sessionId);
    if (session === undefined) {
      throw new CoralSetupError({
        code: 'job_provider_session_missing',
        userMessage: `Job '${input.stream.id}' has no provider session.`,
        remediation: 'Open and claim the matching provider session before launching the job.',
      });
    }

    const hasNoWorkflowRelation =
      input.refs?.parentJobId === undefined &&
      input.refs?.workflowId === undefined &&
      input.refs?.workflowSlotId === undefined;
    const workflowRelationMatches =
      launch.owner.kind === 'workflow' &&
      input.refs?.parentJobId === launch.owner.id &&
      input.refs.workflowId === launch.owner.id &&
      typeof input.refs.workflowSlotId === 'string' &&
      input.refs.workflowSlotId.length > 0;
    const ownerMatches =
      (launch.owner.kind === 'provider-session' && launch.owner.id === launch.sessionId && hasNoWorkflowRelation) ||
      (launch.owner.kind === 'discussion' && hasNoWorkflowRelation) ||
      workflowRelationMatches;
    const descriptorMatchesOwner =
      launch.owner.kind === 'discussion' ? launch.discussionRun !== undefined : launch.discussionRun === undefined;

    if (
      providerSessionProvider(session) !== launch.provider ||
      session.activeJobId !== input.stream.id ||
      session.projectRoot !== launch.projectRoot ||
      session.backendNamespace !== launch.backendNamespace ||
      !ownerMatches ||
      !descriptorMatchesOwner
    ) {
      throw new CoralSetupError({
        code: 'job_binding_owner_mismatch',
        userMessage: `Job '${input.stream.id}' does not match its provider session binding and execution owner.`,
        remediation: 'Use the claimed provider session and the explicit owning aggregate for the job.',
        context: {
          jobId: input.stream.id,
          sessionId: launch.sessionId,
          sessionProvider: providerSessionProvider(session),
          launchProvider: launch.provider,
          sessionActiveJobId: session.activeJobId,
          sessionProjectRoot: session.projectRoot,
          launchProjectRoot: launch.projectRoot,
          sessionBackendNamespace: session.backendNamespace,
          launchBackendNamespace: launch.backendNamespace,
          owner: launch.owner,
          ownerMatches,
          descriptorMatchesOwner,
        },
      });
    }
  }
};

export const jobsRegistry: DomainEventRegistry = {
  streamKind: 'job',
  entries: [
    defineDomainEvent({
      type: 'job.launch.requested',
      schema: jobLaunchRequestBodySchema,
      reducer: reduceJobLaunchRequested,
      materializerContract: 'projection_jobs:initialize-authoritative-launch-row',
    }),
    defineDomainEvent({
      type: 'job.launch.rejected',
      schema: jobLaunchRejectedSchema,
      reducer: reduceJobLaunchRejected,
      materializerContract: 'projection_jobs:apply-launch-rejection',
    }),
    defineDomainEvent({
      type: 'job.queue.queued',
      schema: jobQueueQueuedBodySchema,
      reducer: reduceJobQueueQueued,
      materializerContract: 'projection_jobs:apply-queued-phase',
    }),
    defineDomainEvent({
      type: 'job.queue.admitted',
      schema: jobQueueAdmittedBodySchema,
      reducer: reduceJobQueueAdmitted,
      materializerContract: 'projection_jobs:apply-admitted-phase',
    }),
    defineDomainEvent({
      type: 'job.runtime.started',
      schema: jobRuntimeStartedBodySchema,
      reducer: reduceJobRuntimeStarted,
      materializerContract: 'projection_jobs:apply-running-phase',
    }),
    defineDomainEvent({
      type: 'job.progress.emitted',
      schema: jobProgressBodySchema,
      reducer: reduceJobProgress,
      materializerContract: 'projection_jobs:merge-progress-diagnostics',
    }),
    defineDomainEvent({
      type: 'job.terminal.recorded',
      schema: jobTerminalRecordedBodySchema,
      reducer: reduceJobTerminal,
      materializerContract: 'projection_jobs:apply-terminal-outcome-and-diagnostics',
    }),
    defineDomainEvent({
      type: 'job.aborted',
      schema: jobAbortedBodySchema,
      reducer: reduceJobAborted,
      materializerContract: 'projection_jobs:apply-aborted-terminal',
    }),
  ],
  appendValidators: [
    { contract: 'jobs:terminal-order-and-single-terminal', validate: validateJobTerminalOrder },
    { contract: 'jobs:launch-owner-session-workflow-discussion-authority', validate: validateLaunchOwner },
  ],
};
