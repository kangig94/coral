import { describe, expect, it } from 'vitest';

import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { loadJobProjectionDetail, loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { listWorkflowProjections, readWorkflowProjection } from '#src/workflow/read-queries.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

describe('persisted projection authority codecs', () => {
  it('rejects corrupted projection_jobs.execution_owner on singular and bulk reads', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db);
      db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
           project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
           workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
         ) VALUES (?, ?, 'running', NULL, NULL, ?, 'codex', ?, 'tests', NULL, 'provider',
                   NULL, NULL, NULL, NULL, ?, 1)`,
      ).run(
        'corrupted-owner-job',
        JSON.stringify({ kind: 'provider-session', id: '', extra: true }),
        'provider-session-1',
        '/workspace',
        '2026-07-22T00:00:00.000Z',
      );
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      const readCtx = { schemas: reducers.schemas, bodyCodec: createEventBodyCodec() };

      expect(() => loadJobProjectionDetail(db, 'corrupted-owner-job', readCtx)).toThrow();
      expect(() => loadJobProjectionDetails(db, ['corrupted-owner-job'], readCtx)).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects corrupted projection_workflows.provider_scope on singular and list reads', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db);
      db.prepare(
        `INSERT INTO projection_workflows (workflow_id, plan, provider_scope, lifecycle, last_seq)
         VALUES (?, ?, ?, 'active', 1)`,
      ).run(
        'corrupted-provider-scope',
        JSON.stringify({ slots: [] }),
        JSON.stringify({ origin: 'caller', profiles: [], unexpected: true }),
      );

      expect(() => readWorkflowProjection(db, 'corrupted-provider-scope')).toThrow();
      expect(() => listWorkflowProjections(db)).toThrow();
    } finally {
      db.close();
    }
  });
});
