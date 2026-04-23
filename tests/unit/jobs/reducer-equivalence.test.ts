import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { appendEvents } from '#src/store/append.js';
import { applyMigrations } from '#src/store/migrations.js';
import { composeReducers } from '#src/store/reducers.js';
import { rebuildProjections } from '#src/store/rebuild.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcasters.js';
import { jobsRegistry } from '#src/jobs/events.js';

const MIGRATIONS_DIR = join(process.cwd(), 'src/store/migrations');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-19T00:00:00.000Z');

describe('jobs reducer equivalence (AC1)', () => {
  it('rebuilds projection_jobs rows byte-identically from a historical event sequence', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
      const reducers = composeReducers(jobsRegistry);
      const upcasters = createDefaultUpcasterRegistry();

      const appended = appendEvents(
        db,
        [
          {
            type: 'job.launch.requested',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1', parentJobId: 'job-parent', workflowSlotId: 'workflow-slot-1' },
            bodyVersion: 1,
            body: {
              sessionId: 'session-1',
              provider: 'codex',
              providerAction: 'exec',
              projectRoot: '/workspace/coral',
              backendNamespace: 'namespace-1',
              bundleHash: 'bundle-1',
              jobKind: 'provider',
              pool: 'default',
              enqueueSequence: 4,
              request: {
                prompt: 'hello',
                cwd: '/workspace/coral',
                bypassPermissions: false,
                coralEnv: {},
              },
              parentJobId: 'job-parent',
              workflowSlot: 'workflow-slot-1',
              createdAt: NOW.toISOString(),
            },
          },
          {
            type: 'job.queue.queued',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: { queuePosition: 2, runningJobIds: ['job-live'] },
          },
          {
            type: 'job.queue.admitted',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: { queuePosition: 0 },
          },
          {
            type: 'job.runtime.started',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: { transport: 'durable-cli', pid: 4242, startedAt: NOW.toISOString() },
          },
          {
            type: 'job.progress.emitted',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: { kind: 'recovery_parse_failed', cause: { message: 'partial stderr' } },
          },
          {
            type: 'job.terminal.recorded',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              outcome: { kind: 'provider_exit', code: 17, note: 'forced timeout' },
              durationMs: 3210,
              content: 'partial output',
              exitCode: 17,
              note: 'forced timeout',
            },
          },
        ],
        { now: () => NOW, reducers, upcasters },
      );

      const before = db
        .prepare(
          `SELECT job_id, phase, terminal, diagnostics,
                session_id, provider, project_root, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
        )
        .get('job-1');

      expect(before).toEqual({
        job_id: 'job-1',
        phase: 'error',
        terminal: JSON.stringify({
          content: 'partial output',
          outcome: { kind: 'provider_exit', code: 17, note: 'forced timeout' },
          durationMs: 3210,
        }),
        diagnostics: JSON.stringify({
          progressFaults: [{ kind: 'recovery_parse_failed', cause: { message: 'partial stderr' } }],
        }),
        session_id: 'session-1',
        provider: 'codex',
        project_root: '/workspace/coral',
        backend_namespace: 'namespace-1',
        bundle_hash: 'bundle-1',
        job_kind: 'provider',
        created_at: NOW.toISOString(),
        parent_workflow_job_id: 'job-parent',
        workflow_slot: 'workflow-slot-1',
        last_seq: appended.at(-1)?.seq,
      });

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        upcasters,
      });

      const after = db
        .prepare(
          `SELECT job_id, phase, terminal, diagnostics,
                session_id, provider, project_root, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
        )
        .get('job-1');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });

  it('job.launch.rejected byte-identical after rebuild', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
      const reducers = composeReducers(jobsRegistry);
      const upcasters = createDefaultUpcasterRegistry();

      const appended = appendEvents(
        db,
        [
          {
            type: 'job.launch.requested',
            stream: { kind: 'job', id: 'job-rejected' },
            refs: { sessionId: 'session-rejected' },
            bodyVersion: 1,
            body: {
              sessionId: 'session-rejected',
              provider: 'codex',
              providerAction: 'exec',
              projectRoot: '/workspace/coral',
              backendNamespace: 'namespace-1',
              jobKind: 'workflow',
              pool: 'default',
              enqueueSequence: 1,
              request: {
                prompt: 'hello',
                cwd: '/workspace/coral',
                bypassPermissions: false,
                coralEnv: {},
              },
              createdAt: NOW.toISOString(),
            },
          },
          {
            type: 'job.launch.rejected',
            stream: { kind: 'job', id: 'job-rejected' },
            refs: { sessionId: 'session-rejected' },
            bodyVersion: 1,
            body: {
              reason: 'busy',
              message: 'Provider queue is full.',
              provider: 'codex',
              globalActive: 7,
              globalLimit: 10,
            },
          },
        ],
        { now: () => NOW, reducers, upcasters },
      );

      const before = db
        .prepare(
          `SELECT job_id, phase, terminal, diagnostics,
                session_id, provider, project_root, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
        )
        .get('job-rejected');

      expect(before).toEqual({
        job_id: 'job-rejected',
        phase: 'error',
        terminal: null,
        diagnostics: JSON.stringify({ progressFaults: [] }),
        session_id: 'session-rejected',
        provider: 'codex',
        project_root: '/workspace/coral',
        backend_namespace: 'namespace-1',
        bundle_hash: null,
        job_kind: 'workflow',
        created_at: NOW.toISOString(),
        parent_workflow_job_id: null,
        workflow_slot: null,
        last_seq: appended.at(-1)?.seq,
      });

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        upcasters,
      });

      const after = db
        .prepare(
          `SELECT job_id, phase, terminal, diagnostics,
                session_id, provider, project_root, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
        )
        .get('job-rejected');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });

  it('job.aborted byte-identical after rebuild', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
      const reducers = composeReducers(jobsRegistry);
      const upcasters = createDefaultUpcasterRegistry();

      const appended = appendEvents(
        db,
        [
          {
            type: 'job.launch.requested',
            stream: { kind: 'job', id: 'job-aborted' },
            refs: { sessionId: 'session-aborted' },
            bodyVersion: 1,
            body: {
              sessionId: 'session-aborted',
              provider: 'codex',
              providerAction: 'exec',
              projectRoot: '/workspace/coral',
              backendNamespace: 'namespace-1',
              jobKind: 'provider',
              pool: 'default',
              enqueueSequence: 2,
              request: {
                prompt: 'hello',
                cwd: '/workspace/coral',
                bypassPermissions: false,
                coralEnv: {},
              },
              createdAt: NOW.toISOString(),
            },
          },
          {
            type: 'job.runtime.started',
            stream: { kind: 'job', id: 'job-aborted' },
            refs: { sessionId: 'session-aborted' },
            bodyVersion: 1,
            body: {
              transport: 'durable-cli',
              pid: 4242,
              startedAt: NOW.toISOString(),
            },
          },
          {
            type: 'job.aborted',
            stream: { kind: 'job', id: 'job-aborted' },
            refs: { sessionId: 'session-aborted' },
            bodyVersion: 1,
            body: { reason: 'user_abort' },
          },
        ],
        { now: () => NOW, reducers, upcasters },
      );

      const before = db
        .prepare(
          `SELECT job_id, phase, terminal, diagnostics,
                session_id, provider, project_root, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
        )
        .get('job-aborted');

      expect(before).toEqual({
        job_id: 'job-aborted',
        phase: 'aborted',
        terminal: null,
        diagnostics: JSON.stringify({ progressFaults: [] }),
        session_id: 'session-aborted',
        provider: 'codex',
        project_root: '/workspace/coral',
        backend_namespace: 'namespace-1',
        bundle_hash: null,
        job_kind: 'provider',
        created_at: NOW.toISOString(),
        parent_workflow_job_id: null,
        workflow_slot: null,
        last_seq: appended.at(-1)?.seq,
      });

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        upcasters,
      });

      const after = db
        .prepare(
          `SELECT job_id, phase, terminal, diagnostics,
                session_id, provider, project_root, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
        )
        .get('job-aborted');

      expect(after).toStrictEqual(before);
    } finally {
      db.close();
    }
  });
});
