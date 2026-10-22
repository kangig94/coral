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
import { readJobOpened, readLatestExecutionRequest } from '../jobs/execution-state.js';
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
      const { sourceSeq, ...payload } = discussEventBodySchemas['session.created'].parse(input.body);
      snapshots.set(
        input.stream.id,
        createDiscussSnapshot({
          v: 1,
          sessionId: input.stream.id,
          projectRoot: input.project!,
          topic: payload.input.topic,
          seq: sourceSeq,
          kind: 'session.created',
          ts: input.tsOverride ?? '1970-01-01T00:00:00.000Z',
          payload,
        }),
      );
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
    const run =
      request.discussionRun === undefined ? undefined : snapshot?.runtime.agentRuns[request.discussionRun.agent];
    if (
      job.jobKind !== 'provider' ||
      snapshot === undefined ||
      snapshot.state.status === 'ended' ||
      closing.has(job.owner.id) ||
      job.projectRoot !== snapshot.projectRoot ||
      run?.provider !== job.conversation.provider ||
      (request.execution > 1
        ? run.jobId !== input.stream.id
        : run.jobId !== undefined && run.jobId !== input.stream.id) ||
      Object.entries(snapshot.runtime.agentRuns).some(
        ([agent, other]) => agent !== request.discussionRun?.agent && other.jobId === input.stream.id,
      )
    ) {
      throw new CoralSetupError({
        code: 'job_binding_owner_mismatch',
        userMessage: `Job '${input.stream.id}' does not match an open discussion and bound agent run.`,
        remediation: 'Continue only the job bound to that agent in the open owning discussion.',
      });
    }
  }
};

const validateDiscussionJobLinks: DomainAppendValidator = (ctx, inputs) => {
  const snapshots = new Map<string, PersistedDiscussSnapshot | undefined>();
  const jobs = new Map<string, JobOpenedBody>();
  const requests = new Map<string, JobExecutionRequestedBody>();
  const snapshotFor = (id: string) => {
    if (!snapshots.has(id)) snapshots.set(id, readProjectionDiscuss(ctx.db, id)?.state);
    return snapshots.get(id);
  };
  for (const input of inputs) {
    if (input.type === 'job.opened') {
      jobs.set(input.stream.id, jobOpenedBodySchema.parse(input.body));
      continue;
    }
    if (input.type === 'job.execution.requested') {
      requests.set(input.stream.id, jobExecutionRequestedBodySchema.parse(input.body));
      continue;
    }
    if (input.type === 'discuss.session.created') {
      const { sourceSeq, ...payload } = discussEventBodySchemas['session.created'].parse(input.body);
      snapshots.set(
        input.stream.id,
        createDiscussSnapshot({
          v: 1,
          sessionId: input.stream.id,
          projectRoot: input.project!,
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
    )
      continue;
    const body =
      input.type === 'discuss.agent.run.bound'
        ? discussEventBodySchemas['agent.run.bound'].parse(input.body)
        : input.type === 'discuss.agent.job.started'
          ? discussEventBodySchemas['agent.job.started'].parse(input.body)
          : discussEventBodySchemas['agent.job.finished'].parse(input.body);
    const snapshot = snapshotFor(input.stream.id);
    const run = snapshot?.runtime.agentRuns[body.agent];
    const job = jobs.get(body.jobId) ?? readJobOpened(ctx.db, body.jobId, ctx.readCtx);
    const request = requests.get(body.jobId) ?? readLatestExecutionRequest(ctx.db, body.jobId, ctx.readCtx)?.request;
    if (
      run === undefined ||
      job?.owner.kind !== 'discussion' ||
      job.owner.id !== input.stream.id ||
      request?.discussionRun?.agent !== body.agent
    ) {
      throw invalidDiscussionLink('Discussion job linkage requires its owning aggregate and agent descriptor.', {
        discussionId: input.stream.id,
        jobId: body.jobId,
      });
    }
    if (input.type === 'discuss.agent.run.bound') {
      if (run.jobId !== undefined && run.jobId !== body.jobId)
        throw invalidDiscussionLink('An agent run cannot change its bound job.', { jobId: body.jobId });
      run.jobId = body.jobId;
    } else if (input.type === 'discuss.agent.job.started') {
      const start = discussEventBodySchemas['agent.job.started'].parse(input.body);
      if (
        run.jobId !== start.jobId ||
        run.currentJobId !== undefined ||
        request.execution !== start.execution ||
        request.discussionRun.purpose !== start.purpose ||
        request.discussionRun.attempt !== start.attempt
      ) {
        throw invalidDiscussionLink('Discussion start must identify the requested execution.', {
          jobId: start.jobId,
          execution: start.execution,
        });
      }
      run.currentJobId = start.jobId;
      run.currentExecution = start.execution;
      run.currentJobPurpose = start.purpose;
      run.currentAttempt = start.attempt;
    } else {
      const end = discussEventBodySchemas['agent.job.finished'].parse(input.body);
      if (
        run.currentJobId !== end.jobId ||
        run.currentExecution !== end.execution ||
        run.currentAttempt !== end.attempt
      )
        throw invalidDiscussionLink('Discussion finish must identify its active execution.', {
          jobId: end.jobId,
          execution: end.execution,
        });
      run.currentJobId = undefined;
      run.currentExecution = undefined;
      run.currentJobPurpose = undefined;
      run.currentAttempt = undefined;
    }
  }
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
