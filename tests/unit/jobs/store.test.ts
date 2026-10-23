import { JobLocationIndex } from '#src/jobs/location-index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it } from 'vitest';

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

function initProviderJob(store: JobStore, jobId: string): void {
  initTestJob(store, {
    jobId,
    conversation: testConversationFacet('codex'),
    projectRoot: `/workspace/${jobId}`,
    backendNamespace: 'test-ns',
  });
}

describe('JobStore', () => {
  it('renders a workflow child artifact with its durable slot identity', () => {
    const { runtime, store } = createStore();
    const childJobId = '11111111-1111-4111-8111-111111111111';
    const workflowJobId = '22222222-2222-4222-8222-222222222222';
    const workflowSlotId = `${workflowJobId}:0:1`;

    initProviderJob(store, childJobId);
    commitJobTerminal(store, childJobId, 1, {
      content: 'Critic result',
      outcome: { kind: 'completed' },
      durationMs: 0,
    });
    store
      .getDb()
      .prepare(
        `UPDATE projection_jobs
      SET execution_owner = ?, parent_workflow_job_id = ?, workflow_slot = ? WHERE job_id = ?`,
      )
      .run(JSON.stringify({ kind: 'workflow', id: workflowJobId }), workflowJobId, workflowSlotId, childJobId);
    store
      .getDb()
      .prepare("UPDATE events SET refs = ? WHERE stream_id = ? AND type = 'job.opened'")
      .run(JSON.stringify({ jobId: childJobId, parentJobId: workflowJobId, workflowSlotId }), childJobId);

    const resultPath = store.ensureResultArtifact(childJobId);

    expect(runtime.storage.readFileSync(resultPath, 'utf-8')).toBe(
      `> Parent workflow: ${workflowJobId}\n` + `> Workflow slot: ${workflowSlotId}\n\n` + 'Critic result\n',
    );
  });
});
import { testConversationFacet, initTestJob } from '#tests/helpers/session.js';

it('proves a registered but never accepted active job absent from the live journal', () => {
  const { runtime, store } = createStore();
  const index = new JobLocationIndex(
    runtime,
    runtime.paths.coral.generation.dataRoot,
    undefined,
    currentCoralStoreFormat().fingerprint,
  );
  index.register('9d8e0214-7c53-5f88-96d3-3b1bcd7d75f3', 'active:1', {
    projectRoot: '/workspace',
    workDir: null,
    jobKind: 'provider',
  });
  expect(store.observeJobAbsence('9d8e0214-7c53-5f88-96d3-3b1bcd7d75f3')).toBe(true);
  initProviderJob(store, '9c6d5b78-9d24-5ce6-ae32-85bd8838d4c2');
  expect(store.observeJobAbsence('9c6d5b78-9d24-5ce6-ae32-85bd8838d4c2')).toBe(false);
  store.getDb().prepare('DELETE FROM projection_jobs WHERE job_id = ?').run('9c6d5b78-9d24-5ce6-ae32-85bd8838d4c2');
  expect(store.observeJobAbsence('9c6d5b78-9d24-5ce6-ae32-85bd8838d4c2')).toBe(false);
});

it("reads a job's wait detail without its launch body, and the job's last seq moves only with its own events", () => {
  const { store } = createStore();
  initProviderJob(store, '8bff9514-7dae-562a-a87c-7118b32c7507');
  initProviderJob(store, 'e8b443db-d12b-5f1e-ad0d-e79b670954a2');
  const lastSeq = store.readJobLastSeq('8bff9514-7dae-562a-a87c-7118b32c7507');
  store.appendProgress('e8b443db-d12b-5f1e-ad0d-e79b670954a2', 'another job');
  expect(store.readJobLastSeq('8bff9514-7dae-562a-a87c-7118b32c7507')).toBe(lastSeq);
  store.appendProgress('8bff9514-7dae-562a-a87c-7118b32c7507', 'its own progress');
  expect(store.readJobLastSeq('8bff9514-7dae-562a-a87c-7118b32c7507')).toBeGreaterThan(lastSeq!);
  expect(store.readJobLastSeq('never-launched')).toBeNull();
  // A wait never needs the launch body, so an undecodable one cannot reach it.
  store
    .getDb()
    .prepare(
      "UPDATE events SET body = ? WHERE stream_id = '8bff9514-7dae-562a-a87c-7118b32c7507' AND type = 'job.execution.requested'",
    )
    .run(Buffer.from('{"execution":1,"undecodable":true}'));
  expect(() => store.loadJobProjectionDetail('8bff9514-7dae-562a-a87c-7118b32c7507')).toThrow();
  expect(store.loadJobWaitDetail('8bff9514-7dae-562a-a87c-7118b32c7507')).toMatchObject({
    status: { jobId: '8bff9514-7dae-562a-a87c-7118b32c7507' },
    exit: null,
  });
});
