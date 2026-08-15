import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { isLivePhase } from '#src/jobs/phase.js';
import { JobStore } from '#src/jobs/store.js';
import { writeResultArtifact } from '#src/jobs/terminal/export.js';
import type { JobStatus, JobTerminal } from '#src/jobs/records.js';
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
  applyBundledStoreSchema(db, currentCoralStoreFormat());
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
    store: new JobStore('test-ns', runtime, createEventBodyCodec(), {
      eventBus: new TypedEventBus(),
      db,
      providers: permissiveProviderLookupPort,
    }),
  };
}

function referenceLiveCount(statuses: Array<{ jobId: string; status: JobStatus }>): number {
  return statuses.filter(({ status }) => isLivePhase(status.phase)).length;
}

function initProviderJob(store: JobStore, jobId: string, sessionId: string): void {
  initTestJob(store, {
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
    body: {
      terminal: {
        content: 'done',
        outcome: { kind: 'completed' },
        durationMs: 0,
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
    body: {
      kind: 'message',
      message: 'late progress',
      timing: {
        origin: 'launch',
        originAt: '2026-04-19T00:00:00.000Z',
        emittedAt: '2026-04-19T00:00:01.000Z',
        elapsedMs: 1000,
      },
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

    initTestJob(store, {
      jobId,
      sessionId,
      provider: 'codex',
      projectRoot: '/workspace/progress-tail',
      backendNamespace: 'test-ns',
      bundleHash: 'bundle-a',
    });
    preparedSql.length = 0;

    const tails = Array.from({ length: 5 }, (_, index) => store.appendProgress(jobId, sessionId, `step-${index + 1}`));

    commitJobInput(store, {
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: jobId },
      namespace: 'test-ns',
      project: '/workspace/progress-tail',
      refs: { jobId, sessionId },
      body: {
        kind: 'recovery_parse_failed',
        cause: { message: 'partial stderr' },
      },
    });

    const terminalResult: JobTerminal = {
      content: 'done',
      outcome: { kind: 'completed' },
      durationMs: 0,
    };

    expect(tails).toEqual([2, 3, 4, 5, 6]);
    expect(commitJobTerminal(store, jobId, sessionId, terminalResult)).toBe(8);
    expect(preparedSql.filter((sql) => sql.includes('ROW_NUMBER() OVER'))).toEqual([]);
  });

  it('matches live count semantics for projections and namespace overrides', () => {
    const { store } = createStore();

    initTestJob(store, {
      jobId: 'job-alpha',
      sessionId: 'session-alpha',
      provider: 'codex',
      projectRoot: '/workspace/alpha',
      backendNamespace: 'alpha',
      bundleHash: 'bundle-a',
    });
    initTestJob(store, {
      jobId: 'job-beta',
      sessionId: 'session-beta',
      provider: 'codex',
      projectRoot: '/workspace/beta',
      backendNamespace: 'beta',
      bundleHash: 'bundle-a',
    });
    initTestJob(store, {
      jobId: 'job-override',
      sessionId: 'session-override',
      provider: 'codex',
      projectRoot: '/workspace/override',
      backendNamespace: 'alpha',
      bundleHash: 'bundle-a',
    });
    store.rebindNamespace('job-override', 'override', 'bundle-override');

    initTestJob(store, {
      jobId: 'job-done',
      sessionId: 'session-done',
      provider: 'codex',
      projectRoot: '/workspace/done',
      backendNamespace: 'alpha',
      bundleHash: 'bundle-a',
    });
    commitJobTerminal(store, 'job-done', 'session-done', {
      content: 'done',
      outcome: { kind: 'completed' },
      durationMs: 0,
    });

    initTestJob(store, {
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
  });

  it('rejects duplicate terminal events for the same job stream', () => {
    const { store } = createStore();
    const jobId = 'job-duplicate-terminal';
    const sessionId = 'session-duplicate-terminal';
    initProviderJob(store, jobId, sessionId);

    commitJobTerminal(store, jobId, sessionId, {
      content: 'done',
      outcome: { kind: 'completed' },
      durationMs: 0,
    });

    expectTerminalOrderViolation(
      () =>
        commitJobTerminal(store, jobId, sessionId, {
          content: 'again',
          outcome: { kind: 'completed' },
          durationMs: 0,
        }),
      jobId,
      'job.terminal.recorded',
    );
  });

  it('preserves terminal byte counts in projection details', () => {
    const { store } = createStore();
    const jobId = 'job-byte-counts';
    const sessionId = 'session-byte-counts';
    initProviderJob(store, jobId, sessionId);

    commitJobTerminal(
      store,
      jobId,
      sessionId,
      { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 },
      { diagnostics: { byteCounts: { stdout: 123, stderr: 45 } } },
    );

    expect(store.loadJobProjectionDetail(jobId).exit?.diagnostics.byteCounts).toEqual({ stdout: 123, stderr: 45 });
  });

  it('renders a crashed workflow root from its terminal instead of an empty placeholder', () => {
    const { runtime, store } = createStore();
    const workflowJobId = '44444444-4444-4444-8444-444444444444';
    const sessionId = 'session-crashed-workflow';

    initProviderJob(store, workflowJobId, sessionId);
    // Exactly what crash terminalization commits: no content, and a fault that describes itself.
    commitJobTerminal(store, workflowJobId, sessionId, {
      content: '',
      outcome: { kind: 'job_fault', fault: { kind: 'wrapper_crashed', cause: { message: 'Backend shutting down' } } },
      durationMs: 0,
    });

    const resultPath = store.ensureResultArtifact(workflowJobId);

    // Before, crash terminalization wrote '' here first. The file then existed, so this read returned it
    // unchanged and the operator was handed a path to nothing for a failure Coral could describe exactly.
    expect(runtime.storage.readFileSync(resultPath, 'utf-8')).toContain('Backend shutting down');
    expect(runtime.storage.readFileSync(resultPath, 'utf-8').trim().length).toBeGreaterThan(0);
  });

  it('rebuilds a pre-existing raw workflow child artifact with its durable slot identity', () => {
    const { runtime, store } = createStore();
    const childJobId = '11111111-1111-4111-8111-111111111111';
    const workflowJobId = '22222222-2222-4222-8222-222222222222';
    const replacedJobId = '33333333-3333-4333-8333-333333333333';
    const workflowSlotId = `${workflowJobId}:0:1`;
    const sessionId = 'session-workflow-child';

    initProviderJob(store, childJobId, sessionId);
    commitJobTerminal(store, childJobId, sessionId, {
      content: 'Critic result',
      outcome: { kind: 'completed' },
      durationMs: 0,
    });
    store
      .getDb()
      .prepare(
        `UPDATE projection_jobs
            SET execution_owner = ?,
                parent_workflow_job_id = ?,
                workflow_slot = ?,
                workflow_slot_generation = 1,
                replaces_workflow_job_id = ?
          WHERE job_id = ?`,
      )
      .run(
        JSON.stringify({ kind: 'workflow', id: workflowJobId }),
        workflowJobId,
        workflowSlotId,
        replacedJobId,
        childJobId,
      );
    writeResultArtifact(runtime.storage, runtime.paths.coral.exports.jobsRoot, childJobId, 'Critic result');

    const resultPath = store.ensureResultArtifact(childJobId);

    expect(runtime.storage.readFileSync(resultPath, 'utf-8')).toBe(
      `> Parent workflow: ${workflowJobId}\n` +
        `> Workflow slot: ${workflowSlotId}\n` +
        '> Workflow generation: 1\n' +
        `> Replaces workflow job: ${replacedJobId}\n\n` +
        'Critic result\n',
    );
  });

  it('rejects progress after a terminal event has been recorded', () => {
    const { store } = createStore();
    const jobId = 'job-late-progress';
    const sessionId = 'session-late-progress';
    initProviderJob(store, jobId, sessionId);

    commitJobTerminal(store, jobId, sessionId, {
      content: 'done',
      outcome: { kind: 'completed' },
      durationMs: 0,
    });

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
        durationMs: 0,
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
        body: { reason: 'user_abort' },
      },
    ]);

    expect(aborted?.type).toBe('job.aborted');
    expect(store.readStatus(jobId)?.phase).toBe('aborted');
    expect(
      commitJobTerminal(store, jobId, sessionId, {
        content: '',
        outcome: { kind: 'aborted', reason: 'user_abort' },
        durationMs: 0,
      }),
    ).toBeGreaterThan(aborted.seq);
  });
});
import { initTestJob } from '#tests/helpers/session.js';
