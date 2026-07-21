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

describe('jobs queries', () => {
  let db: Database;
  let readCtx: StoreReadContext;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db);

    const reducers = composeReducers(jobsRegistry);
    const bodyCodec = createEventBodyCodec();
    readCtx = {
      schemas: reducers.schemas,
      bodyCodec,
    };

    const inputs: CoralEventInput[] = [
      {
        type: 'job.launch.requested',
        stream: { kind: 'job', id: 'job-completed' },
        refs: { sessionId: 'session-completed', parentJobId: 'workflow-1', workflowSlotId: 'slot-1' },
        bodyVersion: 1,
        body: {
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
            conversationRef: 'thread-completed',
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
        bodyVersion: 1,
        body: {
          transport: 'app-server',
          startedAt: '2026-04-20T00:00:05.000Z',
          providerMeta: {
            provider: 'codex',
            leaseState: 'acquired',
            serverGeneration: 7,
            providerContinuity: { threadId: 'thread-completed' },
          },
        },
      },
      {
        type: 'job.terminal.recorded',
        stream: { kind: 'job', id: 'job-completed' },
        refs: { sessionId: 'session-completed' },
        bodyVersion: 1,
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
          continuity: {
            conversationRef: 'thread-completed',
            resumable: true,
            providerContinuity: { threadId: 'thread-completed' },
          },
        },
      },
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
        bodyVersion: 1,
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
        bodyVersion: 1,
        body: {
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
        bodyVersion: 1,
        body: {
          queuePosition: 1,
          runningJobIds: ['job-completed'],
        },
      },
      {
        type: 'job.launch.requested',
        stream: { kind: 'job', id: 'job-kb-global' },
        refs: {},
        bodyVersion: 1,
        body: {
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
        bodyVersion: 1,
        body: {
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
          serverGeneration: 7,
          providerContinuity: { threadId: 'thread-completed' },
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
        continuity: {
          conversationRef: 'thread-completed',
          resumable: true,
          providerContinuity: { threadId: 'thread-completed' },
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

  it('pushes list filters into the projection query', () => {
    const prepareSpy = vi.spyOn(db, 'prepare');

    const jobs = listJobs(
      db,
      {
        namespace: 'tests',
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

    expect(projectionQuery).toContain('backend_namespace = ?');
    expect(projectionQuery).toContain('phase IN (?, ?, ?)');
    expect(projectionQuery).toContain("(project_root = ? OR job_kind = 'kb')");
    expect(projectionQuery).toContain('phase = ?');
    expect(projectionQuery).toContain('provider = ?');
  });

  it('keeps KB jobs visible from any project while scoping other projects out', () => {
    const jobs = listJobs(db, { namespace: 'tests', projectRoot: '/workspace/coral' }, readCtx);
    const ids = jobs.map((entry) => entry.jobId);

    // KB jobs run against the shared corpus, so they surface regardless of cwd...
    expect(ids).toContain('job-kb-global');
    // ...the current project's own live job still lists...
    expect(ids).toContain('job-queued');
    // ...but a different project's non-KB job stays scoped out.
    expect(ids).not.toContain('job-other-project');
  });

  it('keeps the KB exception under the all-phases filter', () => {
    const jobs = listJobs(db, { namespace: 'tests', projectRoot: '/workspace/coral', all: true }, readCtx);
    const ids = jobs.map((entry) => entry.jobId);

    // `all` widens phases but does not change the project scope: KB stays global,
    // the current project's terminal job now appears, the foreign non-KB stays out.
    expect(ids).toContain('job-kb-global');
    expect(ids).toContain('job-completed');
    expect(ids).not.toContain('job-other-project');
  });
});
