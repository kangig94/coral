import { jobOpenedBodySchema, jobExecutionRequestedBodySchema } from '#src/jobs/launch.js';
import { jobRuntimeStartedBodySchema, jobProgressBodySchema } from '#src/jobs/event-bodies.js';
import { jobExecutionOutcomeAcceptedBodySchema } from '#src/jobs/terminal/result.js';
import { nextDelivered } from '#tests/helpers/wait-stream.js';
import { advanceWaitRenderCursor } from '#src/jobs/wait/stream-event.js';
import type { WaitCursor } from '#src/jobs/wait/contract.js';
import { progressVisitFromEvents } from '#tests/helpers/wait-progress.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import type { UsageSummary } from '#src/providers/contract.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it } from 'vitest';

import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { commit } from '#src/store/append.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { appendJobExecutionEnded } from '#src/jobs/terminal/recording.js';
import { testConversationFacet } from '#tests/helpers/session.js';
import { readJobEvents, loadJobWaitDetail, readJobLastSeq } from '#src/jobs/read-queries.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { publishJobEvents, subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';
import type { ConversationReadPort } from '#src/jobs/conversation/contracts.js';
const runtimes = new Set<ReturnType<typeof createRealRuntime>>();

const missingConversationManager = {
  get: () => null,
} satisfies ConversationReadPort;

const waitUsage = {
  inputTokens: 11,
  cacheReadTokens: 22,
  cacheWriteTokens: 3,
  outputTokens: 5,
  costUsd: 0.42,
} satisfies UsageSummary;

afterEach(() => {
  runtimes.clear();
});

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function createJournalAppender(db: Database) {
  const reducers = composeReducers(jobsRegistry);
  const bodyCodec = createEventBodyCodec();

  return (inputs: readonly CoralEventInput[]) => {
    const appended = commit(
      db,
      (c) => {
        for (const input of inputs) {
          const body =
            input.type === 'job.opened'
              ? jobOpenedBodySchema.parse(input.body)
              : input.type === 'job.execution.requested'
                ? jobExecutionRequestedBodySchema.parse(input.body)
                : input.type === 'job.execution.started'
                  ? jobRuntimeStartedBodySchema.parse(input.body)
                  : input.type === 'job.execution.progress'
                    ? jobProgressBodySchema.parse(input.body)
                    : input.type === 'job.execution.outcome.accepted'
                      ? jobExecutionOutcomeAcceptedBodySchema.parse(input.body)
                      : (() => {
                          throw new Error(`Unexpected fixture event ${input.type}.`);
                        })();
          const causeRef = c.append({ ...input, body });
          if (input.type === 'job.execution.outcome.accepted') {
            appendJobExecutionEnded(c, {
              jobId: input.stream.id,
              execution: 1,
              causeRef,
              namespace: input.namespace,
              project: input.project,
            });
          }
        }
        return undefined;
      },
      {
        now: () => new Date('2026-04-19T00:00:00.000Z'),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      },
    );
    publishJobEvents(appended, db, { ...reducers, bodyCodec });
  };
}

