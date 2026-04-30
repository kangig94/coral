import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { commit } from '#src/store/append.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers } from '#src/store/reducers.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { SessionManager } from '#src/sessions/shell/store.js';
import { workflowRegistry } from '#src/workflow/events.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

const tempRoots: string[] = [];
let previousHome: string | undefined;

function resolveScopeKey(projectRoot: string): string {
  return pluginRootNamespace(projectRoot);
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
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

describe('sessions consumer-driver notify', () => {
  it('projects the appended session after SessionManager uses the coordinator-bound appender', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    // Cursor-only base consumer; commit-time reducer writes projection_sessions.
    driver.register({
      id: 'sessions',
      authority: 'journal',
      kind: 'cursor',
      registrationKind: 'base',
    });

    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const upcasters = createDefaultUpcasterRegistry();
    const coordinatorCommit = (cb: Parameters<typeof commit>[1]) => {
      const appended = commit(db, cb, {
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

    const runtime = createRealRuntime('prod');
    const workDir = join(tempHome, 'project');
    mkdirSync(workDir, { recursive: true });
    const manager = new SessionManager(workDir, runtime, coordinatorCommit, undefined, db);

    try {
      const entry = manager.allocate({
        provider: 'codex',
        name: 'alpha',
        model: 'gpt-5',
        cwd: workDir,
        projectRoot: workDir,
        backendNamespace: pluginRootNamespace(workDir),
      });

      await driver.drainAll();
      const row = db
        .prepare(
          `SELECT controller, provider, resumable, conversation_ref, scope_key, last_seq
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
        scope_key: resolveScopeKey(workDir),
        last_seq: 1,
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
