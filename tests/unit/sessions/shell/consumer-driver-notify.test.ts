import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { appendEvents } from '#src/store/append.js';
import { createEmptyRegistry } from '#src/store/envelope.js';
import { applyMigrations } from '#src/store/migrations.js';
import { composeReducers } from '#src/store/reducers.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { discussRegistry } from '#src/discuss/store-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { registerSessionsConsumer } from '#src/sessions/consumer.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { SessionManager } from '#src/sessions/shell/store.js';
import { workflowRegistry } from '#src/workflow/events.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

const tempRoots: string[] = [];
let previousHome: string | undefined;

function resolveSessionDir(baseDir: string): string {
  const sessionDirBase = join(baseDir, '.claude', 'coral', 'execution', 'sessions');
  const entries = readdirSync(sessionDirBase, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length === 0) {
    throw new Error(`No session hash-dir found under ${sessionDirBase}`);
  }
  return join(sessionDirBase, entries[0].name);
}

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  previousHome = undefined;

  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: nodeStorage });
  return db;
}

describe('sessions consumer-driver notify', () => {
  it('projects the appended session after SessionManager uses the coordinator-bound appender', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    registerSessionsConsumer(driver, db);

    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const upcasters = createEmptyRegistry();
    const coordinatorAppendEvents = (inputs: Parameters<typeof appendEvents>[1]) => {
      const appended = appendEvents(db, inputs, {
        now: () => new Date('2026-04-19T00:00:00.000Z'),
        reducers,
        upcasters,
      });
      if (appended.length > 0) {
        driver.notify('journal', appended[appended.length - 1].seq);
      }
    };

    previousHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'coral-session-notify-home-'));
    tempRoots.push(tempHome);
    process.env.HOME = tempHome;

    const runtime = createRealRuntime();
    const workDir = join(tempHome, 'project');
    const manager = new SessionManager(workDir, runtime, coordinatorAppendEvents);

    try {
      const entry = manager.allocate({
        provider: 'codex',
        name: 'alpha',
        model: 'gpt-5',
        cwd: workDir,
      });

      await driver.drainAll();
      const row = db
        .prepare(
          `SELECT controller, provider, resumable, conversation_ref, shard_dir, last_seq
             FROM projection_sessions
            WHERE session_id = ?`,
        )
        .get(entry.sessionId) as
        | { controller: string; provider: string; resumable: number; conversation_ref: string | null; last_seq: number }
        | undefined;

      expect(row).toEqual({
        controller: 'default',
        provider: 'codex',
        resumable: 0,
        conversation_ref: null,
        shard_dir: resolveSessionDir(tempHome),
        last_seq: 1,
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
