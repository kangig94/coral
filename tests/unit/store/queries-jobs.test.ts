import { describe, expect, it } from 'vitest';

import { jobsRegistry } from '#src/jobs/events.js';
import { listJobs } from '#src/jobs/read-queries.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

describe('jobs queries', () => {
  it('rejects a corrupt projection row outside the requested project and phase', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, diagnostics, session_id, provider,
           project_root, work_dir, backend_namespace, job_kind, created_at, last_seq
         ) VALUES (?, ?, 'running', '{"progressFaults":[]}', ?, 'codex',
                   ?, ?, 'tests', 'provider', ?, 1)`,
      ).run(
        'job-other-project',
        JSON.stringify({ kind: 'provider-session', id: 'session-other-project' }),
        'session-other-project',
        '/workspace/other-project',
        '/workspace/other-project',
        '2026-04-20T00:00:00.000Z',
      );
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
        'job-other-project',
      );

      expect(() => listJobs(db, filters, readCtx)).toThrow();
    } finally {
      db.close();
    }
  });
});
