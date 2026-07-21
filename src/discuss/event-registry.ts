import type { CoralEventInput } from '../store/envelope.js';
import { CoralSetupError } from '../runtime/errors.js';
import { defineDomainEvent, type DomainAppendValidator, type DomainEventRegistry } from '../store/reducers.js';
import { readProjectionDiscuss, reduceDiscussProjection } from './projections.js';
import { loadJobProjectionDetail } from '../jobs/read-queries.js';
import { jobLaunchRequestBodySchema } from '../jobs/launch.js';
import { readDiscussEventLog } from './read-queries.js';
import { createDiscussSnapshot } from './reducer.js';
import {
  discussEventKinds,
  discussEventBodySchemas,
  discussEventType,
  type DiscussDomainEvent,
  type DiscussAgentJobPurpose,
  type DiscussJournalBody,
  type PersistedDiscussSnapshot,
} from './events.js';

export function toJournalInput(
  domainEvent: DiscussDomainEvent,
  options: {
    namespace?: string;
    correlationId?: string;
    causationSeq?: number;
  } = {},
): CoralEventInput<DiscussJournalBody> {
  return {
    type: discussEventType(domainEvent.kind),
    stream: {
      kind: 'discuss',
      id: domainEvent.sessionId,
    },
    namespace: options.namespace,
    project: domainEvent.projectRoot,
    correlationId: options.correlationId,
    causationSeq: options.causationSeq,
    refs: {
      discussSessionId: domainEvent.sessionId,
    },
    bodyVersion: 1,
    body: {
      ...domainEvent.payload,
      sourceSeq: domainEvent.seq,
    },
    tsOverride: domainEvent.ts,
  };
}

const validateDiscussCreation: DomainAppendValidator = (ctx, inputs) => {
  const created = new Map<string, boolean>();
  for (const input of inputs) {
    if (input.stream.kind !== 'discuss') continue;
    let exists = created.get(input.stream.id);
    exists ??=
      ctx.db
        .prepare<
          [string],
          { found: number }
        >("SELECT 1 AS found FROM events WHERE stream_kind = 'discuss' AND stream_id = ? AND type = 'discuss.session.created' LIMIT 1")
        .get(input.stream.id) !== undefined;
    const isCreate = input.type === 'discuss.session.created';
    if (isCreate) {
      if (input.project === undefined || input.project.length === 0) {
        throw new CoralSetupError({
          code: 'discuss_project_missing',
          userMessage: `Discussion '${input.stream.id}' requires a durable project scope.`,
          remediation: 'Append discuss.session.created with a non-empty project envelope field.',
        });
      }
      const body = discussEventBodySchemas['session.created'].parse(input.body);
      const requiredProviders = [
        ...new Set(Object.values(body.agentExecution).flatMap((config) => (config.manual ? [] : [config.provider]))),
      ];
      const scopeValidation = ctx.providers.validatePersistedScope(body.providerScope, requiredProviders);
      if (!scopeValidation.ok) {
        throw new CoralSetupError({
          code: 'discuss_provider_scope_invalid',
          userMessage: `Discussion '${input.stream.id}' has an invalid provider scope.`,
          remediation: scopeValidation.message,
          context: { discussionId: input.stream.id, requiredProviders },
        });
      }
    }
    if (!exists && !isCreate) {
      throw new CoralSetupError({
        code: 'discuss_session_missing',
        userMessage: `Discuss session '${input.stream.id}' must be created before later events.`,
        remediation: 'Append discuss.session.created first in the same batch.',
      });
    }
    if (exists && isCreate) {
      throw new CoralSetupError({
        code: 'discuss_session_duplicate',
        userMessage: `Discuss session '${input.stream.id}' is already created.`,
        remediation: 'Do not append a second discuss.session.created event.',
      });
    }
    created.set(input.stream.id, exists || isCreate);
  }
};

