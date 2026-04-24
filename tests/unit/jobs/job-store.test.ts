import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { type StoragePort } from '#src/runtime/ports.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcasters.js';
import { isLivePhase } from '#src/jobs/phase.js';
import { JobStore } from '#src/jobs/job-store.js';
import type { JobLaunch, JobStatus, JobTerminal } from '#src/jobs/records.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

const openDbs = new Set<InstanceType<typeof Database>>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  openDbs.add(db);
  return db;
}

function createTrackedDb(db: InstanceType<typeof Database>): {
  db: InstanceType<typeof Database>;
  preparedSql: string[];
} {
  const preparedSql: string[] = [];
  const trackedDb: InstanceType<typeof Database> = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          preparedSql.push(sql);
          return target.prepare(sql);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { db: trackedDb, preparedSql };
}

function createStore(db: InstanceType<typeof Database> = createDb()): {
  runtime: SimulationRuntime;
  store: JobStore;
} {
  const runtime = new SimulationRuntime();
  return {
    runtime,
    store: new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), { eventBus: new TypedEventBus(), db }),
  };
}

function launchRecord(jobId: string, sessionId: string, backendNamespace: string, bundleHash?: string): JobLaunch {
  return {
    jobId,
    sessionId,
    provider: 'codex',
    projectRoot: `/workspace/${jobId}`,
    backendNamespace,
    jobKind: 'provider',
    ...(bundleHash === undefined ? {} : { bundleHash }),
    pool: 'default',
    enqueueSequence: 1,
    providerAction: 'exec',
    request: {
      prompt: `prompt for ${jobId}`,
      cwd: `/workspace/${jobId}`,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: '2026-04-19T00:00:00.000Z',
  };
}

function referenceLiveCount(statuses: Array<{ jobId: string; status: JobStatus }>, bundleHash?: string): number {
  return statuses.filter(({ status }) => isLivePhase(status.phase) && (bundleHash === undefined || status.bundleHash === bundleHash)).length;
}

function referenceLiveCountByNamespace(statuses: Array<{ jobId: string; status: JobStatus }>, namespace: string): number {
  if (!namespace) {
    return 0;
  }

  return statuses.filter(({ status }) => isLivePhase(status.phase) && status.backendNamespace === namespace).length;
}

describe('JobStore', () => {
  it('returns journal seqs from progress and terminal appends', () => {
    const backingDb = createDb();
    const { db, preparedSql } = createTrackedDb(backingDb);
    const { store } = createStore(db);
    const jobId = 'job-progress-tail';
    const sessionId = 'session-progress-tail';

    store.initJob({
      jobId,
      sessionId,
      provider: 'codex',
      projectRoot: '/workspace/progress-tail',
      backendNamespace: 'test-ns',
      bundleHash: 'bundle-a',
    });
    store.appendLaunchRequested(jobId, launchRecord(jobId, sessionId, 'test-ns', 'bundle-a'));

    preparedSql.length = 0;

    const tails = Array.from({ length: 5 }, (_, index) =>
      store.appendProgress(jobId, sessionId, `step-${index + 1}`),
    );

    store.appendEvent({
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: jobId },
      namespace: 'test-ns',
      project: '/workspace/progress-tail',
      refs: { jobId, sessionId },
      bodyVersion: 1,
      body: {
        kind: 'recovery_parse_failed',
        cause: { message: 'partial stderr' },
      },
    });

    const terminalResult: JobTerminal = {
      content: 'done',
      outcome: { kind: 'completed' },
    };

    expect(tails).toEqual([3, 4, 5, 6, 7]);
    expect(store.appendTerminal(jobId, sessionId, terminalResult, 'completed')).toBe(9);
    expect(preparedSql.filter((sql) => sql.includes('ROW_NUMBER() OVER'))).toEqual([]);
  });

  it('matches live count semantics for projections and namespace overrides', () => {
    const { store } = createStore();

    store.initJob({
      jobId: 'job-alpha',
      sessionId: 'session-alpha',
      provider: 'codex',
      projectRoot: '/workspace/alpha',
      backendNamespace: 'alpha',
      bundleHash: 'bundle-a',
    });
    store.appendLaunchRequested('job-alpha', launchRecord('job-alpha', 'session-alpha', 'alpha', 'bundle-a'));

    store.initJob({
      jobId: 'job-beta',
      sessionId: 'session-beta',
      provider: 'codex',
      projectRoot: '/workspace/beta',
      backendNamespace: 'beta',
      bundleHash: 'bundle-a',
    });
    store.appendLaunchRequested('job-beta', launchRecord('job-beta', 'session-beta', 'beta', 'bundle-a'));

    store.initJob({
      jobId: 'job-override',
      sessionId: 'session-override',
      provider: 'codex',
      projectRoot: '/workspace/override',
      backendNamespace: 'alpha',
      bundleHash: 'bundle-a',
    });
    store.appendLaunchRequested('job-override', launchRecord('job-override', 'session-override', 'alpha', 'bundle-a'));
    store.rebindNamespace('job-override', 'override', 'bundle-override');

    store.initJob({
      jobId: 'job-done',
      sessionId: 'session-done',
      provider: 'codex',
      projectRoot: '/workspace/done',
      backendNamespace: 'alpha',
      bundleHash: 'bundle-a',
    });
    store.appendLaunchRequested('job-done', launchRecord('job-done', 'session-done', 'alpha', 'bundle-a'));
    store.appendTerminal('job-done', 'session-done', { content: 'done', outcome: { kind: 'completed' } }, 'completed');

    store.initJob({
      jobId: 'job-draft',
      sessionId: 'session-draft',
      provider: 'codex',
      projectRoot: '/workspace/draft',
      backendNamespace: 'alpha',
      bundleHash: 'bundle-a',
      initialPhase: 'queued',
    });

    const statuses = store.listJobProjections();

    expect(store.liveJobCount()).toBe(referenceLiveCount(statuses));
    expect(store.liveJobCount('bundle-a')).toBe(referenceLiveCount(statuses, 'bundle-a'));
    expect(store.liveJobCount('bundle-override')).toBe(referenceLiveCount(statuses, 'bundle-override'));
    expect(store.liveJobCountByNamespace('alpha')).toBe(referenceLiveCountByNamespace(statuses, 'alpha'));
    expect(store.liveJobCountByNamespace('beta')).toBe(referenceLiveCountByNamespace(statuses, 'beta'));
    expect(store.liveJobCountByNamespace('override')).toBe(referenceLiveCountByNamespace(statuses, 'override'));
    expect(store.liveJobCountByNamespace('')).toBe(0);
  });
});
