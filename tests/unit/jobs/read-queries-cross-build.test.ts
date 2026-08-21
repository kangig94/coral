import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listJobs, loadJobDetail } from '#src/jobs/read-queries.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const PROJECT_ROOT = '/workspace/coral';

function insertRunningJob(db: Database, jobId: string, namespace: string): void {
  db.prepare(
    `INSERT INTO projection_jobs (
       job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
       project_root, work_dir, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
       workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
     ) VALUES (?, ?, 'running', NULL, ?, ?, 'codex', ?, ?, ?, NULL, 'provider', NULL, NULL, NULL, NULL, ?, 0)`,
  ).run(
    jobId,
    JSON.stringify({ kind: 'provider-session', id: `session-${jobId}` }),
    JSON.stringify({ progressFaults: [] }),
    `session-${jobId}`,
    PROJECT_ROOT,
    PROJECT_ROOT,
    namespace,
    '2026-08-05T00:00:00.000Z',
  );
}

describe('jobs/read-queries', () => {
  let db: Database;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    insertRunningJob(db, 'job-current-build', 'current-build');
    insertRunningJob(db, 'job-inherited-build', 'previous-build');
  });

  afterEach(() => {
    db.close();
  });

  it('should list and load jobs inherited from another build namespace', () => {
    const readContext = createDefaultStoreReadContext();

    expect(listJobs(db, { projectRoot: PROJECT_ROOT }, readContext).map(({ jobId }) => jobId)).toEqual([
      'job-current-build',
      'job-inherited-build',
    ]);
    expect(loadJobDetail(db, 'job-inherited-build', readContext)?.status).toMatchObject({
      jobId: 'job-inherited-build',
      backendNamespace: 'previous-build',
      projectRoot: PROJECT_ROOT,
    });
  });
});
