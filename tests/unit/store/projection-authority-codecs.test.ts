import { currentCoralStoreFormat } from '#src/store-format.js';
import { describe, expect, it } from 'vitest';

import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { loadJobProjectionDetail, loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { readWorkflowProjection, readWorkflowView } from '#src/workflow/read-queries.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { readCorpusState } from '#src/kb/state/corpus-state.js';
import { reduceJobLaunchRequested } from '#src/jobs/projections.js';

describe('persisted projection authority codecs', () => {
  it.each([
    ['KB job with a work directory', 'kb', '/workspace'],
    ['provider job without a work directory', 'provider', null],
  ] as const)('rejects a %s on raw insert', (_label, jobKind, workDir) => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const insert = db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, diagnostics, project_root, work_dir,
           backend_namespace, job_kind, created_at, last_seq
         ) VALUES (?, '{}', 'running', '{"progressFaults":[]}', '/workspace', ?, 'tests', ?, ?, 1)`,
      );

      expect(() => insert.run(`invalid-${jobKind}`, workDir, jobKind, '2026-07-22T00:00:00.000Z')).toThrow(
        /projection_jobs_work_dir_authority/,
      );
      expect(db.prepare('SELECT COUNT(*) AS count FROM projection_jobs').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it.each([
    ['KB job with a work directory', 'kb', null, '/workspace'],
    ['provider job without a work directory', 'provider', '/workspace', null],
  ] as const)('rejects a %s on raw update and preserves the original row', (_label, jobKind, original, invalid) => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const jobId = `valid-${jobKind}`;
      db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, diagnostics, project_root, work_dir,
           backend_namespace, job_kind, created_at, last_seq
         ) VALUES (?, '{}', 'running', '{"progressFaults":[]}', '/workspace', ?, 'tests', ?, ?, 1)`,
      ).run(jobId, original, jobKind, '2026-07-22T00:00:00.000Z');

      expect(() => db.prepare('UPDATE projection_jobs SET work_dir = ? WHERE job_id = ?').run(invalid, jobId)).toThrow(
        /projection_jobs_work_dir_authority/,
      );
      expect(db.prepare('SELECT job_kind, work_dir FROM projection_jobs WHERE job_id = ?').get(jobId)).toEqual({
        job_kind: jobKind,
        work_dir: original,
      });
    } finally {
      db.close();
    }
  });

  it('rejects persisted workflow plans that omit current required fields', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      db.prepare(
        `INSERT INTO projection_workflows (workflow_id, plan, provider_scope, lifecycle, last_seq)
         VALUES (?, ?, ?, 'active', 1)`,
      ).run(
        'workflow-missing-dependencies',
        JSON.stringify({
          slots: [{ slotId: 'workflow-missing-dependencies:0:0', provider: 'codex', instruction: 'run' }],
        }),
        JSON.stringify(TEST_PROVIDER_SCOPE),
      );

      expect(() => readWorkflowProjection(db, 'workflow-missing-dependencies')).toThrow();
    } finally {
      db.close();
    }
  });

  it.each([
    ['phase', 'not-a-phase'],
    ['job_kind', 'not-a-kind'],
    ['work_dir', 'relative/workspace'],
  ] as const)('rejects corrupted projection_jobs.%s on singular and bulk reads', (column, value) => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
           project_root, work_dir, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
           workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
         ) VALUES (?, ?, 'running', NULL, '{"progressFaults":[]}', ?, 'codex', ?, ?, 'tests', NULL, 'provider',
                   NULL, NULL, NULL, NULL, ?, 1)`,
      ).run(
        'corrupted-scalar-job',
        JSON.stringify({ kind: 'provider-session', id: 'provider-session-1' }),
        'provider-session-1',
        '/workspace',
        '/workspace',
        '2026-07-22T00:00:00.000Z',
      );
      db.prepare(`UPDATE projection_jobs SET ${column} = ? WHERE job_id = ?`).run(value, 'corrupted-scalar-job');
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      const readCtx = {
        schemas: reducers.schemas,
        streamKinds: reducers.streamKinds,
        bodyCodec: createEventBodyCodec(),
      };

      expect(() => loadJobProjectionDetail(db, 'corrupted-scalar-job', readCtx)).toThrow();
      expect(() => loadJobProjectionDetails(db, ['corrupted-scalar-job'], readCtx)).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects corrupted child job phases from workflow views', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const workflowId = 'workflow-corrupted-child';
      const slotId = `${workflowId}:0:0`;
      db.prepare(
        `INSERT INTO projection_workflows (workflow_id, plan, provider_scope, lifecycle, last_seq)
         VALUES (?, ?, ?, 'active', 1)`,
      ).run(
        workflowId,
        JSON.stringify({ slots: [{ slotId, dependencies: [], provider: 'codex', instruction: 'run' }] }),
        JSON.stringify(TEST_PROVIDER_SCOPE),
      );
      db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
           project_root, work_dir, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
           workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
         ) VALUES (?, ?, ?, NULL, '{"progressFaults":[]}', ?, 'codex', ?, ?, 'tests', NULL, 'provider',
                   ?, ?, 0, NULL, ?, 2)`,
      ).run(
        'corrupted-child-job',
        JSON.stringify({ kind: 'workflow', id: workflowId }),
        'not-a-phase',
        'session-corrupted-child',
        '/workspace',
        '/workspace',
        workflowId,
        slotId,
        '2026-07-22T00:00:00.000Z',
      );
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);

      expect(() =>
        readWorkflowView(db, workflowId, {
          schemas: reducers.schemas,
          streamKinds: reducers.streamKinds,
          bodyCodec: createEventBodyCodec(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects internally inconsistent kb_corpus_state rows instead of default-filling them', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      db.prepare(
        `UPDATE kb_corpus_state
            SET snapshot_id = 'snapshot-corrupt', content_seq = 1, metadata_seq = 1,
                content_manifest_hash = NULL, metadata_manifest_hash = NULL
          WHERE id = 1`,
      ).run();

      expect(() => readCorpusState(db)).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects a missing kb_corpus_state singleton instead of recreating it during a read', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      db.prepare('DELETE FROM kb_corpus_state WHERE id = 1').run();

      expect(() => readCorpusState(db)).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM kb_corpus_state').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('validates the complete projection_jobs row before a reducer writes it', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());

      expect(() =>
        reduceJobLaunchRequested(db, {
          seq: 1,
          ts: '2026-07-22T00:00:00.000Z',
          type: 'job.launch.requested',
          stream: { kind: 'job', id: 'invalid-created-at' },
          namespace: 'tests',
          project: '/workspace',
          refs: { sessionId: 'session-1' },
          body: {
            owner: { kind: 'provider-session', id: 'session-1' },
            sessionId: 'session-1',
            provider: 'codex',
            providerAction: 'exec',
            projectRoot: fixtureCanonicalWorkDir('/workspace'),
            backendNamespace: 'tests',
            jobKind: 'provider',
            pool: 'default',
            enqueueSequence: 1,
            request: {
              prompt: 'run',
              cwd: fixtureCanonicalWorkDir('/workspace'),
              bypassPermissions: false,
              coralEnv: {},
            },
            createdAt: 'not-an-iso-timestamp',
          },
        }),
      ).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM projection_jobs').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects a launch projection whose derived work directory is absent before writing', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());

      expect(() =>
        reduceJobLaunchRequested(db, {
          seq: 1,
          ts: '2026-07-22T00:00:00.000Z',
          type: 'job.launch.requested',
          stream: { kind: 'job', id: 'missing-work-dir' },
          namespace: 'tests',
          project: '/workspace',
          refs: { sessionId: 'session-1' },
          body: {
            owner: { kind: 'provider-session', id: 'session-1' },
            sessionId: 'session-1',
            provider: 'codex',
            providerAction: 'exec',
            projectRoot: '/workspace',
            backendNamespace: 'tests',
            jobKind: 'provider',
            pool: 'default',
            enqueueSequence: 1,
            request: {
              prompt: 'run',
              cwd: undefined as never,
              bypassPermissions: false,
              coralEnv: {},
            },
            createdAt: '2026-07-22T00:00:00.000Z',
          },
        }),
      ).toThrowError(expect.objectContaining({ code: 'projection_jobs_premature_event' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM projection_jobs').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
