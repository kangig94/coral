import { currentCoralStoreFormat } from '#src/store-format.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allocateTestSession,
  validatedTestContinuityMutation,
  validatedTestContinuitySnapshot,
} from '../../helpers/session.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome = '';

import { createRealRuntime } from '#src/runtime/real.js';
import { commit, type AppendedEvent, type CommitEventsFn } from '#src/store/append.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { SessionManager } from '#src/sessions/shell.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

let runtime: ReturnType<typeof createRealRuntime>;
const openDbs: Array<ReturnType<typeof openTestStoreDatabase>> = [];

function openSessionDb(): ReturnType<typeof openTestStoreDatabase> {
  const db = openTestStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: ':memory:',
    storage: runtime.storage,
  });
  openDbs.push(db);
  return db;
}

describe('sessions shell store', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-home-'));
    runtime = createRealRuntime('prod', { baseDir: tmpHome });
  });

  afterEach(() => {
    for (const db of openDbs.splice(0).reverse()) {
      try {
        db.close();
      } catch {
        // already closed in-test
      }
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function setup(projectName: string): { mgr: SessionManager; workDir: string } {
    const workDir = join(tmpHome, projectName);
    mkdirSync(workDir, { recursive: true });
    return {
      mgr: new SessionManager(workDir, runtime, undefined, undefined, openSessionDb(), permissiveProviderLookupPort),
      workDir,
    };
  }

  function setupWithJournal(projectName: string): {
    db: ReturnType<typeof openTestStoreDatabase>;
    mgr: SessionManager;
    workDir: string;
    coordinatorCommit: CommitEventsFn;
    appendedBatches: AppendedEvent[][];
  } {
    const workDir = join(tmpHome, projectName);
    mkdirSync(workDir, { recursive: true });

    const db = openSessionDb();
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const appendedBatches: AppendedEvent[][] = [];
    const coordinatorCommit: CommitEventsFn = (cb) => {
      const appended = commit(db, cb, {
        now: () => new Date('2026-04-19T00:00:00.000Z'),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      });
      appendedBatches.push(appended);
      return appended;
    };

    return {
      db,
      mgr: new SessionManager(workDir, runtime, coordinatorCommit, undefined, db),
      workDir,
      coordinatorCommit,
      appendedBatches,
    };
  }

  it('claimForJobAtomic allows only one concurrent claimant', async () => {
    const { mgr, workDir } = setup('claim-atomic');
    const entry = allocateTestSession(mgr, 'codex', 'alpha', 'gpt-5', workDir);

    const results = await Promise.all([
      mgr.claimForJobAtomic(entry.sessionId, 'job-1'),
      mgr.claimForJobAtomic(entry.sessionId, 'job-2'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mgr.get('codex', entry.sessionId)?.activeJobId).toMatch(/^job-[12]$/);
  });

  it('finalizeJobContinuityAtomic appends caller state, checkpoint, and claim release in one commit', async () => {
    const { appendedBatches, mgr, workDir } = setupWithJournal('finalize-dual-event');
    const entry = allocateTestSession(mgr, 'codex', 'alpha', 'gpt-5', workDir);
    mgr.claimForJobSync(entry.sessionId, 'job-1');

    const claimed = mgr.get('codex', entry.sessionId);
    if (!claimed) {
      throw new Error('Expected claimed session');
    }

    appendedBatches.length = 0;
    await expect(
      mgr.finalizeJobContinuityAtomic(entry.sessionId, {
        expectedActiveJobId: 'job-1',
        expectedVersion: claimed.version,
        mutation: validatedTestContinuityMutation({
          kind: 'set_resumable',
          conversationRef: 'thread-1',
        }),
        appendBeforeRelease: (commit) => {
          commit.append({
            type: 'session.retention.discard.requested',
            stream: { kind: 'session', id: entry.sessionId },
            refs: { sessionId: entry.sessionId },
            body: { sessionId: entry.sessionId, attempt: 1, handles: [] },
          });
        },
      }),
    ).resolves.toBe(true);

    expect(appendedBatches).toHaveLength(1);
    expect(appendedBatches[0].map((event) => event.type)).toEqual([
      'session.retention.discard.requested',
      'session.continuity.checkpointed',
      'session.claim.released',
    ]);
    const updated = mgr.get('codex', entry.sessionId);
    expect(updated).toMatchObject({
      state: 'ready',
      conversationRef: 'thread-1',
    });
    expect(Object.hasOwn(updated ?? {}, 'activeJobId')).toBe(false);
  });

  it('checks continuity CAS after acquiring the database write transaction', async () => {
    const workDir = join(tmpHome, 'checkpoint-cross-connection-cas');
    mkdirSync(workDir, { recursive: true });
    const dbPath = join(tmpHome, 'checkpoint-cross-connection-cas.db');
    const dbA = openTestStoreDatabase({
      storeFormat: currentCoralStoreFormat(),
      path: dbPath,
      storage: runtime.storage,
    });
    const dbB = openTestStoreDatabase({
      storeFormat: currentCoralStoreFormat(),
      path: dbPath,
      storage: runtime.storage,
    });
    openDbs.push(dbA, dbB);
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const commitWith = (db: typeof dbA, cb: Parameters<CommitEventsFn>[0]) =>
      commit(db, cb, {
        now: () => new Date('2026-04-19T00:00:00.000Z'),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      });
    let beforeNextACommit: (() => void) | undefined;
    const commitA: CommitEventsFn = (cb) => {
      const before = beforeNextACommit;
      beforeNextACommit = undefined;
      before?.();
      return commitWith(dbA, cb);
    };
    const commitB: CommitEventsFn = (cb) => commitWith(dbB, cb);
    const managerA = new SessionManager(workDir, runtime, commitA, undefined, dbA);
    const managerB = new SessionManager(workDir, runtime, commitB, undefined, dbB);
    const entry = allocateTestSession(managerA, 'codex', 'alpha', 'gpt-5', workDir);
    managerA.claimForJobSync(entry.sessionId, 'job-1');
    const claimed = managerA.readById(entry.sessionId, { forceFresh: true });
    if (claimed === null) throw new Error('Expected claimed session');
    managerB.readById(entry.sessionId, { forceFresh: true });
    beforeNextACommit = () => {
      void managerB.releaseJobClaimAtomic(entry.sessionId, {
        expectedActiveJobId: 'job-1',
        expectedVersion: claimed.version,
      });
    };

    await expect(
      managerA.checkpointJobContinuityAtomic(entry.sessionId, {
        expectedActiveJobId: 'job-1',
        expectedVersion: claimed.version,
        snapshot: validatedTestContinuitySnapshot({
          conversationRef: 'thread-racy',
          resumable: true,
          providerContinuity: { threadId: 'thread-racy' },
        }),
      }),
    ).resolves.toEqual({ ok: false });

    const current = managerA.readById(entry.sessionId, { forceFresh: true });
    expect(current?.activeJobId).toBeUndefined();
    expect(current?.conversationRef).toBeUndefined();
    expect(current?.state).toBe('pending');
  });
});
