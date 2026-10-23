import { insertTestJobProjection } from '#tests/helpers/job-projection.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CoralStore } from '#src/read-model/coral-store.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { fixtureCanonicalWorkDir } from '../../helpers/canonical-work-dir.js';

const PROJECT_ROOT = fixtureCanonicalWorkDir('/workspace/coral');

function insertRunningJob(db: Database, jobId: string, namespace: string): void {
  insertTestJobProjection(db, { job_id: jobId, project_root: PROJECT_ROOT, backend_namespace: namespace });
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
