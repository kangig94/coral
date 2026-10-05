import { JobLocationIndex } from '#src/jobs/location-index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';

import { JobStore } from '#src/jobs/store.js';

import { commitJobTerminal } from '#tests/helpers/job-commits.js';
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

function initProviderJob(store: JobStore, jobId: string, sessionId: string): void {
  initTestJob(store, {
    jobId,
    sessionId,
    provider: 'codex',
    projectRoot: `/workspace/${jobId}`,
    backendNamespace: 'test-ns',
  });
}

describe('JobStore', () => {
  it('renders a workflow child artifact with its durable slot identity', () => {
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

    const launch = store
      .getDb()
      .prepare<
        [string],
        { body: Uint8Array }
      >("SELECT body FROM events WHERE stream_id = ? AND type = 'job.launch.requested'")
      .get(childJobId);
    if (!launch) throw new Error('missing launch');
    store
      .getDb()
      .prepare("UPDATE events SET refs = ?, body = ? WHERE stream_id = ? AND type = 'job.launch.requested'")
      .run(
        JSON.stringify({ jobId: childJobId, parentJobId: workflowJobId, workflowSlotId }),
        Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(launch.body).toString('utf8')),
            workflowSlotGeneration: 1,
            replacesWorkflowJobId: replacedJobId,
          }),
        ),
        childJobId,
      );

    const resultPath = store.ensureResultArtifact(childJobId);

    expect(runtime.storage.readFileSync(resultPath, 'utf-8')).toBe(
      `> Parent workflow: ${workflowJobId}\n` +
        `> Workflow slot: ${workflowSlotId}\n` +
        '> Workflow generation: 1\n' +
        `> Replaces workflow job: ${replacedJobId}\n\n` +
        'Critic result\n',
    );
  });
});
import { initTestJob } from '#tests/helpers/session.js';

it('retains the export owner, pending hints and listener when recovery reuses the same index', () => {
  const { store, runtime } = createStore();
  const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  store.configureResultExports(index);
  const owner = store.getResultExportOwner();
  const listener = vi.fn();
  owner.onRepairHint(listener);
  owner.hintRepair('first');
  store.configureResultExports(index);
  expect(store.getResultExportOwner()).toBe(owner);
  store.getResultExportOwner().hintRepair('first');
  expect(listener).toHaveBeenCalledTimes(1);
  store.getResultExportOwner().hintRepair('second');
  expect(listener).toHaveBeenCalledTimes(2);
});

it('epoch-less terminal availability bounds age evidence and reads only the terminal', () => {
  const { store } = createStore();
  for (let i = 0; i < 1025; i++) {
    const id = `local-${i}`;
    initProviderJob(store, id, id);
    commitJobTerminal(store, id, id, { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 });
    store.getResultExportOwner().observeResultAvailability(id);
  }
  const read = vi.spyOn(store, 'readJobEvents');
  store.getResultExportOwner().observeResultAvailability('local-1024');
  expect(read.mock.calls.every(([, terminalOnly]) => terminalOnly === true)).toBe(true);
  expect((store as unknown as { localTerminalAges: Map<string, unknown> }).localTerminalAges.size).toBeLessThanOrEqual(
    1024,
  );
});

it('proves a registered but never accepted active job absent from the live journal', () => {
  const { runtime, store } = createStore();
  const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  index.register('never-accepted', 'active:1', { projectRoot: '/workspace', workDir: null, jobKind: 'provider' });
  expect(store.observeJobAbsence('never-accepted')).toBe(true);
  initProviderJob(store, 'accepted', 'session');
  expect(store.observeJobAbsence('accepted')).toBe(false);
  store.getDb().prepare('DELETE FROM projection_jobs WHERE job_id = ?').run('accepted');
  expect(store.observeJobAbsence('accepted')).toBe(false);
});
