import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';

let tmpHome = '';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import { createRealRuntime } from '../../../runtime/real.js';
import { appendEvents } from '../../../store/append.js';
import { openStoreDatabase } from '../../../store/db.js';
import { createDefaultUpcasterRegistry } from '../../../store/upcasters.js';
import { ensureStoreMigrationsDir } from '../../../store/migrations.js';
import { composeReducers } from '../../../store/reducers.js';
import { currentBuildFlavor } from '../../../infra/paths.js';
import { storePaths } from '../../../store/paths.js';
import { createProjectionSessionLookup } from '../../../store/queries/sessions.js';
import { createFilesystemSessionLookup } from '../../lookup.js';
import { jobsRegistry } from '../../../jobs/events.js';
import { discussRegistry } from '../../../discuss/store-registry.js';
import { sessionsRegistry } from '../../events.js';
import { workflowRegistry } from '../../../workflow/events.js';
import { getSessionById, listSessionShards, resolveSession } from '../resolve.js';
import { SessionManager } from '../store.js';

const runtime = createRealRuntime();

function resolveSessionDir(baseDir: string): string {
  const sessionDirBase = join(baseDir, '.claude', 'coral', 'execution', 'sessions');
  const entries = readdirSync(sessionDirBase, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 0) throw new Error('No session hash-dir found under ' + sessionDirBase);
  return join(sessionDirBase, entries[0].name);
}

describe('sessions shell resolve', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-resolve-home-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setup(projectName: string): { mgr: SessionManager; workDir: string } {
    const workDir = join(tmpHome, projectName);
    mkdirSync(workDir, { recursive: true });
    return { mgr: new SessionManager(workDir, runtime), workDir };
  }

  function createSessionDb() {
    return openStoreDatabase({
      path: storePaths(currentBuildFlavor()).dbFile,
      storage: runtime.storage,
      migrationsDir: ensureStoreMigrationsDir(runtime.storage),
    });
  }

  it('openShard reads an existing shard and listSessionShards enumerates it', () => {
    const { mgr, workDir } = setup('open-shard');
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', workDir);
    const shardDir = resolveSessionDir(tmpHome);

    expect(listSessionShards(runtime)).toContain(shardDir);

    const shardMgr = SessionManager.openShard(shardDir, runtime);
    expect(shardMgr.get('codex', entry.sessionId)).toMatchObject({
      sessionId: entry.sessionId,
      provider: 'codex',
      name: 'alpha',
    });
  });

  it('getSessionById finds a session across shards and refreshes cached reads after writes', () => {
    const alpha = setup('lookup-shard-a');
    const beta = setup('lookup-shard-b');
    const sessionLookup = createFilesystemSessionLookup(runtime);
    const sessionA = alpha.mgr.allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: alpha.workDir,
      projectRoot: alpha.workDir,
      backendNamespace: 'ns-a',
    });
    const sessionB = beta.mgr.allocate({
      provider: 'claude',
      name: 'beta',
      model: 'sonnet',
      cwd: beta.workDir,
      projectRoot: beta.workDir,
      backendNamespace: 'ns-b',
    });

    expect(getSessionById(sessionA.sessionId, runtime, sessionLookup)).toMatchObject({
      sessionId: sessionA.sessionId,
      provider: 'codex',
      backendNamespace: 'ns-a',
    });
    expect(getSessionById(sessionB.sessionId, runtime, sessionLookup)).toMatchObject({
      sessionId: sessionB.sessionId,
      provider: 'claude',
      backendNamespace: 'ns-b',
    });

    beta.mgr.setConversationRef(sessionB.sessionId, 'thread-2');

    expect(getSessionById(sessionB.sessionId, runtime, sessionLookup)).toMatchObject({
      sessionId: sessionB.sessionId,
      state: 'ready',
      conversationRef: 'thread-2',
    });
    expect(getSessionById('missing-session-id', runtime, sessionLookup)).toBeNull();
  });

  it('resolveSession supports direct shard references and provider filtering', () => {
    const alpha = setup('resolve-shard-a');
    const beta = setup('resolve-shard-b');
    const sessionLookup = createFilesystemSessionLookup(runtime);
    const sessionA = alpha.mgr.allocate('codex', 'alpha', 'gpt-5', alpha.workDir);
    const sessionB = beta.mgr.allocate('claude', 'beta', 'sonnet', beta.workDir);
    const shardA = listSessionShards(runtime).find(
      (dir) => SessionManager.openShard(dir, runtime).readById(sessionA.sessionId, { forceFresh: true }) !== null,
    );

    if (!shardA) {
      throw new Error(`Could not locate shard for ${sessionA.sessionId}`);
    }

    expect(
      resolveSession(
        {
          sessionId: sessionA.sessionId,
          shardDir: shardA,
          provider: 'codex',
        },
        runtime,
        sessionLookup,
      ),
    ).toMatchObject({
      sessionId: sessionA.sessionId,
      provider: 'codex',
    });
    expect(
      resolveSession(
        {
          sessionId: sessionA.sessionId,
          shardDir: shardA,
          provider: 'claude',
        },
        runtime,
        sessionLookup,
      ),
    ).toBeNull();
    expect(
      resolveSession(
        {
          sessionId: sessionB.sessionId,
          provider: 'claude',
        },
        runtime,
        sessionLookup,
      ),
    ).toMatchObject({
      sessionId: sessionB.sessionId,
      provider: 'claude',
    });
  });

  it('projection lookup upcasts a legacy v1 session.opened shard mapping deterministically', () => {
    const { mgr, workDir } = setup('legacy-lookup');
    const entry = mgr.allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: workDir,
      projectRoot: workDir,
      backendNamespace: 'ns-a',
    });
    const db = createSessionDb();

    try {
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      appendEvents(
        db,
        [
          {
            type: 'session.opened',
            stream: { kind: 'session', id: entry.sessionId },
            refs: { sessionId: entry.sessionId },
            bodyVersion: 1,
            body: {
              controller: 'default',
              provider: 'codex',
            },
          },
        ],
        {
          now: () => new Date('2026-04-20T00:00:00.000Z'),
          reducers,
          upcasters: createDefaultUpcasterRegistry(),
        },
      );

      const sessionLookup = createProjectionSessionLookup(db);
      expect(sessionLookup.lookupSessionShard(entry.sessionId)).toEqual({
        shardDir: join(runtime.paths.sessionBase(), createHash('sha1').update(entry.sessionId).digest('hex').slice(0, 12)),
        provider: 'codex',
      });
    } finally {
      db.close();
    }
  });
});
