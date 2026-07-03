import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it } from 'vitest';

import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { readJobEvents, loadJobProjectionDetail } from '#src/jobs/read-queries.js';
import { composeReducers } from '#src/store/reducers.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { publishJobEvents, subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
const runtimes = new Set<ReturnType<typeof createRealRuntime>>();

afterEach(() => {
  runtimes.clear();
});

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

function createJournalAppender(db: Database) {
  const reducers = composeReducers(jobsRegistry);
  const upcasters = createDefaultUpcasterRegistry();

  return (inputs: Parameters<typeof commitInputs>[1]) => {
    const appended = commitInputs(db, inputs, {
      now: () => new Date('2026-04-19T00:00:00.000Z'),
      reducers,
      upcasters,
      providers: permissiveProviderLookupPort,
    });
    publishJobEvents(appended);
  };
}

describe('wait SSE reconnect', () => {
  it('resumes from the next per-job event without gaps or duplication across catch-up and live tail', async () => {
    const db = createDb();
    const runtime = createRealRuntime('prod');
    runtimes.add(runtime);

    const eventBus = new TypedEventBus();
    const progressStore = new JobStore('wait-sse-ns', runtime, createDefaultUpcasterRegistry(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const append = createJournalAppender(db);
    const jobId = 'wait-sse-job';
    const sessionId = 'wait-sse-session';
    const projectRoot = '/tmp/wait-sse-project';

    const appendLaunch = () =>
      append([
        {
          type: 'job.launch.requested',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-sse-ns',
          project: projectRoot,
          correlationId: 'wait-sse-correlation',
          refs: { sessionId },
          bodyVersion: 1,
          body: {
            sessionId,
            provider: 'fake-provider',
            providerAction: 'exec',
            projectRoot,
            backendNamespace: 'wait-sse-ns',
            bundleHash: 'wait-sse-bundle',
            jobKind: 'provider',
            pool: 'default',
            enqueueSequence: 0,
            request: {
              prompt: 'hello',
              cwd: projectRoot,
              bypassPermissions: false,
              coralEnv: {},
            },
            createdAt: '2026-04-19T00:00:00.000Z',
          },
        },
      ]);

    const appendRuntime = () =>
      append([
        {
          type: 'job.runtime.started',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-sse-ns',
          project: projectRoot,
          correlationId: 'wait-sse-correlation',
          refs: { sessionId },
          bodyVersion: 1,
          body: {
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
          type: 'job.progress.emitted',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-sse-ns',
          project: projectRoot,
          correlationId: 'wait-sse-correlation',
          refs: { sessionId },
          bodyVersion: 1,
          body: {
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
          type: 'job.terminal.recorded',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-sse-ns',
          project: projectRoot,
          correlationId: 'wait-sse-correlation',
          refs: { sessionId },
          bodyVersion: 1,
          body: {
            terminal: {
              outcome: { kind: 'completed' },
              durationMs: 12,
              content: 'done',
            },
          },
        },
      ]);

    appendLaunch();
    appendRuntime();
    appendProgress('progress-1');

    const coordinator = new WaitCoordinator({
      sessionManager: {} as never,
      launchQueue: launchCoordinator,
      eventBus,
      jobPools: new Map(),
      time: runtime.time,
      loadJobProjectionDetail: (targetJobId) => loadJobProjectionDetail(db, targetJobId, progressStore),
      readJobEvents: (targetJobId) => readJobEvents(db, targetJobId, progressStore),
      subscribeJobEvents,
      getCurrentJournalSeq: () =>
        (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq,
      resultJobsRoot: '/tmp/coral-exports/jobs',
    });

    const firstIterator = coordinator.waitForJobs({ jobIds: [jobId], timeoutSeconds: 5 })[Symbol.asyncIterator]();
    const first = await firstIterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: 'progress',
      jobId,
      seq: 3,
      message: 'progress-1',
    });
    await firstIterator.return?.(undefined);

    appendProgress('progress-2');

    const reconnectIterator = coordinator
      .waitForJobs({
        jobIds: [jobId],
        timeoutSeconds: 5,
        cursor: { afterSeq: 3 },
      })
      [Symbol.asyncIterator]();

    const replayed = await reconnectIterator.next();
    expect(replayed.done).toBe(false);
    expect(replayed.value).toMatchObject({
      type: 'progress',
      jobId,
      seq: 4,
      message: 'progress-2',
    });

    const liveProgressPromise = reconnectIterator.next();
    appendProgress('progress-3');
    const liveProgress = await liveProgressPromise;
    expect(liveProgress.done).toBe(false);
    expect(liveProgress.value).toMatchObject({
      type: 'progress',
      jobId,
      seq: 5,
      message: 'progress-3',
    });

    const terminalPromise = reconnectIterator.next();
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
    });

    await expect(reconnectIterator.next()).resolves.toEqual({ done: true, value: undefined });
    db.close();
  });

  it('does not lose a terminal event that arrives while building the catch-up snapshot', async () => {
    const db = createDb();
    const runtime = createRealRuntime('prod');
    runtimes.add(runtime);

    const eventBus = new TypedEventBus();
    const progressStore = new JobStore('wait-race-ns', runtime, createDefaultUpcasterRegistry(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const append = createJournalAppender(db);
    const jobId = 'wait-race-job';
    const sessionId = 'wait-race-session';
    const projectRoot = '/tmp/wait-race-project';

    const appendLaunch = () =>
      append([
        {
          type: 'job.launch.requested',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-race-ns',
          project: projectRoot,
          correlationId: 'wait-race-correlation',
          refs: { sessionId },
          bodyVersion: 1,
          body: {
            sessionId,
            provider: 'fake-provider',
            providerAction: 'exec',
            projectRoot,
            backendNamespace: 'wait-race-ns',
            bundleHash: 'wait-race-bundle',
            jobKind: 'provider',
            pool: 'default',
            enqueueSequence: 0,
            request: {
              prompt: 'hello',
              cwd: projectRoot,
              bypassPermissions: false,
              coralEnv: {},
            },
            createdAt: '2026-04-19T00:00:00.000Z',
          },
        },
      ]);

    const appendRuntime = () =>
      append([
        {
          type: 'job.runtime.started',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-race-ns',
          project: projectRoot,
          correlationId: 'wait-race-correlation',
          refs: { sessionId },
          bodyVersion: 1,
          body: {
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
          type: 'job.progress.emitted',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-race-ns',
          project: projectRoot,
          correlationId: 'wait-race-correlation',
          refs: { sessionId },
          bodyVersion: 1,
          body: {
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
          type: 'job.terminal.recorded',
          stream: { kind: 'job', id: jobId },
          namespace: 'wait-race-ns',
          project: projectRoot,
          correlationId: 'wait-race-correlation',
          refs: { sessionId },
          bodyVersion: 1,
          body: {
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
      sessionManager: {} as never,
      launchQueue: launchCoordinator,
      eventBus,
      jobPools: new Map(),
      time: runtime.time,
      loadJobProjectionDetail: (targetJobId) => loadJobProjectionDetail(db, targetJobId, progressStore),
      readJobEvents: (targetJobId) => {
        const events = readJobEvents(db, targetJobId, progressStore);
        if (!terminalInjected) {
          terminalInjected = true;
          commitTerminal();
        }
        return events;
      },
      subscribeJobEvents,
      getCurrentJournalSeq: () =>
        (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq,
      resultJobsRoot: '/tmp/coral-exports/jobs',
    });

    const iterator = coordinator.waitForJobs({ jobIds: [jobId], timeoutSeconds: 1 })[Symbol.asyncIterator]();
    const progress = await iterator.next();
    expect(progress.done).toBe(false);
    expect(progress.value).toMatchObject({
      type: 'progress',
      jobId,
      seq: 3,
      message: 'progress-before-race',
    });

    const terminal = await iterator.next();
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
