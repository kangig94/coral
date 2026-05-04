
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { isLivePhase } from '#src/jobs/phase.js';
import { JobStore } from '#src/jobs/store.js';
import type { JobLaunch, JobStatus, JobTerminal } from '#src/jobs/records.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { commitJobInput, commitJobInputs, commitJobTerminal } from '#tests/helpers/job-commits.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
const openDbs = new Set<Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  openDbs.add(db);
  return db;
}

function createTrackedDb(db: Database): {
  db: Database;
  preparedSql: string[];
} {
  const preparedSql: string[] = [];
  const trackedDb: Database = new Proxy(db, {
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

function createStore(db: Database = createDb()): {
  runtime: SimulationRuntime;
  store: JobStore;
} {
  const runtime = new SimulationRuntime();
  return {
    runtime,
    store: new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), {
      eventBus: new TypedEventBus(),
      db,
      providers: permissiveProviderLookupPort,
    }),
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
  return statuses.filter(
    ({ status }) => isLivePhase(status.phase) && (bundleHash === undefined || status.bundleHash === bundleHash),
  ).length;
}

function referenceLiveCountByNamespace(
  statuses: Array<{ jobId: string; status: JobStatus }>,
  namespace: string,
): number {
  if (!namespace) {
    return 0;
  }

  return statuses.filter(({ status }) => isLivePhase(status.phase) && status.backendNamespace === namespace).length;
}

function initProviderJob(store: JobStore, jobId: string, sessionId: string): void {
  store.initJob({
    jobId,
    sessionId,
    provider: 'codex',
    projectRoot: `/workspace/${jobId}`,
    backendNamespace: 'test-ns',
  });
}

function terminalInput(jobId: string, sessionId: string): CoralEventInput {
  return {
    type: 'job.terminal.recorded',
    stream: { kind: 'job', id: jobId },
    namespace: 'test-ns',
    project: `/workspace/${jobId}`,
    refs: { jobId, sessionId },
    bodyVersion: 1,
    body: {
      terminal: {
        content: 'done',
        outcome: { kind: 'completed' },
      },
    },
  };
}

function progressInput(jobId: string, sessionId: string): CoralEventInput {
  return {
    type: 'job.progress.emitted',
    stream: { kind: 'job', id: jobId },
    namespace: 'test-ns',
    project: `/workspace/${jobId}`,
    refs: { jobId, sessionId },
    bodyVersion: 1,
    body: {
      kind: 'message',
      message: 'late progress',
    },
  };
}

function expectTerminalOrderViolation(run: () => unknown, jobId: string, type: string): void {
  expect(run).toThrowError(
    expect.objectContaining({
      code: 'job_terminal_order_violation',
      context: expect.objectContaining({ jobId, type }),
    }),
  );
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

    const tails = Array.from({ length: 5 }, (_, index) => store.appendProgress(jobId, sessionId, `step-${index + 1}`));

    commitJobInput(store, {
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
    expect(commitJobTerminal(store, jobId, sessionId, terminalResult)).toBe(9);
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
    commitJobTerminal(store, 'job-done', 'session-done', { content: 'done', outcome: { kind: 'completed' } });

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

  it('rejects duplicate terminal events for the same job stream', () => {
    const { store } = createStore();
    const jobId = 'job-duplicate-terminal';
    const sessionId = 'session-duplicate-terminal';
    initProviderJob(store, jobId, sessionId);

    commitJobTerminal(store, jobId, sessionId, { content: 'done', outcome: { kind: 'completed' } });

    expectTerminalOrderViolation(
      () => commitJobTerminal(store, jobId, sessionId, { content: 'again', outcome: { kind: 'completed' } }),
      jobId,
      'job.terminal.recorded',
    );
  });

  it('rejects progress after a terminal event has been recorded', () => {
    const { store } = createStore();
    const jobId = 'job-late-progress';
    const sessionId = 'session-late-progress';
    initProviderJob(store, jobId, sessionId);

    commitJobTerminal(store, jobId, sessionId, { content: 'done', outcome: { kind: 'completed' } });

    expectTerminalOrderViolation(
      () => store.appendProgress(jobId, sessionId, 'too late'),
      jobId,
      'job.progress.emitted',
    );
  });

  it('rejects job events after terminal in the same append batch', () => {
    const { store } = createStore();
    const jobId = 'job-batch-terminal-last';
    const sessionId = 'session-batch-terminal-last';
    initProviderJob(store, jobId, sessionId);

    expectTerminalOrderViolation(
      () => commitJobInputs(store, [terminalInput(jobId, sessionId), progressInput(jobId, sessionId)]),
      jobId,
      'job.progress.emitted',
    );
  });

  it('rejects duplicate terminal events in the same append batch', () => {
    const { store } = createStore();
    const jobId = 'job-batch-duplicate-terminal';
    const sessionId = 'session-batch-duplicate-terminal';
    initProviderJob(store, jobId, sessionId);

    expectTerminalOrderViolation(
      () => commitJobInputs(store, [terminalInput(jobId, sessionId), terminalInput(jobId, sessionId)]),
      jobId,
      'job.terminal.recorded',
    );
  });

  it('allows launch rejection to be followed by a terminal outcome', () => {
    const { store } = createStore();
    const jobId = 'job-rejected-terminal';
    const sessionId = 'session-rejected-terminal';
    initProviderJob(store, jobId, sessionId);

    const [rejected] = commitJobInputs(store, [
      {
        type: 'job.launch.rejected',
        stream: { kind: 'job', id: jobId },
        namespace: 'test-ns',
        project: `/workspace/${jobId}`,
        refs: { jobId, sessionId },
        bodyVersion: 1,
        body: {
          reason: 'busy',
          message: 'busy',
          provider: 'codex',
          globalActive: 1,
          globalLimit: 1,
        },
      },
    ]);

    expect(rejected?.type).toBe('job.launch.rejected');
    expect(store.readStatus(jobId)?.phase).toBe('error');

    expect(
      commitJobTerminal(store, jobId, sessionId, {
        content: 'failed',
        outcome: {
          kind: 'failed',
          causeRef: {
            stream: { kind: 'job', id: jobId },
            seq: rejected.seq,
          },
        },
      }),
    ).toBeGreaterThan(rejected.seq);
  });

  it('allows an abort event to be followed by a terminal outcome', () => {
    const { store } = createStore();
    const jobId = 'job-aborted-terminal';
    const sessionId = 'session-aborted-terminal';
    initProviderJob(store, jobId, sessionId);

    const [aborted] = commitJobInputs(store, [
      {
        type: 'job.aborted',
        stream: { kind: 'job', id: jobId },
        namespace: 'test-ns',
        project: `/workspace/${jobId}`,
        refs: { jobId, sessionId },
        bodyVersion: 1,
        body: { reason: 'user_abort' },
      },
    ]);

    expect(aborted?.type).toBe('job.aborted');
    expect(store.readStatus(jobId)?.phase).toBe('aborted');
    expect(
      commitJobTerminal(store, jobId, sessionId, { content: '', outcome: { kind: 'aborted', reason: 'user_abort' } }),
    ).toBeGreaterThan(aborted.seq);
  });
});
