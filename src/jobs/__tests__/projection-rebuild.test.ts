import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '../../runtime/ports.js';
import { ConsumerDriver } from '../../coordinator/consumer-driver.js';
import { appendEvents } from '../../store/append.js';
import { applyMigrations } from '../../store/migrations.js';
import { composeReducers } from '../../store/reducers.js';
import { createDefaultUpcasterRegistry } from '../../store/upcasters.js';
import { registerJobsConsumer } from '../consumer.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

const NOW = new Date('2026-04-19T00:00:00.000Z');

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: nodeStorage });
  return db;
}

describe('jobs projection rebuild (live ConsumerDriver)', () => {
  it('replays historical job events into projection_jobs byte-identically through notify + waitFreshUntil', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, now: () => NOW });
    registerJobsConsumer(driver, db);

    try {
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
        {
          now: () => NOW,
          reducers: composeReducers(),
          upcasters: createDefaultUpcasterRegistry(),
        },
      );

      expect(
        db
          .prepare(
            `SELECT job_id
               FROM projection_jobs
              WHERE job_id = ?`,
          )
          .get('job-1'),
      ).toBeUndefined();

      const target = appended.at(-1)?.seq ?? 0;
      driver.notify('journal', target);
      await driver.waitFreshUntil(target, 'jobs');

      expect(
        db
          .prepare(
            `SELECT job_id, phase, terminal, diagnostics, parent_workflow_job_id, workflow_slot, last_seq
               FROM projection_jobs
              WHERE job_id = ?
              LIMIT 1`,
          )
          .get('job-1'),
      ).toEqual({
        job_id: 'job-1',
        phase: 'error',
        terminal: JSON.stringify({
          content: 'partial output',
          outcome: { kind: 'provider_exit', code: 17, note: 'forced timeout' },
          durationMs: 3210,
          exitCode: 17,
        }),
        diagnostics: JSON.stringify({
          progressFaults: [{ kind: 'recovery_parse_failed', cause: { message: 'partial stderr' } }],
        }),
        parent_workflow_job_id: 'job-parent',
        workflow_slot: 'workflow-slot-1',
        last_seq: target,
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
