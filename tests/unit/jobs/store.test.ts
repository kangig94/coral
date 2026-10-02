import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';

import { JobStore } from '#src/jobs/store.js';
import { writeResultArtifact } from '#src/jobs/terminal/export.js';

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
});
import { initTestJob } from '#tests/helpers/session.js';
