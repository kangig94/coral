import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { LaunchCoordinator } from '../../../coordinator/live/admission.js';
import { TypedEventBus } from '../../../execution/backend-contracts.js';
import { ProgressStore } from '../../../execution/progress-store.js';
import { createRealRuntime } from '../../../runtime/real.js';
import type { StoragePort } from '../../../runtime/ports.js';
import { applyMigrations } from '../../../store/migrations.js';
import { appendEvents } from '../../../store/append.js';
import { createEmptyRegistry } from '../../../store/envelope.js';
import { readJobProgress, loadJobProjectionDetail } from '../../../store/queries/jobs.js';
import { composeReducers } from '../../../store/reducers.js';
import { jobsRegistry } from '../../events.js';
import { publishJobEvents, subscribeJobEvents } from '../event-subscription.js';
import { WaitCoordinator } from '../wait.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

const runtimes = new Set<ReturnType<typeof createRealRuntime>>();

afterEach(() => {
  runtimes.clear();
});

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: nodeStorage });
  return db;
}

function createJournalAppender(db: InstanceType<typeof Database>) {
  const reducers = composeReducers(jobsRegistry);
  const upcasters = createEmptyRegistry();

  return (inputs: Parameters<typeof appendEvents>[1]) => {
    const appended = appendEvents(db, inputs, {
      now: () => new Date('2026-04-19T00:00:00.000Z'),
      reducers,
      upcasters,
    });
    publishJobEvents(db, appended);
  };
}

describe('wait SSE reconnect', () => {
  it('resumes from the next per-job event without gaps or duplication across catch-up and live tail', async () => {
    const db = createDb();
    const runtime = createRealRuntime();
    runtimes.add(runtime);

    const eventBus = new TypedEventBus();
    const progressStore = new ProgressStore('wait-sse-ns', runtime, eventBus);
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
            ts: '2026-04-19T00:00:02.000Z',
          },
        },
      ]);

    const appendTerminal = () =>
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
            outcome: { kind: 'completed' },
            durationMs: 12,
            content: 'done',
            exitCode: 0,
            signal: null,
          },
        },
      ]);

    appendLaunch();
    appendRuntime();
    appendProgress('progress-1');

    const coordinator = new WaitCoordinator({
      progressStore,
      sessionManager: {} as never,
      launchCoordinator,
      eventBus,
      jobPools: new Map(),
      time: runtime.time,
      loadJobProjectionDetail: (targetJobId) => loadJobProjectionDetail(db, targetJobId),
      readJobProgress: (targetJobId) => readJobProgress(db, targetJobId),
      subscribeJobEvents,
      getCurrentJournalSeq: () =>
        (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq,
    });

    const firstIterator = coordinator.waitForJobs({ jobIds: [jobId], timeoutSeconds: 5 })[Symbol.asyncIterator]();
    const first = await firstIterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: 'progress',
      jobId,
      eventId: 1,
      message: 'progress-1',
    });
    await firstIterator.return?.(undefined);

    appendProgress('progress-2');

    const reconnectIterator = coordinator.waitForJobs({
      jobIds: [jobId],
      timeoutSeconds: 5,
      cursor: { jobs: { [jobId]: 1 } },
    })[Symbol.asyncIterator]();

    const replayed = await reconnectIterator.next();
    expect(replayed.done).toBe(false);
    expect(replayed.value).toMatchObject({
      type: 'progress',
      jobId,
      eventId: 2,
      message: 'progress-2',
    });

    const liveProgressPromise = reconnectIterator.next();
    appendProgress('progress-3');
    const liveProgress = await liveProgressPromise;
    expect(liveProgress.done).toBe(false);
    expect(liveProgress.value).toMatchObject({
      type: 'progress',
      jobId,
      eventId: 3,
      message: 'progress-3',
    });

    const terminalPromise = reconnectIterator.next();
    appendTerminal();
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
});
