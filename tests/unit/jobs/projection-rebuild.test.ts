import { existsSync, readFileSync, readdirSync } from 'node:fs';

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { REAL_CONSUMER_DRIVER_TIMERS } from '#tests/helpers/consumer-driver-defaults.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers } from '#src/store/reducers.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

const nodeStorage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'readdirSync'> = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: readdirSync as StoragePort['readdirSync'],
};

const NOW = new Date('2026-04-19T00:00:00.000Z');

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

describe('jobs projection rebuild (live ConsumerDriver, cursor-only base consumer)', () => {
  it('commit-time reducer writes projection_jobs and the cursor-only consumer advances on notify + waitFreshUntil', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: () => NOW });
    // Base journal projection consumers register cursor-only — projection
    // state is written by the commit-time reducer (spec §3.3); the cursor
    // row exists so `waitFreshUntil` can resolve callers.
    driver.register({
      id: 'jobs',
      authority: 'journal',
      kind: 'cursor',
      registrationKind: 'base',
    });

    try {
      const appended = commitInputs(
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
            bodyVersion: 1,
            body: { kind: 'recovery_parse_failed', cause: { message: 'partial stderr' } },
          },
          {
            type: 'job.terminal.recorded',
            stream: { kind: 'job', id: 'job-1' },
            refs: { sessionId: 'session-1' },
            bodyVersion: 1,
            body: {
              terminal: {
                outcome: { kind: 'provider_exit', code: 17, note: 'forced timeout' },
                durationMs: 3210,
                content: 'partial output',
              },
            },
          },
        ],
        {
          now: () => NOW,
          reducers: composeReducers(jobsRegistry),
          upcasters: createDefaultUpcasterRegistry(),
          providers: permissiveProviderLookupPort,
        },
      );

      // Spec §3.3: commit-time reducer is the authoritative writer for base
      // journal projections — projection_jobs is populated synchronously
      // during commit, before any notify.
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
        }),
        diagnostics: JSON.stringify({
          progressFaults: [{ kind: 'recovery_parse_failed', cause: { message: 'partial stderr' } }],
        }),
        parent_workflow_job_id: 'job-parent',
        workflow_slot: 'workflow-slot-1',
        last_seq: appended.at(-1)?.seq ?? 0,
      });

      const target = appended.at(-1)?.seq ?? 0;
      driver.notify('journal', target);
      await driver.waitFreshUntil('journal', target, 'jobs');

      const cursorRow = db.prepare('SELECT cursor FROM consumer_cursors WHERE consumer_id = ?').get('jobs') as
        | { cursor: number }
        | undefined;
      expect(cursorRow?.cursor).toBe(target);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
