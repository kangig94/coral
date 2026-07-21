import { CoralSetupError } from '../runtime/errors.js';
import { sessionEntrySchema, type SessionEntry } from '../sessions/entry.js';
import { defineDomainEvent, type DomainAppendValidator, type DomainEventRegistry } from '../store/reducers.js';
import { jobLaunchRequestBodySchema } from './launch.js';
import { jobAbortedBodySchema, jobLaunchRejectedSchema } from './outcome.js';
import { jobTerminalRecordedBodySchema } from './terminal/result.js';
import {
  jobProgressBodySchema,
  jobQueueAdmittedBodySchema,
  jobQueueQueuedBodySchema,
  jobRuntimeStartedBodySchema,
} from './event-bodies.js';
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

const validateLaunchAuthority: DomainAppendValidator = (ctx, inputs) => {
  const sessions = new Map<string, SessionEntry>();
  const launchedJobs = new Set<string>();

  const loadSession = (sessionId: string): SessionEntry | undefined => {
    const cached = sessions.get(sessionId);
    if (cached !== undefined) return cached;
    const row = ctx.db
      .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
      .get(sessionId);
    if (row === undefined) return undefined;
    const entry = sessionEntrySchema.parse(JSON.parse(row.entry));
    sessions.set(sessionId, entry);
    return entry;
  };

  for (const input of inputs) {
    if (input.type === 'session.opened' && typeof input.body === 'object' && input.body !== null) {
      const parsed = sessionEntrySchema.safeParse((input.body as { entry?: unknown }).entry);
      if (parsed.success) sessions.set(parsed.data.sessionId, parsed.data);
      continue;
    }
    if (input.type !== 'job.launch.requested') continue;
    const launch = jobLaunchRequestBodySchema.parse(input.body);
    if (launch.jobKind === 'kb') continue;

    const alreadyStored =
      ctx.db
        .prepare<[string], { found: number }>(
          `SELECT 1 AS found
             FROM events
            WHERE stream_kind = 'job'
              AND stream_id = ?
              AND type = 'job.launch.requested'
            LIMIT 1`,
        )
        .get(input.stream.id) !== undefined;
    if (alreadyStored || launchedJobs.has(input.stream.id)) {
      throw new CoralSetupError({
        code: 'job_launch_duplicate',
        userMessage: `Job '${input.stream.id}' already has a launch authority.`,
        remediation: 'A job stream must contain exactly one job.launch.requested event.',
      });
    }
    launchedJobs.add(input.stream.id);

    const session = loadSession(launch.sessionId);
    if (session === undefined) {
      throw new CoralSetupError({
        code: 'provider_credential_source_missing',
        userMessage: `Job '${input.stream.id}' has no authoritative parent session.`,
        remediation: 'Open the matching provider or orchestration session before launching the job.',
      });
    }
    const validProvider =
      launch.jobKind === 'provider' &&
      session?.sessionAuthority.kind === 'provider' &&
      session.provider === launch.provider &&
      session.sessionAuthority.source.provider === launch.provider;
    const validWorkflow = launch.jobKind === 'workflow' && session?.sessionAuthority.kind === 'orchestration';
    if (!validProvider && !validWorkflow) {
      throw new CoralSetupError({
        code: 'provider_credential_source_mismatch',
        userMessage: `Job '${input.stream.id}' does not match its session authority.`,
        remediation: 'Open the matching provider or orchestration session before launching the job.',
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
    }),
    defineDomainEvent({
      type: 'job.launch.rejected',
      schema: jobLaunchRejectedSchema,
      reducer: reduceJobLaunchRejected,
    }),
    defineDomainEvent({ type: 'job.queue.queued', schema: jobQueueQueuedBodySchema, reducer: reduceJobQueueQueued }),
    defineDomainEvent({
      type: 'job.queue.admitted',
      schema: jobQueueAdmittedBodySchema,
      reducer: reduceJobQueueAdmitted,
    }),
    defineDomainEvent({
      type: 'job.runtime.started',
      schema: jobRuntimeStartedBodySchema,
      reducer: reduceJobRuntimeStarted,
    }),
    defineDomainEvent({ type: 'job.progress.emitted', schema: jobProgressBodySchema, reducer: reduceJobProgress }),
    defineDomainEvent({
      type: 'job.terminal.recorded',
      schema: jobTerminalRecordedBodySchema,
      reducer: reduceJobTerminal,
    }),
    defineDomainEvent({ type: 'job.aborted', schema: jobAbortedBodySchema, reducer: reduceJobAborted }),
  ],
  appendValidators: [validateJobTerminalOrder, validateLaunchAuthority],
};