function invalidDiscussionLink(message: string, context: Record<string, unknown>): CoralSetupError {
  return new CoralSetupError({
    code: 'discuss_job_link_invalid',
    userMessage: message,
    remediation: 'Append linkage events only for the persisted discussion-owned job descriptor.',
    context,
  });
}

type DiscussionLaunchAuthority = {
  projectRoot: string;
  agentRuns: Record<string, { provider: string; executionSessionId?: string }>;
};

/** Discussion aggregate policy for provider jobs that name it as owner. */
const validateDiscussionJobLaunches: DomainAppendValidator = (ctx, inputs) => {
  const discussions = new Map<string, DiscussionLaunchAuthority | undefined>();
  const completedJobs = new Map<string, Set<string>>();
  const outstandingRuns = new Map<string, string | null>();
  const sessionAgents = new Map<string, Set<string>>();

  const discussionFor = (discussionId: string): DiscussionLaunchAuthority | undefined => {
    if (!discussions.has(discussionId)) {
      const snapshot = readProjectionDiscuss(ctx.db, discussionId)?.state;
      discussions.set(
        discussionId,
        snapshot === undefined
          ? undefined
          : {
              projectRoot: snapshot.projectRoot,
              agentRuns: Object.fromEntries(
                Object.entries(snapshot.runtime.agentRuns).map(([agent, run]) => [
                  agent,
                  {
                    provider: run.provider,
                    ...(run.executionSessionId === undefined ? {} : { executionSessionId: run.executionSessionId }),
                  },
                ]),
              ),
            },
      );
    }
    return discussions.get(discussionId);
  };

  const completedFor = (discussionId: string): Set<string> => {
    let completed = completedJobs.get(discussionId);
    if (completed === undefined) {
      completed = new Set(
        readDiscussEventLog(ctx.db, discussionId, ctx.readCtx)
          .filter((event) => event.kind === 'agent.job.finished')
          .map((event) => event.payload.jobId),
      );
      completedJobs.set(discussionId, completed);
    }
    return completed;
  };

  const runKey = (discussionId: string, agent: string) => `${discussionId}\u0000${agent}`;
  const outstandingFor = (discussionId: string, agent: string): string | null => {
    const key = runKey(discussionId, agent);
    if (outstandingRuns.has(key)) return outstandingRuns.get(key) ?? null;
    const completed = completedFor(discussionId);
    const rows = ctx.db
      .prepare<[string], { job_id: string }>(
        `SELECT job_id FROM projection_jobs
          WHERE json_extract(execution_owner, '$.kind') = 'discussion'
            AND json_extract(execution_owner, '$.id') = ?
          ORDER BY created_at ASC, job_id ASC`,
      )
      .all(discussionId);
    const outstanding =
      rows.find(({ job_id }) => {
        const launch = loadJobProjectionDetail(ctx.db, job_id, ctx.readCtx).launch;
        return launch?.discussionRun?.agent === agent && !completed.has(job_id);
      })?.job_id ?? null;
    outstandingRuns.set(key, outstanding);
    return outstanding;
  };

  const agentsForSession = (discussionId: string, sessionId: string): Set<string> => {
    const key = `${discussionId}\u0000${sessionId}`;
    let agents = sessionAgents.get(key);
    if (agents !== undefined) return agents;
    agents = new Set<string>();
    const rows = ctx.db
      .prepare<[string, string], { job_id: string }>(
        `SELECT job_id FROM projection_jobs
          WHERE json_extract(execution_owner, '$.kind') = 'discussion'
            AND json_extract(execution_owner, '$.id') = ?
            AND session_id = ?
          ORDER BY created_at ASC, job_id ASC`,
      )
      .all(discussionId, sessionId);
    for (const { job_id } of rows) {
      const descriptor = loadJobProjectionDetail(ctx.db, job_id, ctx.readCtx).launch?.discussionRun;
      if (descriptor === undefined) throw new Error(`Discussion-owned job '${job_id}' has no durable run descriptor.`);
      agents.add(descriptor.agent);
    }
    sessionAgents.set(key, agents);
    return agents;
  };

  for (const input of inputs) {
    if (input.type === 'discuss.session.created') {
      const body = discussEventBodySchemas['session.created'].parse(input.body);
      if (input.project === undefined || input.project.length === 0) continue;
      discussions.set(input.stream.id, {
        projectRoot: input.project,
        agentRuns: Object.fromEntries(
          Object.entries(body.agentExecution).flatMap(([agent, config]) =>
            config.manual ? [] : [[agent, { provider: config.provider }]],
          ),
        ),
      });
      continue;
    }
    if (input.type === 'discuss.agent.run.bound') {
      const body = discussEventBodySchemas['agent.run.bound'].parse(input.body);
      const run = discussionFor(input.stream.id)?.agentRuns[body.agent];
      if (run !== undefined) run.executionSessionId = body.executionSessionId;
      continue;
    }
    if (input.type === 'discuss.agent.job.finished') {
      const body = discussEventBodySchemas['agent.job.finished'].parse(input.body);
      completedFor(input.stream.id).add(body.jobId);
      if (outstandingFor(input.stream.id, body.agent) === body.jobId) {
        outstandingRuns.set(runKey(input.stream.id, body.agent), null);
      }
      continue;
    }
    if (input.type !== 'job.launch.requested') continue;
    const launch = jobLaunchRequestBodySchema.parse(input.body);
    if (launch.jobKind !== 'provider' || launch.owner.kind !== 'discussion') continue;

    const descriptor = launch.discussionRun;
    const discussion = discussionFor(launch.owner.id);
    const agentRun = descriptor === undefined ? undefined : discussion?.agentRuns[descriptor.agent];
    const assignedAgents = agentsForSession(launch.owner.id, launch.sessionId);
    const boundToOtherAgent =
      descriptor !== undefined &&
      Object.entries(discussion?.agentRuns ?? {}).some(
        ([agent, run]) => agent !== descriptor.agent && run.executionSessionId === launch.sessionId,
      );
    const valid =
      descriptor !== undefined &&
      discussion !== undefined &&
      discussion.projectRoot === launch.projectRoot &&
      agentRun?.provider === launch.provider &&
      (agentRun.executionSessionId === undefined || agentRun.executionSessionId === launch.sessionId) &&
      !boundToOtherAgent &&
      [...assignedAgents].every((agent) => agent === descriptor.agent);
    if (!valid) {
      throw new CoralSetupError({
        code: 'job_binding_owner_mismatch',
        userMessage: `Job '${input.stream.id}' does not match discussion '${launch.owner.id}' execution authority.`,
        remediation: 'Launch with the configured agent provider and that agent’s durable provider session.',
        context: { discussionId: launch.owner.id, jobId: input.stream.id, descriptor },
      });
    }

    assignedAgents.add(descriptor.agent);
    const outstandingJobId = outstandingFor(launch.owner.id, descriptor.agent);
    if (outstandingJobId !== null) {
      throw new CoralSetupError({
        code: 'discussion_job_launch_conflict',
        userMessage: `Discussion agent '${descriptor.agent}' already has outstanding job '${outstandingJobId}'.`,
        remediation: 'Link and finish the outstanding discussion job before launching the next run.',
        context: {
          discussionId: launch.owner.id,
          agent: descriptor.agent,
          outstandingJobId,
          requestedJobId: input.stream.id,
        },
      });
    }
    outstandingRuns.set(runKey(launch.owner.id, descriptor.agent), input.stream.id);
  }
};

