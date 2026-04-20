import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendEvents, type AppendInput } from '../append.js';
import type { StoreReadContext } from '../body-codec.js';
import { applyMigrations } from '../migrations.js';
import { loadJobProjectionDetail, loadJobProjectionDetails } from '../queries/jobs.js';
import { composeReducers } from '../reducers.js';
import { createDefaultUpcasterRegistry } from '../upcasters.js';
import { jobsRegistry } from '../../jobs/events.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};

describe('jobs queries', () => {
  let db: Database.Database;
  let readCtx: StoreReadContext;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });

    const reducers = composeReducers(jobsRegistry);
    const upcasters = createDefaultUpcasterRegistry();
    readCtx = {
      schemas: reducers.schemas,
      upcasters,
    };

    const inputs: AppendInput[] = [
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
          parentJobId: 'workflow-1',
          workflowSlot: 'slot-1',
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
          outcome: { kind: 'completed' },
          durationMs: 3210,
          content: 'done',
          exitCode: 0,
          warnings: ['soft warning'],
          usage: {
            inputTokens: 12,
            outputTokens: 34,
            costUsd: 0.56,
          },
          workflow: {
            steps: [{ agent: 'architect', step: 0, atom: 0, provider: 'codex', start: 1, end: 2 }],
          },
          nonResumable: false,
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
    ];

    appendEvents(db, inputs, {
      now: () => new Date('2026-04-20T00:03:00.000Z'),
      reducers,
      upcasters,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('hydrates batched projection details without narrowing status, runtime, or terminal fields', () => {
    const jobIds = ['job-completed', 'job-rejected', 'job-queued', 'job-missing', 'job-completed'];
    const detailsByJob = loadJobProjectionDetails(db, jobIds, readCtx);

    expect(detailsByJob.size).toBe(4);

    for (const jobId of ['job-completed', 'job-rejected', 'job-queued', 'job-missing']) {
      expect(detailsByJob.get(jobId)).toEqual(loadJobProjectionDetail(db, jobId, readCtx));
    }

    expect(detailsByJob.get('job-completed')).toMatchObject({
      status: {
        phase: 'completed',
        launch: { state: 'ready' },
        result: {
          content: 'done',
          nonResumable: false,
          warnings: ['soft warning'],
          usage: {
            inputTokens: 12,
            outputTokens: 34,
            costUsd: 0.56,
          },
          workflow: {
            steps: [{ agent: 'architect', step: 0, atom: 0, provider: 'codex', start: 1, end: 2 }],
          },
        },
      },
      runtime: {
        transport: 'app-server',
        providerMeta: {
          provider: 'codex',
          leaseState: 'acquired',
          serverGeneration: 7,
          providerContinuity: { threadId: 'thread-completed' },
          recoveryPolicy: 'session_continuity_only',
        },
      },
      exit: {
        content: 'done',
        nonResumable: false,
        warnings: ['soft warning'],
      },
    });

    expect(detailsByJob.get('job-rejected')?.status?.launch).toMatchObject({
      state: 'error',
      message: 'Launch rejected (codex busy: 7/10).',
    });

    expect(detailsByJob.get('job-missing')).toEqual({
      status: null,
      launch: null,
      runtime: null,
      exit: null,
    });
  });
});
