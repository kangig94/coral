import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { markJobAsError } from '#src/jobs/reconcile/recovery-effects.js';
import { ProgressStore } from '#src/jobs/job-store.js';
import type { JobStatus } from '#src/jobs/records.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcasters.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const NOW = new Date('2026-04-28T00:00:00.000Z');

const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};

function createDb(): Database.Database {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
  return db;
}

function createProgressStore(db: Database.Database): ProgressStore {
  return new ProgressStore(
    'tests',
    {
      time: { now: () => NOW.getTime() },
    } as never,
    createDefaultUpcasterRegistry(),
    { db },
  );
}

function recoveryStatus(): JobStatus {
  return {
    jobId: 'job-recovery-synthetic-launch',
    sessionId: 'session-recovery-synthetic-launch',
    provider: 'codex',
    projectRoot: '/workspace/recovery-synthetic-launch',
    backendNamespace: 'tests',
    jobKind: 'provider',
    phase: 'running',
    updatedAt: NOW.toISOString(),
  };
}

function readEvents(db: Database.Database): Array<{ seq: number; type: string; body: unknown }> {
  const rows = db.prepare('SELECT seq, type, body FROM events ORDER BY seq ASC').all() as Array<{
    seq: number;
    type: string;
    body: Buffer;
  }>;
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    body: decodeEventBody(row.body),
  }));
}

describe('recovery effects', () => {
  it('records synthetic launch, recovery fault, and terminal in one commit', () => {
    const db = createDb();
    try {
      const progressStore = createProgressStore(db);
      const commitSpy = vi.spyOn(progressStore, 'commit');
      const status = recoveryStatus();

      markJobAsError(progressStore, status, { kind: 'missing_launch_record' }, () => {});

      expect(commitSpy).toHaveBeenCalledTimes(1);
      expect(readEvents(db)).toEqual([
        expect.objectContaining({
          seq: 1,
          type: 'job.launch.requested',
          body: expect.objectContaining({
            sessionId: status.sessionId,
            provider: status.provider,
            projectRoot: status.projectRoot,
            backendNamespace: status.backendNamespace,
          }),
        }),
        expect.objectContaining({
          seq: 2,
          type: 'job.progress.emitted',
          body: { kind: 'missing_launch_record' },
        }),
        expect.objectContaining({
          seq: 3,
          type: 'job.terminal.recorded',
          body: expect.objectContaining({
            terminal: expect.objectContaining({
              outcome: {
                kind: 'failed',
                causeRef: {
                  stream: { kind: 'job', id: status.jobId },
                  seq: 2,
                },
              },
            }),
          }),
        }),
      ]);

      const detail = progressStore.loadJobProjectionDetail(status.jobId);
      expect(detail.launch).toMatchObject({
        sessionId: status.sessionId,
        provider: status.provider,
      });
      expect(detail.status).toMatchObject({
        phase: 'error',
        result: {
          outcome: {
            kind: 'failed',
            causeRef: {
              stream: { kind: 'job', id: status.jobId },
              seq: 2,
            },
          },
        },
      });
    } finally {
      db.close();
    }
  });
});
