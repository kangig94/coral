import { decodeBody } from '../store/body-codec.js';
import type { EventsRow } from '../store/schema.js';
import type { CoralEventInput } from '../store/envelope.js';
import { CoralSetupError } from '../runtime/errors.js';
import { defineDomainEvent, type DomainAppendValidator, type DomainEventRegistry } from '../store/reducers.js';
import { readProjectionDiscuss, reduceDiscussProjection } from './projections.js';
import {
  jobOpenedBodySchema,
  jobExecutionRequestedBodySchema,
  type JobOpenedBody,
  type JobExecutionRequestedBody,
} from '../jobs/launch.js';
import { readJobOpened } from '../jobs/execution-journal.js';
import { createDiscussSnapshot } from './reducer.js';
import {
  isWithinLiveSessionBoundary,
  discussEventKinds,
  discussEventBodySchemas,
  discussEventType,
  type DiscussDomainEvent,
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
        >("SELECT 1 AS found FROM events WHERE stream_id = ? AND type = 'discuss.session.created' LIMIT 1")
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

export const validateDiscussionJobLaunches: DomainAppendValidator = (ctx, inputs) => {
  const snapshots = new Map<string, PersistedDiscussSnapshot | undefined>();
  const opened = new Map<string, JobOpenedBody>();
  const jobsByAgent = new Map<string, Map<string, string>>();
  const jobsFor = (discussionId: string) => {
    let agents = jobsByAgent.get(discussionId);
    if (agents !== undefined) return agents;
    agents = readDiscussionAgentJobs(ctx, discussionId);
    jobsByAgent.set(discussionId, agents);
    return agents;
  };
  const closing = new Set(
    inputs.filter((input) => input.type === 'discuss.session.ended').map((input) => input.stream.id),
  );
  const snapshotFor = (id: string) => {
    if (!snapshots.has(id)) snapshots.set(id, readProjectionDiscuss(ctx.db, id)?.state);
    return snapshots.get(id);
  };
  for (const input of inputs) {
    if (input.type === 'job.opened') {
      opened.set(input.stream.id, jobOpenedBodySchema.parse(input.body));
      continue;
    }
    if (input.type === 'discuss.session.created') {
      snapshots.set(input.stream.id, discussionLaunchSnapshot(input));
      continue;
    }
    if (input.type === 'discuss.agent.run.bound') {
      const body = discussEventBodySchemas['agent.run.bound'].parse(input.body);
      const run = snapshotFor(input.stream.id)?.runtime.agentRuns[body.agent];
      if (run !== undefined) run.jobId = body.jobId;
      continue;
    }
    if (input.type !== 'job.execution.requested') continue;
    const request = jobExecutionRequestedBodySchema.parse(input.body);
    const job = opened.get(input.stream.id) ?? readJobOpened(ctx.db, input.stream.id, ctx.readCtx);
    if (job === null || job.owner.kind !== 'discussion') continue;
    const snapshot = snapshotFor(job.owner.id);
    const reservedJob =
      request.discussionRun === undefined ? undefined : jobsFor(job.owner.id).get(request.discussionRun.agent);
    const discussionRun = requireDiscussionLaunchRun(
      input.stream.id,
      job,
      request,
      snapshot,
      closing.has(job.owner.id),
      reservedJob,
    );
    jobsFor(job.owner.id).set(discussionRun.agent, input.stream.id);
  }
};

function readDiscussionAgentJobs(ctx: DiscussionAppendContext, discussionId: string): Map<string, string> {
  const agents = new Map<string, string>();
  const rows = ctx.db
    .prepare<[string], EventsRow>(
      `SELECT e.* FROM events e JOIN projection_jobs p ON p.job_id = e.stream_id
       WHERE e.stream_kind = 'job' AND e.type = 'job.execution.requested' AND p.execution_owner = ?
       ORDER BY e.seq`,
    )
    .all(JSON.stringify({ kind: 'discussion', id: discussionId }));
  for (const row of rows) {
    const request = decodeBody(row, jobExecutionRequestedBodySchema, ctx.readCtx);
    if (request.discussionRun !== undefined) agents.set(request.discussionRun.agent, row.stream_id);
  }
  return agents;
}

function discussionLaunchSnapshot(input: CoralEventInput): PersistedDiscussSnapshot {
  const { sourceSeq, ...payload } = discussEventBodySchemas['session.created'].parse(input.body);
  const projectRoot = input.project;
  if (projectRoot === undefined) {
    throw invalidDiscussionLink('Discussion creation requires its durable project scope.', {
      discussionId: input.stream.id,
    });
  }
  return createDiscussSnapshot({
    v: 1,
    sessionId: input.stream.id,
    projectRoot,
    topic: payload.input.topic,
    seq: sourceSeq,
    kind: 'session.created',
    ts: input.tsOverride ?? '1970-01-01T00:00:00.000Z',
    payload,
  });
}

function requireDiscussionLaunchRun(
  jobId: string,
  job: JobOpenedBody,
  request: JobExecutionRequestedBody,
  snapshot: PersistedDiscussSnapshot | undefined,
  closing: boolean,
  reservedJob: string | undefined,
): NonNullable<JobExecutionRequestedBody['discussionRun']> {
  if (
    job.jobKind !== 'provider' ||
    request.discussionRun === undefined ||
    snapshot === undefined ||
    !isWithinLiveSessionBoundary(snapshot) ||
    closing ||
    job.projectRoot !== snapshot.projectRoot ||
    !discussionAgentJobMatches(snapshot, request, jobId, job.conversation.provider, reservedJob)
  ) {
    throw new CoralSetupError({
      code: 'job_binding_owner_mismatch',
      userMessage: `Job '${jobId}' does not match an open discussion and bound agent run.`,
      remediation: 'Continue only the job bound to that agent in the open owning discussion.',
    });
  }
  return request.discussionRun;
}

function discussionAgentJobMatches(
  snapshot: PersistedDiscussSnapshot,
  request: JobExecutionRequestedBody,
  jobId: string,
  provider: string,
  reservedJob: string | undefined,
): boolean {
  const run = request.discussionRun === undefined ? undefined : snapshot.runtime.agentRuns[request.discussionRun.agent];
  return (
    run !== undefined &&
    run.provider === provider &&
    (reservedJob === undefined || reservedJob === jobId) &&
    (request.execution > 1 ? run.jobId === jobId : run.jobId === undefined || run.jobId === jobId) &&
    !Object.entries(snapshot.runtime.agentRuns).some(
      ([agent, other]) => agent !== request.discussionRun?.agent && other.jobId === jobId,
    )
  );
}

type DiscussionAppendContext = Parameters<DomainAppendValidator>[0];

interface DiscussionJobLink {
  snapshot: PersistedDiscussSnapshot;
  run: PersistedDiscussSnapshot['runtime']['agentRuns'][string];
  request: JobExecutionRequestedBody;
  discussionRun: NonNullable<JobExecutionRequestedBody['discussionRun']>;
  agent: string;
  jobId: string;
}

class DiscussionJobLinks {
  private readonly snapshots = new Map<string, PersistedDiscussSnapshot | undefined>();
  private readonly jobs = new Map<string, JobOpenedBody>();
  private readonly requests = new Map<string, Map<number, JobExecutionRequestedBody>>();
  private readonly started = new Map<string, Set<string>>();

  private readonly ctx: DiscussionAppendContext;

  constructor(ctx: DiscussionAppendContext) {
    this.ctx = ctx;
  }

  apply(input: CoralEventInput): void {
    if (input.type === 'job.opened') {
      this.jobs.set(input.stream.id, jobOpenedBodySchema.parse(input.body));
    } else if (input.type === 'job.execution.requested') {
      const request = jobExecutionRequestedBodySchema.parse(input.body);
      this.requestsFor(input.stream.id).set(request.execution, request);
    } else if (input.type === 'discuss.session.created') {
      this.createSnapshot(input);
    } else if (input.type === 'discuss.agent.run.bound') {
      this.bindRun(this.readLink(input));
    } else if (input.type === 'discuss.agent.job.started') {
      this.startExecution(input, this.readLink(input));
    } else if (input.type === 'discuss.agent.job.finished') {
      this.finishExecution(input, this.readLink(input));
    }
  }

  private requestsFor(jobId: string): Map<number, JobExecutionRequestedBody> {
    let executions = this.requests.get(jobId);
    if (executions !== undefined) return executions;
    executions = new Map();
    const rows = this.ctx.db
      .prepare<
        [string],
        EventsRow
      >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' ORDER BY seq")
      .all(jobId);
    for (const row of rows) {
      const request = decodeBody(row, jobExecutionRequestedBodySchema, this.ctx.readCtx);
      executions.set(request.execution, request);
    }
    this.requests.set(jobId, executions);
    return executions;
  }

  private startedFor(discussionId: string): Set<string> {
    let executions = this.started.get(discussionId);
    if (executions !== undefined) return executions;
    executions = new Set();
    const rows = this.ctx.db
      .prepare<
        [string],
        EventsRow
      >("SELECT * FROM events WHERE stream_kind = 'discuss' AND stream_id = ? AND type = 'discuss.agent.job.started' ORDER BY seq")
      .all(discussionId);
    for (const row of rows) {
      const start = decodeBody(row, discussEventBodySchemas['agent.job.started'], this.ctx.readCtx);
      executions.add(`${start.jobId}:${start.execution}`);
    }
    this.started.set(discussionId, executions);
    return executions;
  }

  private snapshotFor(id: string): PersistedDiscussSnapshot | undefined {
    if (!this.snapshots.has(id)) this.snapshots.set(id, readProjectionDiscuss(this.ctx.db, id)?.state);
    return this.snapshots.get(id);
  }

  private createSnapshot(input: CoralEventInput): void {
    const { sourceSeq, ...payload } = discussEventBodySchemas['session.created'].parse(input.body);
    const projectRoot = input.project;
    if (projectRoot === undefined) {
      throw invalidDiscussionLink('Discussion creation requires its durable project scope.', {
        discussionId: input.stream.id,
      });
    }
    this.snapshots.set(
      input.stream.id,
      createDiscussSnapshot({
        v: 1,
        sessionId: input.stream.id,
        projectRoot,
        topic: payload.input.topic,
        seq: sourceSeq,
        kind: 'session.created',
        ts: input.tsOverride ?? '1970-01-01T00:00:00.000Z',
        payload,
      }),
    );
  }

  private readLink(input: CoralEventInput): DiscussionJobLink {
    const body = this.readLinkIdentity(input);
    const snapshot = this.snapshotFor(input.stream.id);
    const run = snapshot?.runtime.agentRuns[body.agent];
    const job = this.jobs.get(body.jobId) ?? readJobOpened(this.ctx.db, body.jobId, this.ctx.readCtx);
    const executions = this.requestsFor(body.jobId);
    const execution = this.readLinkExecution(input);
    const request = executions.get(execution);
    if (
      snapshot === undefined ||
      run === undefined ||
      job?.owner.kind !== 'discussion' ||
      job.owner.id !== input.stream.id ||
      job.projectRoot !== snapshot?.projectRoot ||
      job.jobKind !== 'provider' ||
      run.provider !== job.conversation.provider ||
      request?.discussionRun?.agent !== body.agent
    ) {
      throw invalidDiscussionLink('Discussion job linkage requires its owning aggregate and agent descriptor.', {
        discussionId: input.stream.id,
        jobId: body.jobId,
      });
    }
    return { snapshot, run, request, discussionRun: request.discussionRun, agent: body.agent, jobId: body.jobId };
  }

  private readLinkIdentity(input: CoralEventInput): { agent: string; jobId: string } {
    return input.type === 'discuss.agent.run.bound'
      ? discussEventBodySchemas['agent.run.bound'].parse(input.body)
      : input.type === 'discuss.agent.job.started'
        ? discussEventBodySchemas['agent.job.started'].parse(input.body)
        : discussEventBodySchemas['agent.job.finished'].parse(input.body);
  }

  private readLinkExecution(input: CoralEventInput): number {
    return input.type === 'discuss.agent.run.bound'
      ? 1
      : input.type === 'discuss.agent.job.started'
        ? discussEventBodySchemas['agent.job.started'].parse(input.body).execution
        : discussEventBodySchemas['agent.job.finished'].parse(input.body).execution;
  }

  private bindRun({ snapshot, run, agent, jobId }: DiscussionJobLink): void {
    if (
      (run.jobId !== undefined && run.jobId !== jobId) ||
      Object.entries(snapshot.runtime.agentRuns).some(
        ([otherAgent, other]) => otherAgent !== agent && other.jobId === jobId,
      )
    )
      throw invalidDiscussionLink('An agent run cannot change its bound job.', { jobId });
    run.jobId = jobId;
  }

  private startExecution(input: CoralEventInput, { run, request, discussionRun }: DiscussionJobLink): void {
    const start = discussEventBodySchemas['agent.job.started'].parse(input.body);
    if (
      run.jobId !== start.jobId ||
      run.currentJobId !== undefined ||
      this.startedFor(input.stream.id).has(`${start.jobId}:${start.execution}`) ||
      request.execution !== start.execution ||
      discussionRun.purpose !== start.purpose ||
      discussionRun.attempt !== start.attempt
    ) {
      throw invalidDiscussionLink('Discussion start must identify the requested execution.', {
        jobId: start.jobId,
        execution: start.execution,
      });
    }
    this.startedFor(input.stream.id).add(`${start.jobId}:${start.execution}`);
    run.currentJobId = start.jobId;
    run.currentExecution = start.execution;
    run.currentJobPurpose = start.purpose;
    run.currentAttempt = start.attempt;
  }

  private finishExecution(input: CoralEventInput, { run, discussionRun }: DiscussionJobLink): void {
    const end = discussEventBodySchemas['agent.job.finished'].parse(input.body);
    if (run.currentJobId !== end.jobId || run.currentExecution !== end.execution || run.currentAttempt !== end.attempt)
      throw invalidDiscussionLink('Discussion finish must identify its active execution.', {
        jobId: end.jobId,
        execution: end.execution,
      });
    run.currentJobId = undefined;
    run.currentExecution = undefined;
    run.currentJobPurpose = undefined;
    run.currentAttempt = end.attempt;
    run.lastAttemptPurpose = discussionRun.purpose;
    run.lastAttemptOutcome = end.outcome;
  }
}

const validateDiscussionJobLinks: DomainAppendValidator = (ctx, inputs) => {
  const links = new DiscussionJobLinks(ctx);
  for (const input of inputs) links.apply(input);
};

export const discussRegistry: DomainEventRegistry = {
  streamKind: 'discuss',
  entries: discussEventKinds.map((kind) =>
    defineDomainEvent({
      type: discussEventType(kind),
      schema: discussEventBodySchemas[kind],
      reducer: reduceDiscussProjection,
      materializerContract: `projection_discuss:reduce-${kind}`,
    }),
  ),
  appendValidators: [
    { contract: 'discuss:create-once-before-mutation', validate: validateDiscussCreation },
    { contract: 'discuss:job-launch-owner-and-run-descriptor', validate: validateDiscussionJobLaunches },
    { contract: 'discuss:event-job-link-state-machine', validate: validateDiscussionJobLinks },
  ],
};
