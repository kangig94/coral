import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoralEventInput } from '#src/store/envelope.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import type { StoreReadContext } from '#src/store/body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { listJobs, loadJobProjectionDetail, loadJobProjectionDetails } from '#src/jobs/read-queries.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';

describe('jobs queries', () => {
  let db: Database;
  let readCtx: StoreReadContext;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());

    const reducers = composeReducers(jobsRegistry);
    const bodyCodec = createEventBodyCodec();
    readCtx = {
      schemas: reducers.schemas,
      streamKinds: reducers.streamKinds,
      bodyCodec,
    };

    for (const [sessionId, projectRoot] of [
      ['session-completed', '/workspace/coral'],
      ['session-rejected', '/workspace/coral'],
      ['session-queued', '/workspace/coral'],
      ['session-other', '/workspace/other-project'],
    ] as const) {
      seedTestSessionProjection(db, {
        sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: 'tests',
      });
    }

    const inputs: CoralEventInput[] = [
      {
        type: 'job.launch.requested',
        stream: { kind: 'job', id: 'job-completed' },
        refs: { sessionId: 'session-completed' },
        body: {
          owner: { kind: 'provider-session', id: 'session-completed' },
          sessionId: 'session-completed',
          provider: 'codex',
          providerAction: 'resume',
          projectRoot: '/workspace/coral',
          backendNamespace: 'tests',
          bundleHash: 'bundle-completed',
          jobKind: 'provider',
          pool: 'default',
          enqueueSequence: 1,
          request: {
            prompt: 'Continue from the prior run.',
            name: 'architect',
            model: 'gpt-5.4',
            cwd: '/workspace/coral',
            effort: 'high',
            bypassPermissions: false,
            systemPrompt: 'Be precise.',
            instruction: {
              content: 'Write the patch.',
              channel: 'system',
            },
            coralEnv: { CORAL_ENV: 'test' },
          },
          createdAt: '2026-04-20T00:00:00.000Z',
        },
      },
      {
        type: 'job.runtime.started',
        stream: { kind: 'job', id: 'job-completed' },
        refs: { sessionId: 'session-completed' },
        body: {
          transport: 'app-server',
          startedAt: '2026-04-20T00:00:05.000Z',
          providerMeta: {
            provider: 'codex',
            leaseState: 'acquired',
            hostRef: {
              provider: 'codex',
              fingerprint: '0'.repeat(64),
              instanceId: 'instance-1',
              leaseMode: 'shared',
            },
          },
        },
      },
      {
        type: 'job.terminal.recorded',
        stream: { kind: 'job', id: 'job-completed' },
        refs: { sessionId: 'session-completed' },
        body: {
          terminal: {
            outcome: { kind: 'completed' },
            durationMs: 3210,
            content: 'done',
          },
          diagnostics: {
            warnings: ['soft warning'],
            usage: {
              inputTokens: 12,
              outputTokens: 34,
              costUsd: 0.56,
            },
          },
        },
      },
      {
        type: 'job.launch.requested',
        stream: { kind: 'job', id: 'job-rejected' },
        refs: { sessionId: 'session-rejected' },
        body: {
          owner: { kind: 'provider-session', id: 'session-rejected' },
          sessionId: 'session-rejected',
          provider: 'codex',
          providerAction: 'exec',
          projectRoot: '/workspace/coral',
          backendNamespace: 'tests',
          jobKind: 'provider',
          pool: 'default',
          enqueueSequence: 2,
          request: {
            prompt: 'Launch me.',
            cwd: '/workspace/coral',
            bypassPermissions: false,
            coralEnv: {},
          },
          createdAt: '2026-04-20T00:01:00.000Z',
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
      {
        type: 'job.launch.requested',
        stream: { kind: 'job', id: 'job-queued' },
        refs: { sessionId: 'session-queued' },
        body: {
          owner: { kind: 'provider-session', id: 'session-queued' },
          sessionId: 'session-queued',
          provider: 'codex',
          providerAction: 'exec',
          projectRoot: '/workspace/coral',
          backendNamespace: 'tests',
          jobKind: 'provider',
          pool: 'default',
          enqueueSequence: 3,
          request: {
            prompt: 'Queue me.',
            cwd: '/workspace/coral',
            bypassPermissions: true,
            coralEnv: {},
          },
          createdAt: '2026-04-20T00:02:00.000Z',
        },
      },
      {
        type: 'job.queue.queued',
        stream: { kind: 'job', id: 'job-queued' },
        refs: { sessionId: 'session-queued' },
        body: {
          queuePosition: 1,
          runningJobIds: ['job-completed'],
        },
      },
      {
        type: 'job.launch.requested',
        stream: { kind: 'job', id: 'job-kb-global' },
        refs: {},
        body: {
          owner: { kind: 'system-task', id: 'kb.reindex:job-kb-global' },
          projectRoot: '/workspace/other-project',
          backendNamespace: 'tests',
          bundleHash: 'bundle-kb',
          jobKind: 'kb',
          pool: 'default',
          enqueueSequence: 4,
          operation: 'kb.reindex',
          request: {},
          createdAt: '2026-04-20T00:02:30.000Z',
        },
      },
      {
        type: 'job.launch.requested',
        stream: { kind: 'job', id: 'job-other-project' },
        refs: { sessionId: 'session-other' },
        body: {
          owner: { kind: 'provider-session', id: 'session-other' },
          sessionId: 'session-other',
          provider: 'codex',
          providerAction: 'exec',
          projectRoot: '/workspace/other-project',
          backendNamespace: 'tests',
          bundleHash: 'bundle-other',
          jobKind: 'provider',
          pool: 'default',
          enqueueSequence: 5,
          request: {
            prompt: 'Run in another project.',
            cwd: '/workspace/other-project',
            bypassPermissions: false,
            coralEnv: {},
          },
          createdAt: '2026-04-20T00:02:40.000Z',
        },
      },
    ];

    commitInputs(db, inputs, {
      now: () => new Date('2026-04-20T00:03:00.000Z'),
      reducers,
      bodyCodec,
      providers: permissiveProviderLookupPort,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('hydrates batched projection details without narrowing status, runtime, or terminal fields', () => {
    const jobIds = ['job-completed', 'job-rejected', 'job-queued', 'job-missing', 'job-completed'];
    const prepareSpy = vi.spyOn(db, 'prepare');
    const detailsByJob = loadJobProjectionDetails(db, jobIds, readCtx);
    const prepareCallCount = prepareSpy.mock.calls.length;

    expect(detailsByJob.size).toBe(4);

    for (const jobId of ['job-completed', 'job-rejected', 'job-queued', 'job-missing']) {
      expect(detailsByJob.get(jobId)).toEqual(loadJobProjectionDetail(db, jobId, readCtx));
    }

    expect(detailsByJob.get('job-completed')).toMatchObject({
      status: {
        phase: 'completed',
        result: {
          content: 'done',
        },
      },
      runtime: {
        transport: 'app-server',
        providerMeta: {
          provider: 'codex',
          leaseState: 'acquired',
          hostRef: {
            provider: 'codex',
            fingerprint: '0'.repeat(64),
            instanceId: 'instance-1',
            leaseMode: 'shared',
          },
        },
      },
      exit: {
        content: 'done',
        diagnostics: {
          warnings: ['soft warning'],
          usage: {
            inputTokens: 12,
            outputTokens: 34,
            costUsd: 0.56,
          },
        },
      },
    });

    expect(detailsByJob.get('job-rejected')?.status).toMatchObject({
      phase: 'error',
    });

    expect(detailsByJob.get('job-missing')).toEqual({
      status: null,
      launch: null,
      runtime: null,
      exit: null,
    });

    expect(prepareCallCount).toBeLessThanOrEqual(4);
  });

  it('projects durable workflow identity for an opaque child job id', () => {
    const childJobId = '11111111-1111-4111-8111-111111111111';
    const workflowJobId = '22222222-2222-4222-8222-222222222222';
    const replacedJobId = '33333333-3333-4333-8333-333333333333';
    const workflowSlotId = `${workflowJobId}:0:1`;

    db.prepare(
      `INSERT INTO projection_jobs (
         job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
         project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
         workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
       ) VALUES (?, ?, 'running', NULL, ?, ?, 'codex', ?, 'tests', NULL, 'provider', ?, ?, 1, ?, ?, 0)`,
    ).run(
      childJobId,
      JSON.stringify({ kind: 'workflow', id: workflowJobId }),
      JSON.stringify({ progressFaults: [] }),
      'session-child',
      '/workspace/coral',
      workflowJobId,
      workflowSlotId,
      replacedJobId,
      '2026-04-20T00:03:00.000Z',
    );

    expect(loadJobProjectionDetail(db, childJobId, readCtx).status).toMatchObject({
      jobId: childJobId,
      parentWorkflowJobId: workflowJobId,
      workflowSlotId,
      workflowSlotGeneration: 1,
      replacesWorkflowJobId: replacedJobId,
    });
  });

  it('decodes complete projection rows before applying list filters', () => {
    const prepareSpy = vi.spyOn(db, 'prepare');

    const jobs = listJobs(
      db,
      {
        projectRoot: '/workspace/coral',
        phase: 'queued',
        provider: 'codex',
      },
      readCtx,
    );

    expect(jobs.map((entry) => entry.jobId)).toEqual(['job-queued']);

    const projectionQuery = prepareSpy.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('FROM projection_jobs'));

    expect(projectionQuery).not.toContain('WHERE');
    expect(projectionQuery).toContain('execution_owner');
    expect(projectionQuery).toContain('workflow_slot_generation');
  });

  it('keeps KB jobs visible from any project while scoping other projects out', () => {
    const jobs = listJobs(db, { projectRoot: '/workspace/coral' }, readCtx);
    const ids = jobs.map((entry) => entry.jobId);

    // KB jobs run against the shared corpus, so they surface regardless of cwd...
    expect(ids).toContain('job-kb-global');
    // ...the current project's own live job still lists...
    expect(ids).toContain('job-queued');
    // ...but a different project's non-KB job stays scoped out.
    expect(ids).not.toContain('job-other-project');
  });

  it('keeps the KB exception under the all-phases filter', () => {
    const jobs = listJobs(db, { projectRoot: '/workspace/coral', all: true }, readCtx);
    const ids = jobs.map((entry) => entry.jobId);

    // `all` widens phases but does not change the project scope: KB stays global,
    // the current project's terminal job now appears, the foreign non-KB stays out.
    expect(ids).toContain('job-kb-global');
    expect(ids).toContain('job-completed');
    expect(ids).not.toContain('job-other-project');
  });
});
