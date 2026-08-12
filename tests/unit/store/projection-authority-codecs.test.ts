import { currentCoralStoreFormat } from '#src/store-format.js';
import { describe, expect, it } from 'vitest';

import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { loadJobProjectionDetail, loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { listProjectionSessionEntries, readProjectionSession } from '#src/sessions/projections.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { listWorkflowProjections, readWorkflowProjection, readWorkflowView } from '#src/workflow/read-queries.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { readCorpusState } from '#src/kb/state/corpus-state.js';
import { reduceJobLaunchRequested } from '#src/jobs/projections.js';
import { decodeProjectionJobStoredRow } from '#src/jobs/projection-row.js';

const validProjectionJobRow = {
  job_id: 'provider-job',
  execution_owner: JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
  phase: 'running',
  terminal: null,
  diagnostics: JSON.stringify({ progressFaults: [] }),
  session_id: 'session-1',
  provider: 'codex',
  project_root: '/workspace',
  backend_namespace: 'tests',
  bundle_hash: null,
  job_kind: 'provider',
  parent_workflow_job_id: null,
  workflow_slot: null,
  workflow_slot_generation: null,
  replaces_workflow_job_id: null,
  created_at: '2026-07-22T00:00:00.000Z',
  last_seq: 1,
} as const;

describe('persisted projection authority codecs', () => {
  it.each([
    ['live terminal', { terminal: JSON.stringify({ content: '', outcome: { kind: 'completed' }, durationMs: 0 }) }],
    ['parent without slot', { parent_workflow_job_id: 'workflow-1' }],
    ['slot without generation', { parent_workflow_job_id: 'workflow-1', workflow_slot: 'workflow-1:0:0' }],
    [
      'generation zero replacement',
      {
        parent_workflow_job_id: 'workflow-1',
        workflow_slot: 'workflow-1:0:0',
        workflow_slot_generation: 0,
        replaces_workflow_job_id: 'provider-job-old',
      },
    ],
    [
      'later generation without replacement',
      {
        parent_workflow_job_id: 'workflow-1',
        workflow_slot: 'workflow-1:0:0',
        workflow_slot_generation: 1,
      },
    ],
    ['missing provider session', { session_id: null }],
    ['missing provider identity', { provider: null }],
  ] as const)('rejects a projection job with %s', (_label, patch) => {
    expect(() => decodeProjectionJobStoredRow({ ...validProjectionJobRow, ...patch })).toThrow();
  });

  it.each([
    [
      'workflow root owned by another workflow',
      {
        job_id: 'workflow-1',
        execution_owner: JSON.stringify({ kind: 'workflow', id: 'workflow-other' }),
        job_kind: 'workflow',
        session_id: null,
        provider: null,
      },
    ],
    [
      'workflow root owned by a provider session',
      {
        job_id: 'workflow-1',
        execution_owner: JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
        job_kind: 'workflow',
        session_id: null,
        provider: null,
      },
    ],
    [
      'KB job owned by a workflow',
      {
        job_id: 'kb-1',
        execution_owner: JSON.stringify({ kind: 'workflow', id: 'kb-1' }),
        job_kind: 'kb',
        session_id: null,
        provider: null,
      },
    ],
    [
      'workflow child owned by its provider session',
      {
        execution_owner: JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
        parent_workflow_job_id: 'workflow-1',
        workflow_slot: 'workflow-1:0:0',
        workflow_slot_generation: 0,
      },
    ],
    [
      'standalone provider job owned by a workflow',
      { execution_owner: JSON.stringify({ kind: 'workflow', id: 'workflow-1' }) },
    ],
  ] as const)('rejects a %s', (_label, patch) => {
    expect(() => decodeProjectionJobStoredRow({ ...validProjectionJobRow, ...patch })).toThrow();
  });

  it('rejects corrupted projection_jobs.execution_owner on singular and bulk reads', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
           project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
           workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
         ) VALUES (?, ?, 'running', NULL, '{"progressFaults":[]}', ?, 'codex', ?, 'tests', NULL, 'provider',
                   NULL, NULL, NULL, NULL, ?, 1)`,
      ).run(
        'corrupted-owner-job',
        JSON.stringify({ kind: 'provider-session', id: '', extra: true }),
        'provider-session-1',
        '/workspace',
        '2026-07-22T00:00:00.000Z',
      );
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      const readCtx = {
        schemas: reducers.schemas,
        streamKinds: reducers.streamKinds,
        bodyCodec: createEventBodyCodec(),
      };

      expect(() => loadJobProjectionDetail(db, 'corrupted-owner-job', readCtx)).toThrow();
      expect(() => loadJobProjectionDetails(db, ['corrupted-owner-job'], readCtx)).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects corrupted projection_workflows.provider_scope on singular and list reads', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
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
  ] as const)('rejects corrupted projection_jobs.%s on singular and bulk reads', (column, value) => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      db.prepare(
        `INSERT INTO projection_jobs (
           job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
           project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
           workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
         ) VALUES (?, ?, 'running', NULL, '{"progressFaults":[]}', ?, 'codex', ?, 'tests', NULL, 'provider',
                   NULL, NULL, NULL, NULL, ?, 1)`,
      ).run(
        'corrupted-scalar-job',
        JSON.stringify({ kind: 'provider-session', id: 'provider-session-1' }),
        'provider-session-1',
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
           project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
           workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
         ) VALUES (?, ?, ?, NULL, '{"progressFaults":[]}', ?, 'codex', ?, 'tests', NULL, 'provider',
                   ?, ?, 0, NULL, ?, 2)`,
      ).run(
        'corrupted-child-job',
        JSON.stringify({ kind: 'workflow', id: workflowId }),
        'not-a-phase',
        'session-corrupted-child',
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

  it('rejects malformed terminal JSON before workflow child selection', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const workflowId = 'workflow-corrupted-terminal';
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
           project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
           workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
         ) VALUES (?, ?, 'completed', '{}', '{"progressFaults":[]}', ?, 'codex', ?, 'tests', NULL, 'provider',
                   ?, ?, 0, NULL, ?, 2)`,
      ).run(
        'corrupted-terminal-job',
        JSON.stringify({ kind: 'workflow', id: workflowId }),
        'session-1',
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

  it('rejects malformed session scalar rows even when a scope filter would hide them', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const entry = seedTestSessionProjection(db, {
        sessionId: 'corrupted-session-row',
        provider: 'codex',
        projectRoot: '/workspace',
      });
      db.prepare('UPDATE projection_sessions SET resumable = 2 WHERE session_id = ?').run(entry.sessionId);

      expect(() => readProjectionSession(db, entry.sessionId)).toThrow();
      expect(() => listProjectionSessionEntries(db, undefined, 'different-scope')).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects denormalized session columns that disagree with the persisted entry', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const entry = seedTestSessionProjection(db, {
        sessionId: 'inconsistent-session-row',
        provider: 'codex',
        projectRoot: '/workspace',
      });
      db.prepare("UPDATE projection_sessions SET controller = 'different-controller' WHERE session_id = ?").run(
        entry.sessionId,
      );

      expect(() => readProjectionSession(db, entry.sessionId)).toThrowError(
        expect.objectContaining({ code: 'projection_sessions_invalid_entry' }),
      );
      expect(() => listProjectionSessionEntries(db)).toThrowError(
        expect.objectContaining({ code: 'projection_sessions_invalid_entry' }),
      );
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
});
