import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CoralStore } from '#src/read-model/coral-store.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const PROJECT_ROOT = '/workspace/coral';

function insertRunningJob(db: Database, jobId: string, namespace: string): void {
  db.prepare(
    `INSERT INTO projection_jobs (
       job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
       project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, 'running', NULL, ?, ?, 'codex', ?, ?, NULL, 'provider', NULL, NULL, NULL, NULL, ?, 0)`,
  ).run(
    jobId,
    JSON.stringify({ kind: 'provider-session', id: `session-${jobId}` }),
    JSON.stringify({ progressFaults: [] }),
    `session-${jobId}`,
    PROJECT_ROOT,
    namespace,
    '2026-08-05T00:00:00.000Z',
  );
}

describe('read-model/coral-store', () => {
  let db: Database;
  let store: CoralStore;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    insertRunningJob(db, 'job-current-build', 'current-build');
    insertRunningJob(db, 'job-inherited-build', 'previous-build');
    store = new CoralStore(db, createDefaultStoreReadContext(), { projectRoot: PROJECT_ROOT });
  });

  afterEach(() => {
    db.close();
  });

  it('should expose inherited jobs through list and detail reads', () => {
    expect(store.jobs.list({ projectRoot: PROJECT_ROOT }).map(({ jobId }) => jobId)).toEqual([
      'job-current-build',
      'job-inherited-build',
    ]);
    expect(store.jobs.detail('job-inherited-build')?.status).toMatchObject({
      jobId: 'job-inherited-build',
      backendNamespace: 'previous-build',
      projectRoot: PROJECT_ROOT,
    });
  });
});