describe('wait SSE reconnect', () => {
  it('resumes from the next per-job event without gaps or duplication across catch-up and live tail', async () => {
    const db = createDb();
    const runtime = createRealRuntime('prod');
    runtimes.add(runtime);

    const eventBus = new TypedEventBus();
    const progressStore = new JobStore('wait-sse-ns', runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const append = createJournalAppender(db);
    const jobId = '10000000-0000-4000-8000-000000000001';
    const projectRoot = '/tmp/wait-sse-project';

    const appendLaunch = () =>
      append([
        {
          type: 'job.opened',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-sse-ns',
          project: projectRoot,
          correlationId: 'wait-sse-correlation',
          refs: { jobId },
          body: {
            owner: { kind: 'provider-session', id: jobId },
            jobKind: 'provider',
            projectRoot,
            createdAt: '2026-04-19T00:00:00.000Z',
            conversation: testConversationFacet('codex', projectRoot),
          },
        },
        {
          type: 'job.execution.requested',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-sse-ns',
          project: projectRoot,
          correlationId: 'wait-sse-correlation',
          refs: { jobId },
          body: {
            execution: 1,
            input: 'hello',
            action: 'exec',
            backendNamespace: 'wait-sse-ns',
            bundleHash: 'wait-sse-bundle',
            pool: 'default',
            enqueueSequence: 0,
            coralEnv: {},
            createdAt: '2026-04-19T00:00:00.000Z',
          },
        },
      ]);

    const appendRuntime = () =>
      append([
        {
          type: 'job.execution.started',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-sse-ns',
          project: projectRoot,
          correlationId: 'wait-sse-correlation',
          refs: { jobId },
          body: {
            execution: 1,
            transport: 'durable-cli',
            pid: 123,
            stdoutPath: '/tmp/stdout',
            stderrPath: '/tmp/stderr',
            startedAt: '2026-04-19T00:00:01.000Z',
          },
        },
      ]);

    const appendProgress = (message: string) =>
      append([
        {
          type: 'job.execution.progress',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-sse-ns',
          project: projectRoot,
          correlationId: 'wait-sse-correlation',
          refs: { jobId },
          body: {
            execution: 1,
            kind: 'message',
            message,
            timing: {
              origin: 'runtime',
              originAt: '2026-04-19T00:00:01.000Z',
              emittedAt: '2026-04-19T00:00:02.000Z',
              elapsedMs: 1000,
            },
          },
        },
      ]);

    const commitTerminal = () =>
      append([
        {
          type: 'job.execution.outcome.accepted',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-sse-ns',
          project: projectRoot,
          correlationId: 'wait-sse-correlation',
          refs: { jobId },
          body: {
            execution: 1,
            terminal: {
              outcome: { kind: 'completed' },
              durationMs: 12,
              content: 'done',
            },
            diagnostics: {
              usage: waitUsage,
            },
          },
        },
      ]);

    appendLaunch();
    appendRuntime();
    appendProgress('progress-1');

    const coordinator = new WaitCoordinator({
      visitProgress: progressVisitFromEvents((targetJobId) => readJobEvents(db, targetJobId, progressStore)),
      conversationManager: missingConversationManager,
      launchQueue: launchCoordinator,
      eventBus,
      time: runtime.time,
      loadJobWaitDetail: (targetJobId) => loadJobWaitDetail(db, targetJobId, progressStore),
      readJobLastSeq: (targetJobId) => readJobLastSeq(db, targetJobId),

      aggregateWorkflowUsage: (workflowJobId) => aggregateWorkflowUsage(db, workflowJobId),
      subscribeJobEvents,
      getCurrentJournalSeq: () =>
        (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq,
      resultJobsRoot: '/tmp/coral-exports/jobs',
      observeResultAvailability: (jobId) => ({
        kind: 'available',
        resultPath: `${'/tmp/coral-exports/jobs'}/${jobId}/result.md`,
      }),
    });

    const firstIterator = coordinator.waitForOutcomes({ jobIds: [jobId], timeoutSeconds: 5 })[Symbol.asyncIterator]();
    let clientCursor: WaitCursor | undefined;
    const first = await firstIterator.next();
    expect(first.value).toMatchObject({
      type: 'progress',
      jobId,
      seq: 4,
      message: 'progress-1',
    });
    // The poll that delivered the row frames the cursor a cut after it resumes from.
    const framed = await firstIterator.next();
    expect(framed.value).toMatchObject({ type: 'cursor' });
    if (!framed.done) clientCursor = advanceWaitRenderCursor(clientCursor, framed.value).cursor;
    await firstIterator.return?.(undefined);

    appendProgress('progress-2');

    const reconnectIterator = coordinator
      .waitForOutcomes({
        jobIds: [jobId],
        timeoutSeconds: 5,
        cursor: clientCursor,
      })
      [Symbol.asyncIterator]();

    const replayed = await nextDelivered(reconnectIterator);
    expect(replayed.done).toBe(false);
    expect(replayed.value).toMatchObject({
      type: 'progress',
      jobId,
      seq: 5,
      message: 'progress-2',
    });

    const liveProgressPromise = nextDelivered(reconnectIterator);
    appendProgress('progress-3');
    const liveProgress = await liveProgressPromise;
    expect(liveProgress.done).toBe(false);
    expect(liveProgress.value).toMatchObject({
      type: 'progress',
      jobId,
      seq: 6,
      message: 'progress-3',
    });

    const terminalPromise = nextDelivered(reconnectIterator);
    commitTerminal();
    const terminal = await terminalPromise;
    expect(terminal.done).toBe(false);
    expect(terminal.value).toMatchObject({
      type: 'terminal',
      jobId,
      result: {
        content: 'done',
        outcome: { kind: 'completed' },
      },
      usage: waitUsage,
    });

    await expect(reconnectIterator.next()).resolves.toEqual({ done: true, value: undefined });
    db.close();
  });

  it('does not lose a terminal event that arrives while building the catch-up snapshot', async () => {
    const db = createDb();
    const runtime = createRealRuntime('prod');
    runtimes.add(runtime);

    const eventBus = new TypedEventBus();
    const progressStore = new JobStore('wait-race-ns', runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const append = createJournalAppender(db);
    const jobId = '10000000-0000-4000-8000-000000000002';
    const projectRoot = '/tmp/wait-race-project';

    const appendLaunch = () =>
      append([
        {
          type: 'job.opened',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-race-ns',
          project: projectRoot,
          correlationId: 'wait-race-correlation',
          refs: { jobId },
          body: {
            owner: { kind: 'provider-session', id: jobId },
            jobKind: 'provider',
            projectRoot,
            createdAt: '2026-04-19T00:00:00.000Z',
            conversation: testConversationFacet('codex', projectRoot),
          },
        },
        {
          type: 'job.execution.requested',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-race-ns',
          project: projectRoot,
          correlationId: 'wait-race-correlation',
          refs: { jobId },
          body: {
            execution: 1,
            input: 'hello',
            action: 'exec',
            backendNamespace: 'wait-race-ns',
            bundleHash: 'wait-race-bundle',
            pool: 'default',
            enqueueSequence: 0,
            coralEnv: {},
            createdAt: '2026-04-19T00:00:00.000Z',
          },
        },
      ]);

    const appendRuntime = () =>
      append([
        {
          type: 'job.execution.started',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-race-ns',
          project: projectRoot,
          correlationId: 'wait-race-correlation',
          refs: { jobId },
          body: {
            execution: 1,
            transport: 'durable-cli',
            pid: 123,
            stdoutPath: '/tmp/stdout',
            stderrPath: '/tmp/stderr',
            startedAt: '2026-04-19T00:00:01.000Z',
          },
        },
      ]);

    const appendProgress = () =>
      append([
        {
          type: 'job.execution.progress',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-race-ns',
          project: projectRoot,
          correlationId: 'wait-race-correlation',
          refs: { jobId },
          body: {
            execution: 1,
            kind: 'message',
            message: 'progress-before-race',
            timing: {
              origin: 'runtime',
              originAt: '2026-04-19T00:00:01.000Z',
              emittedAt: '2026-04-19T00:00:02.000Z',
              elapsedMs: 1000,
            },
          },
        },
      ]);

    const commitTerminal = () =>
      append([
        {
          type: 'job.execution.outcome.accepted',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-race-ns',
          project: projectRoot,
          correlationId: 'wait-race-correlation',
          refs: { jobId },
          body: {
            execution: 1,
            terminal: {
              outcome: { kind: 'completed' },
              durationMs: 4,
              content: 'done-after-race',
            },
          },
        },
      ]);

    appendLaunch();
    appendRuntime();
    appendProgress();

    let terminalInjected = false;
    const coordinator = new WaitCoordinator({
      visitProgress: progressVisitFromEvents((targetJobId) => {
        const events = readJobEvents(db, targetJobId, progressStore);
        if (!terminalInjected) {
          terminalInjected = true;
          commitTerminal();
        }
        return events;
      }),
      conversationManager: missingConversationManager,
      launchQueue: launchCoordinator,
      eventBus,
      time: runtime.time,
      loadJobWaitDetail: (targetJobId) => loadJobWaitDetail(db, targetJobId, progressStore),
      readJobLastSeq: (targetJobId) => readJobLastSeq(db, targetJobId),

      aggregateWorkflowUsage: (workflowJobId) => aggregateWorkflowUsage(db, workflowJobId),
      subscribeJobEvents,
      getCurrentJournalSeq: () =>
        (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq,
      resultJobsRoot: '/tmp/coral-exports/jobs',
      observeResultAvailability: (jobId) => ({
        kind: 'available',
        resultPath: `${'/tmp/coral-exports/jobs'}/${jobId}/result.md`,
      }),
    });

    const iterator = coordinator.waitForOutcomes({ jobIds: [jobId], timeoutSeconds: 1 })[Symbol.asyncIterator]();
    const progress = await nextDelivered(iterator);
    expect(progress.done).toBe(false);
    expect(progress.value).toMatchObject({
      type: 'progress',
      jobId,
      seq: 4,
      message: 'progress-before-race',
    });

    const terminal = await nextDelivered(iterator);
    expect(terminal.done).toBe(false);
    expect(terminal.value).toMatchObject({
      type: 'terminal',
      jobId,
      result: {
        content: 'done-after-race',
        outcome: { kind: 'completed' },
      },
    });

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    db.close();
  });
});
