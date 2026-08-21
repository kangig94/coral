import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');

function claimedSessionInputs(sessionId: string, activeJobId: string): CoralEventInput[] {
  const opened: ProviderSession = {
    sessionId,
    binding: TEST_CODEX_BINDING,
    name: sessionId,
    state: 'pending',
    retention: 'retain',
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    providerContinuity: null,
    cwd: '/workspace/coral',
    projectRoot: '/workspace/coral',
    backendNamespace: 'namespace-1',
    createdAt: NOW.toISOString(),
    lastUsedAt: NOW.toISOString(),
    version: 1,
  };
  const claimed: ProviderSession = { ...opened, activeJobId, version: opened.version + 1 };
  return [
    {
      type: 'session.opened',
      stream: { kind: 'session', id: sessionId },
      refs: { sessionId },
      body: { entry: opened, controller: 'default', scope_key: `/workspace/coral\u0000codex\u0000default` },
    },
    {
      type: 'session.claimed',
      stream: { kind: 'session', id: sessionId },
      refs: { sessionId, jobId: activeJobId },
      body: { entry: claimed, jobId: activeJobId },
    },
  ];
}

describe('jobs reducer equivalence', () => {
  it('rebuilds projection_jobs rows byte-identically from a historical event sequence', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(jobsRegistry, sessionsRegistry);
      const bodyCodec = createEventBodyCodec();

      const appended = commitInputs(
        db,
        [
          ...claimedSessionInputs('session-1', 'job-1'),
          {
            type: 'job.launch.requested',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            body: {
              owner: { kind: 'provider-session', id: 'session-1' },
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
              createdAt: NOW.toISOString(),
            },
          },
          {
            type: 'job.queue.queued',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            body: { queuePosition: 2, runningJobIds: ['job-live'] },
          },
          {
            type: 'job.queue.admitted',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            body: { queuePosition: 0 },
          },
          {
            type: 'job.runtime.started',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            body: {
              transport: 'durable-cli',
              pid: 4242,
              stdoutPath: '/tmp/job-1.stdout',
              stderrPath: '/tmp/job-1.stderr',
              startedAt: NOW.toISOString(),
            },
          },
          {
            type: 'job.progress.emitted',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            body: {
              kind: 'domain',
              stage: 'hosted_kb_operation_failed',
              message: 'KB promote failed: index unavailable',
              detail: { operation: 'promote', code: 'kb_error' },
            },
          },
          {
            type: 'job.progress.emitted',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            body: { kind: 'recovery_parse_failed', cause: { message: 'partial stderr' } },
          },
          {
            type: 'job.terminal.recorded',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            body: {
              terminal: {
                outcome: { kind: 'provider_exit', code: 17, note: 'forced timeout' },
                durationMs: 3210,
                content: 'partial output',
              },
            },
          },
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      const before = db
        .prepare(
          `SELECT job_id, execution_owner, phase, terminal, diagnostics,
                session_id, provider, project_root, work_dir, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, workflow_slot_generation,
                replaces_workflow_job_id, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
        )
        .get('job-1');

      expect(before).toEqual({
        job_id: 'job-1',
        execution_owner: JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
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
        work_dir: '/workspace/coral',
        backend_namespace: 'namespace-1',
        bundle_hash: 'bundle-1',
        job_kind: 'provider',
        created_at: NOW.toISOString(),
        parent_workflow_job_id: null,
        workflow_slot: null,
        workflow_slot_generation: null,
        replaces_workflow_job_id: null,
        last_seq: appended.at(-1)?.seq,
      });

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        bodyCodec,
      });

      const after = db
        .prepare(
          `SELECT job_id, execution_owner, phase, terminal, diagnostics,
                session_id, provider, project_root, work_dir, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, workflow_slot_generation,
                replaces_workflow_job_id, last_seq
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
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry);
      const bodyCodec = createEventBodyCodec();

      const appended = commitInputs(
        db,
        [
          workflowPlanDeclaredEvent(
            'job-rejected',
            {
              slots: [
                {
                  slotId: 'job-rejected:0:0',
                  dependencies: [],
                  provider: 'codex',
                  instruction: 'reject this launch',
                },
              ],
            },
            TEST_PROVIDER_SCOPE,
          ),
          {
            type: 'job.launch.requested',
            stream: { kind: 'job', id: 'job-rejected' },
            refs: { workflowId: 'job-rejected' },
            body: {
              owner: { kind: 'workflow', id: 'job-rejected' },
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
            body: {
              reason: 'busy',
              message: 'Provider queue is full.',
              provider: 'codex',
              globalActive: 7,
              globalLimit: 10,
            },
          },
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      const before = db
        .prepare(
          `SELECT job_id, execution_owner, phase, terminal, diagnostics,
                session_id, provider, project_root, work_dir, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, workflow_slot_generation,
                replaces_workflow_job_id, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
        )
        .get('job-rejected');

      expect(before).toEqual({
        job_id: 'job-rejected',
        execution_owner: JSON.stringify({ kind: 'workflow', id: 'job-rejected' }),
        phase: 'error',
        terminal: null,
        diagnostics: JSON.stringify({ progressFaults: [] }),
        session_id: null,
        provider: null,
        project_root: '/workspace/coral',
        work_dir: '/workspace/coral',
        backend_namespace: 'namespace-1',
        bundle_hash: null,
        job_kind: 'workflow',
        created_at: NOW.toISOString(),
        parent_workflow_job_id: null,
        workflow_slot: null,
        workflow_slot_generation: null,
        replaces_workflow_job_id: null,
        last_seq: appended.at(-1)?.seq,
      });

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        bodyCodec,
      });

      const after = db
        .prepare(
          `SELECT job_id, execution_owner, phase, terminal, diagnostics,
                session_id, provider, project_root, work_dir, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, workflow_slot_generation,
                replaces_workflow_job_id, last_seq
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
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(jobsRegistry, sessionsRegistry);
      const bodyCodec = createEventBodyCodec();

      const appended = commitInputs(
        db,
        [
          ...claimedSessionInputs('session-aborted', 'job-aborted'),
          {
            type: 'job.launch.requested',
            stream: { kind: 'job', id: 'job-aborted' },
            refs: { sessionId: 'session-aborted' },
            body: {
              owner: { kind: 'provider-session', id: 'session-aborted' },
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
            body: {
              transport: 'durable-cli',
              pid: 4242,
              stdoutPath: '/tmp/job-aborted.stdout',
              stderrPath: '/tmp/job-aborted.stderr',
              startedAt: NOW.toISOString(),
            },
          },
          {
            type: 'job.aborted',
            stream: { kind: 'job', id: 'job-aborted' },
            refs: { sessionId: 'session-aborted' },
            body: { reason: 'user_abort' },
          },
        ],
        { now: () => NOW, reducers, bodyCodec, providers: permissiveProviderLookupPort },
      );

      const before = db
        .prepare(
          `SELECT job_id, execution_owner, phase, terminal, diagnostics,
                session_id, provider, project_root, work_dir, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, workflow_slot_generation,
                replaces_workflow_job_id, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
        )
        .get('job-aborted');

      expect(before).toEqual({
        job_id: 'job-aborted',
        execution_owner: JSON.stringify({ kind: 'provider-session', id: 'session-aborted' }),
        phase: 'aborted',
        terminal: null,
        diagnostics: JSON.stringify({ progressFaults: [] }),
        session_id: 'session-aborted',
        provider: 'codex',
        project_root: '/workspace/coral',
        work_dir: '/workspace/coral',
        backend_namespace: 'namespace-1',
        bundle_hash: null,
        job_kind: 'provider',
        created_at: NOW.toISOString(),
        parent_workflow_job_id: null,
        workflow_slot: null,
        workflow_slot_generation: null,
        replaces_workflow_job_id: null,
        last_seq: appended.at(-1)?.seq,
      });

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        bodyCodec,
      });

      const after = db
        .prepare(
          `SELECT job_id, execution_owner, phase, terminal, diagnostics,
                session_id, provider, project_root, work_dir, backend_namespace, bundle_hash, job_kind, created_at,
                parent_workflow_job_id, workflow_slot, workflow_slot_generation,
                replaces_workflow_job_id, last_seq
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
