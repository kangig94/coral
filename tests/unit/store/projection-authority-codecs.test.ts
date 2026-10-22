import { currentCoralStoreFormat } from '#src/store-format.js';
import { describe, expect, it } from 'vitest';

import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { loadJobProjectionDetail, loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { readWorkflowProjection, readWorkflowView } from '#src/workflow/read-queries.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { seedTestSessionProjection, testConversationFacet } from '#tests/helpers/session.js';
import { readCorpusState } from '#src/kb/state/corpus-state.js';
import { reduceJobOpened } from '#src/jobs/projections.js';

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
           job_id, execution_owner, phase, diagnostics, finishing, project_root, work_dir,
           backend_namespace, job_kind, created_at, last_seq
         ) VALUES (?, '{}', 'running', '{"progressFaults":[]}', 0, '/workspace', ?, 'tests', ?, ?, 1)`,
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
           job_id, execution_owner, phase, diagnostics, finishing, project_root, work_dir,
           backend_namespace, job_kind, created_at, last_seq
         ) VALUES (?, '{}', 'running', '{"progressFaults":[]}', 0, '/workspace', ?, 'tests', ?, ?, 1)`,
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
      seedTestSessionProjection(db, {
        jobId: '10000000-0000-4000-8000-000000000001',
        provider: 'codex',
        projectRoot: '/workspace',
      });
      db.prepare(`UPDATE projection_jobs SET ${column} = ? WHERE job_id = ?`).run(
        value,
        '10000000-0000-4000-8000-000000000001',
      );
      const reducers = composeReducers(jobsRegistry, discussRegistry, workflowRegistry);
      const readCtx = {
        schemas: reducers.schemas,
        streamKinds: reducers.streamKinds,
        bodyCodec: createEventBodyCodec(),
      };

      expect(() => loadJobProjectionDetail(db, '10000000-0000-4000-8000-000000000001', readCtx)).toThrow();
      expect(() => loadJobProjectionDetails(db, ['10000000-0000-4000-8000-000000000001'], readCtx)).toThrow();
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
      reduceJobOpened(db, {
        seq: 2,
        ts: '2026-07-22T00:00:00.000Z',
        type: 'job.opened',
        stream: { kind: 'job', id: 'corrupted-child-job' },
        namespace: 'tests',
        project: '/workspace',
        refs: { jobId: 'corrupted-child-job', workflowId },
        body: {
          owner: { kind: 'workflow', id: workflowId },
          jobKind: 'provider',
          conversation: testConversationFacet('codex', '/workspace'),
          workflowSlotId: slotId,
          projectRoot: '/workspace',
          createdAt: '2026-07-22T00:00:00.000Z',
        },
      });
      db.prepare('UPDATE projection_jobs SET phase = ? WHERE job_id = ?').run('not-a-phase', 'corrupted-child-job');
      const reducers = composeReducers(jobsRegistry, discussRegistry, workflowRegistry);

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
        reduceJobOpened(db, {
          seq: 1,
          ts: '2026-07-22T00:00:00.000Z',
          type: 'job.opened',
          stream: { kind: 'job', id: 'invalid-created-at' },
          namespace: 'tests',
          project: '/workspace',
          refs: { jobId: 'invalid-created-at' },
          body: {
            owner: { kind: 'provider-session', id: 'invalid-created-at' },
            projectRoot: fixtureCanonicalWorkDir('/workspace'),
            jobKind: 'provider',
            conversation: testConversationFacet('codex', '/workspace'),
            createdAt: 'not-an-iso-timestamp',
          },
        }),
      ).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM projection_jobs').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects a conversation projection whose work directory is absent before writing', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const conversation = testConversationFacet('codex', '/workspace');
      Reflect.deleteProperty(conversation, 'cwd');

      expect(() =>
        reduceJobOpened(db, {
          seq: 1,
          ts: '2026-07-22T00:00:00.000Z',
          type: 'job.opened',
          stream: { kind: 'job', id: 'missing-work-dir' },
          namespace: 'tests',
          project: '/workspace',
          refs: { jobId: 'missing-work-dir' },
          body: {
            owner: { kind: 'provider-session', id: 'missing-work-dir' },
            projectRoot: '/workspace',
            jobKind: 'provider',
            conversation,
            createdAt: '2026-07-22T00:00:00.000Z',
          },
        }),
      ).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ path: ['cwd'] })]),
        }),
      );
      expect(db.prepare('SELECT COUNT(*) AS count FROM projection_jobs').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
