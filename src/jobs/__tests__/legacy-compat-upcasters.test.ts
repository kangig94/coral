import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { appendEvents } from '../../store/append.js';
import { decodeEventBody } from '../../store/body-codec.js';
import { applyMigrations } from '../../store/migrations.js';
import { composeReducers } from '../../store/reducers.js';
import { createDefaultUpcasterRegistry } from '../../store/upcasters.js';
import { jobsRegistry } from '../events.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../store/migrations');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-22T00:00:00.000Z');

describe('jobs legacy compat upcasters (AC3.2, AC3.6)', () => {
  it('upcasts legacy launch_rejected event bodies to the canonical job.launch.rejected shape', () => {
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
            stream: { kind: 'job', id: 'job-legacy-rejected' },
            refs: { sessionId: 'session-legacy-rejected' },
            bodyVersion: 1,
            body: {
              sessionId: 'session-legacy-rejected',
              provider: 'claude',
              providerAction: 'exec',
              projectRoot: '/workspace/coral',
              backendNamespace: 'namespace-1',
              jobKind: 'provider',
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
            stream: { kind: 'job', id: 'job-legacy-rejected' },
            refs: { sessionId: 'session-legacy-rejected' },
            bodyVersion: 1,
            body: {
              kind: 'launch_rejected',
              reason: 'busy',
              message: 'Provider queue is full.',
              provider: 'claude',
              globalActive: 2,
              globalLimit: 2,
            },
          },
        ],
        { now: () => NOW, reducers, upcasters },
      );

      expect(appended[1]?.body).toEqual({
        reason: 'busy',
        message: 'Provider queue is full.',
        provider: 'claude',
        globalActive: 2,
        globalLimit: 2,
      });

      const stored = db.prepare(
        `SELECT body_version, body
           FROM events
          WHERE stream_kind = 'job'
            AND stream_id = ?
            AND type = 'job.launch.rejected'
          LIMIT 1`,
      ).get('job-legacy-rejected') as { body_version: number; body: Uint8Array | Buffer } | undefined;

      expect(stored?.body_version).toBe(1);
      expect(decodeEventBody(stored!.body)).toEqual({
        kind: 'launch_rejected',
        reason: 'busy',
        message: 'Provider queue is full.',
        provider: 'claude',
        globalActive: 2,
        globalLimit: 2,
      });

      const projection = db.prepare(
        `SELECT phase, last_seq
           FROM projection_jobs
          WHERE job_id = ?
          LIMIT 1`,
      ).get('job-legacy-rejected');

      expect(projection).toEqual({
        phase: 'error',
        last_seq: appended[1]?.seq,
      });
    } finally {
      db.close();
    }
  });
});
