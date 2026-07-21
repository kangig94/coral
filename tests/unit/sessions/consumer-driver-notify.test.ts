import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it } from 'vitest';

import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { commit } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { SessionManager } from '#src/sessions/shell.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
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

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

describe('sessions consumer-driver notify', () => {
  it('projects the appended session after SessionManager uses the coordinator-bound appender', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    // Cursor-only base consumer; commit-time reducer writes projection_sessions.
    driver.register({
      id: 'sessions',
      authority: 'journal',
      kind: 'cursor',
      registrationKind: 'base',
    });

    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const coordinatorCommit = (cb: Parameters<typeof commit>[1]) => {
      const appended = commit(db, cb, {
        now: () => new Date('2026-04-19T00:00:00.000Z'),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
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
        sessionAuthority: { kind: 'orchestration' },
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
