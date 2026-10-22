import { describe, expect, it } from 'vitest';

import { jobsRegistry } from '#src/jobs/events.js';
import { listJobs } from '#src/jobs/read-queries.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

describe('jobs queries', () => {
  it('rejects a corrupt projection row outside the requested project and phase', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      seedTestSessionProjection(db, {
        jobId: '10000000-0000-4000-8000-000000000001',
        provider: 'codex',
        projectRoot: '/workspace/other-project',
      });
      const reducers = composeReducers(jobsRegistry);
      const readCtx = {
        schemas: reducers.schemas,
        streamKinds: reducers.streamKinds,
        bodyCodec: createEventBodyCodec(),
      };
      const filters = {
        projectRoot: fixtureCanonicalWorkDir('/workspace/coral'),
        phase: 'queued' as const,
      };
      expect(listJobs(db, filters, readCtx)).toEqual([]);

      db.prepare('UPDATE projection_jobs SET diagnostics = ? WHERE job_id = ?').run(
        'invalid-json',
        '10000000-0000-4000-8000-000000000001',
      );

      expect(() => listJobs(db, filters, readCtx)).toThrow();
    } finally {
      db.close();
    }
  });
});