type ActiveDiscussionJob = { jobId: string; purpose: DiscussAgentJobPurpose; attempt: number };

const validateDiscussionJobLinks: DomainAppendValidator = (ctx, inputs) => {
  const snapshots = new Map<string, PersistedDiscussSnapshot | undefined>();
  const boundSessions = new Map<string, string | undefined>();
  const activeJobs = new Map<string, ActiveDiscussionJob | undefined>();
  const historicallyStarted = new Map<string, Set<string>>();
  const launchesInBatch = new Map<
    string,
    Extract<ReturnType<typeof jobLaunchRequestBodySchema.parse>, { jobKind: 'provider' }>
  >();

  const snapshotFor = (discussionId: string) => {
    if (!snapshots.has(discussionId)) {
      snapshots.set(discussionId, readProjectionDiscuss(ctx.db, discussionId)?.state);
    }
    return snapshots.get(discussionId);
  };
  const runKey = (discussionId: string, agent: string) => `${discussionId}\u0000${agent}`;
  const existingRun = (discussionId: string, agent: string) => snapshotFor(discussionId)?.runtime.agentRuns[agent];
  const boundFor = (discussionId: string, agent: string): string | undefined => {
    const key = runKey(discussionId, agent);
    if (!boundSessions.has(key)) boundSessions.set(key, existingRun(discussionId, agent)?.executionSessionId);
    return boundSessions.get(key);
  };
  const activeFor = (discussionId: string, agent: string): ActiveDiscussionJob | undefined => {
    const key = runKey(discussionId, agent);
    if (!activeJobs.has(key)) {
      const run = existingRun(discussionId, agent);
      activeJobs.set(
        key,
        run?.currentJobId === undefined || run.currentJobPurpose === undefined || run.currentAttempt === undefined
          ? undefined
          : { jobId: run.currentJobId, purpose: run.currentJobPurpose, attempt: run.currentAttempt },
      );
    }
    return activeJobs.get(key);
  };
  const startedFor = (discussionId: string): Set<string> => {
    let started = historicallyStarted.get(discussionId);
    if (started === undefined) {
      started = new Set(
        readDiscussEventLog(ctx.db, discussionId, ctx.readCtx)
          .filter((event) => event.kind === 'agent.job.started')
          .map((event) => event.payload.jobId),
      );
      historicallyStarted.set(discussionId, started);
    }
    return started;
  };
  const launchFor = (jobId: string) => {
    const batchLaunch = launchesInBatch.get(jobId);
    if (batchLaunch !== undefined) return batchLaunch;
    const persistedLaunch = loadJobProjectionDetail(ctx.db, jobId, ctx.readCtx).launch;
    return persistedLaunch?.jobKind === 'provider' ? persistedLaunch : undefined;
  };

  for (const input of inputs) {
    if (input.type === 'job.launch.requested') {
      const launch = jobLaunchRequestBodySchema.parse(input.body);
      if (launch.jobKind === 'provider') launchesInBatch.set(input.stream.id, launch);
      continue;
    }
    if (input.stream.kind !== 'discuss') continue;
    if (input.type === 'discuss.session.created') {
      const body = discussEventBodySchemas['session.created'].parse(input.body);
      if (input.project === undefined || input.project.length === 0) {
        throw new CoralSetupError({
          code: 'discuss_project_missing',
          userMessage: `Discussion '${input.stream.id}' requires a durable project scope.`,
          remediation: 'Append discuss.session.created with a non-empty project envelope field.',
        });
      }
      const { sourceSeq, ...payload } = body;
      snapshots.set(
        input.stream.id,
        createDiscussSnapshot({
          v: 1,
          sessionId: input.stream.id,
          projectRoot: input.project,
          topic: payload.input.topic,
          seq: sourceSeq,
          kind: 'session.created',
          ts: input.tsOverride ?? '1970-01-01T00:00:00.000Z',
          payload,
        }),
      );
      continue;
    }
    if (
      input.type !== 'discuss.agent.run.bound' &&
      input.type !== 'discuss.agent.job.started' &&
      input.type !== 'discuss.agent.job.finished'
    ) {
      continue;
    }
    const discussionId = input.stream.id;
    if (snapshotFor(discussionId) === undefined) {
      throw invalidDiscussionLink(`Discussion '${discussionId}' has no aggregate to link a job to.`, {
        discussionId,
        eventType: input.type,
      });
    }

    if (input.type === 'discuss.agent.run.bound') {
      const body = discussEventBodySchemas['agent.run.bound'].parse(input.body);
      const candidates = ctx.db
        .prepare<[string, string], { job_id: string }>(
          `SELECT job_id FROM projection_jobs
            WHERE json_extract(execution_owner, '$.kind') = 'discussion'
              AND json_extract(execution_owner, '$.id') = ?
              AND session_id = ?
            ORDER BY created_at ASC, job_id ASC`,
        )
        .all(discussionId, body.executionSessionId);
      const ownsAgentRun =
        candidates.some(({ job_id }) => launchFor(job_id)?.discussionRun?.agent === body.agent) ||
        [...launchesInBatch.values()].some(
          (launch) =>
            launch.owner.kind === 'discussion' &&
            launch.owner.id === discussionId &&
            launch.sessionId === body.executionSessionId &&
            launch.discussionRun?.agent === body.agent,
        );
      const currentBinding = boundFor(discussionId, body.agent);
      if (!ownsAgentRun || (currentBinding !== undefined && currentBinding !== body.executionSessionId)) {
        throw invalidDiscussionLink(`Discussion '${discussionId}' cannot bind agent '${body.agent}' to that session.`, {
          discussionId,
          agent: body.agent,
          executionSessionId: body.executionSessionId,
        });
      }
      boundSessions.set(runKey(discussionId, body.agent), body.executionSessionId);
      continue;
    }

    if (input.type === 'discuss.agent.job.started') {
      const body = discussEventBodySchemas['agent.job.started'].parse(input.body);
      const launch = launchFor(body.jobId);
      const descriptor = launch?.discussionRun;
      if (
        launch?.owner.kind !== 'discussion' ||
        launch.owner.id !== discussionId ||
        launch.sessionId === null ||
        boundFor(discussionId, body.agent) !== launch.sessionId ||
        descriptor?.agent !== body.agent ||
        descriptor.purpose !== body.purpose ||
        descriptor.attempt !== body.attempt ||
        startedFor(discussionId).has(body.jobId) ||
        activeFor(discussionId, body.agent) !== undefined
      ) {
        throw invalidDiscussionLink(`Discussion '${discussionId}' cannot start job '${body.jobId}' for that run.`, {
          discussionId,
          agent: body.agent,
          jobId: body.jobId,
          purpose: body.purpose,
          attempt: body.attempt,
        });
      }
      activeJobs.set(runKey(discussionId, body.agent), {
        jobId: body.jobId,
        purpose: body.purpose,
        attempt: body.attempt,
      });
      startedFor(discussionId).add(body.jobId);
      continue;
    }

    const body = discussEventBodySchemas['agent.job.finished'].parse(input.body);
    const active = activeFor(discussionId, body.agent);
    const launch = launchFor(body.jobId);
    if (
      active?.jobId !== body.jobId ||
      active.attempt !== body.attempt ||
      launch?.owner.kind !== 'discussion' ||
      launch.owner.id !== discussionId ||
      launch.discussionRun?.agent !== body.agent ||
      launch.discussionRun.attempt !== body.attempt
    ) {
      throw invalidDiscussionLink(`Discussion '${discussionId}' cannot finish job '${body.jobId}' for that run.`, {
        discussionId,
        agent: body.agent,
        jobId: body.jobId,
        attempt: body.attempt,
      });
    }
    activeJobs.set(runKey(discussionId, body.agent), undefined);
  }
};

export const discussRegistry: DomainEventRegistry = {
  streamKind: 'discuss',
  entries: discussEventKinds.map((kind) =>
    defineDomainEvent({
      type: discussEventType(kind),
      schema: discussEventBodySchemas[kind],
      reducer: reduceDiscussProjection,
    }),
  ),
  appendValidators: [validateDiscussCreation, validateDiscussionJobLaunches, validateDiscussionJobLinks],
};
