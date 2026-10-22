import { executionHarness, openedJob, requestedExecution, EXECUTION_JOB_ID } from '#tests/helpers/job-executions.js';
import { hydrateJobProjectionDetailFromEvents, loadJobProjectionDetail } from '#src/jobs/read-queries.js';
import { decodeProjectionJobStoredRow } from '#src/jobs/projection-row.js';
import type { EventsRow } from '#src/store/schema.js';
import { JobEvidenceDecodeError } from '#src/jobs/source-read.js';
import { insertTestJobProjection } from '#tests/helpers/job-projection.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listJobs, loadJobDetail } from '#src/jobs/read-queries.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { fixtureCanonicalWorkDir } from '../../helpers/canonical-work-dir.js';

const PROJECT_ROOT = fixtureCanonicalWorkDir('/workspace/coral');

function insertRunningJob(db: Database, jobId: string, namespace: string): void {
  insertTestJobProjection(db, { job_id: jobId, project_root: PROJECT_ROOT, backend_namespace: namespace });
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

it.each(['cause', 'stream'] as const)('classifies contradictory terminal %s as job evidence corruption', (field) => {
  const h = executionHarness();
  try {
    h.append(openedJob(), requestedExecution());
    h.complete();
    const row = h.db
      .prepare<[], { body: Uint8Array }>("SELECT body FROM events WHERE type = 'job.execution.ended'")
      .get()!;
    const body = JSON.parse(Buffer.from(row.body).toString());
    if (field === 'cause') body.causeRef.seq = 1;
    else body.causeRef.stream.id = 'another-job';
    h.db
      .prepare("UPDATE events SET body = ? WHERE type = 'job.execution.ended'")
      .run(Buffer.from(JSON.stringify(body)));
    expect(() => loadJobProjectionDetail(h.db, EXECUTION_JOB_ID, h.readCtx)).toThrow(JobEvidenceDecodeError);
  } finally {
    h.db.close();
  }
});

it.each(['kb', 'provider'] as const)('classifies mismatched %s execution input as job evidence corruption', (kind) => {
  const h = executionHarness();
  try {
    h.append(openedJob(), requestedExecution());
    if (kind === 'kb') {
      const job = openedJob().body;
      if (job.jobKind !== 'provider') throw new Error('Expected a provider fixture.');
      const { conversation: _conversation, ...opened } = job;
      h.db
        .prepare("UPDATE events SET body = ? WHERE type = 'job.opened'")
        .run(Buffer.from(JSON.stringify({ ...opened, jobKind: 'kb' })));
    } else {
      h.db
        .prepare("UPDATE events SET body = ? WHERE type = 'job.execution.requested'")
        .run(
          Buffer.from(
            JSON.stringify({ ...requestedExecution().body, input: { operation: 'kb.reindex', request: {} } }),
          ),
        );
    }

    expect(() => loadJobProjectionDetail(h.db, EXECUTION_JOB_ID, h.readCtx)).toThrow(JobEvidenceDecodeError);
  } finally {
    h.db.close();
  }
});

it('classifies another job stream in retained execution evidence as job evidence corruption', () => {
  const h = executionHarness();
  try {
    h.append(openedJob(), requestedExecution());
    const projection = decodeProjectionJobStoredRow(h.db.prepare('SELECT * FROM projection_jobs').get());
    const rows = h.db.prepare<[], EventsRow>('SELECT * FROM events ORDER BY seq').all();
    expect(() =>
      hydrateJobProjectionDetailFromEvents(
        projection,
        [{ ...rows[0], stream_id: 'another-job' }, ...rows.slice(1)],
        h.readCtx,
      ),
    ).toThrow(JobEvidenceDecodeError);
  } finally {
    h.db.close();
  }
});
