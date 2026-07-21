import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateTestSession } from '../../helpers/session.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

import { createRealRuntime } from '#src/runtime/real.js';
import { openStoreDatabase } from '#src/store/db.js';
import { resolveBuildFlavor } from '#src/infra/build-flavor.js';
import { storePaths } from '#src/infra/path/store.js';
import { createProjectionSessionLookup } from '#src/sessions/lookup.js';
import { getSessionById, resolveSession } from '#src/sessions/resolve.js';
import { SessionManager } from '#src/sessions/shell.js';

let runtime: ReturnType<typeof createRealRuntime>;
let db: ReturnType<typeof openStoreDatabase>;

describe('sessions shell resolve', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-resolve-home-'));
    runtime = createRealRuntime('prod');
    db = createSessionDb();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setup(projectName: string): { mgr: SessionManager; workDir: string } {
    const workDir = join(tmpHome, projectName);
    mkdirSync(workDir, { recursive: true });
    return { mgr: new SessionManager(workDir, runtime, undefined, undefined, db), workDir };
  }

  function createSessionDb() {
    return openStoreDatabase({
      path: storePaths(resolveBuildFlavor(process.env)).dbFile,
      storage: runtime.storage,
    });
  }

  it('projection lookup lists and reads allocated sessions', () => {
    const { mgr, workDir } = setup('open-shard');
    const entry = allocateTestSession(mgr, 'codex', 'alpha', 'gpt-5', workDir);
    const lookup = createProjectionSessionLookup(db);

    expect(lookup.listSessionRefs()).toContainEqual(
      expect.objectContaining({
        sessionId: entry.sessionId,
        provider: 'codex',
      }),
    );
    expect(lookup.readSessionEntry(entry.sessionId)).toMatchObject({
      sessionId: entry.sessionId,
      provider: 'codex',
      name: 'alpha',
    });
  });

  it('getSessionById finds a session across shards and refreshes cached reads after writes', () => {
    const alpha = setup('lookup-shard-a');
    const beta = setup('lookup-shard-b');
    const sessionLookup = createProjectionSessionLookup(db);
    const sessionA = alpha.mgr.allocate({
      provider: 'codex',
      sessionAuthority: { kind: 'orchestration' },
      name: 'alpha',
      model: 'gpt-5',
      cwd: alpha.workDir,
      projectRoot: alpha.workDir,
      backendNamespace: 'ns-a',
    });
    const sessionB = beta.mgr.allocate({
      provider: 'claude',
      sessionAuthority: { kind: 'orchestration' },
      name: 'beta',
      model: 'sonnet',
      cwd: beta.workDir,
      projectRoot: beta.workDir,
      backendNamespace: 'ns-b',
    });

    expect(getSessionById(sessionA.sessionId, sessionLookup)).toMatchObject({
      sessionId: sessionA.sessionId,
      provider: 'codex',
      backendNamespace: 'ns-a',
    });
    expect(getSessionById(sessionB.sessionId, sessionLookup)).toMatchObject({
      sessionId: sessionB.sessionId,
      provider: 'claude',
      backendNamespace: 'ns-b',
    });

    beta.mgr.setConversationRef(sessionB.sessionId, 'thread-2');

    expect(getSessionById(sessionB.sessionId, sessionLookup)).toMatchObject({
      sessionId: sessionB.sessionId,
      state: 'ready',
      conversationRef: 'thread-2',
    });
    expect(getSessionById('missing-session-id', sessionLookup)).toBeNull();
  });

  it('getSessionById reads projection entries directly when the lookup owns them', () => {
    const alpha = setup('projection-entry-owner');
    const entry = alpha.mgr.allocate({
      provider: 'codex',
      sessionAuthority: { kind: 'orchestration' },
      name: 'alpha',
      model: 'gpt-5',
      cwd: alpha.workDir,
      projectRoot: alpha.workDir,
      backendNamespace: 'ns-a',
    });
    const readSessionEntry = vi.fn((sessionId: string) =>
      sessionId === entry.sessionId
        ? {
            ...entry,
            state: 'ready' as const,
            conversationRef: 'projection-thread',
          }
        : null,
    );

    expect(getSessionById(entry.sessionId, { readSessionEntry })).toMatchObject({
      sessionId: entry.sessionId,
      provider: 'codex',
      state: 'ready',
      conversationRef: 'projection-thread',
    });
    expect(readSessionEntry).toHaveBeenCalledWith(entry.sessionId);
  });

  it('resolveSession supports provider filtering', () => {
    const alpha = setup('resolve-shard-a');
    const beta = setup('resolve-shard-b');
    const sessionLookup = createProjectionSessionLookup(db);
    const sessionA = allocateTestSession(alpha.mgr, 'codex', 'alpha', 'gpt-5', alpha.workDir);
    const sessionB = allocateTestSession(beta.mgr, 'claude', 'beta', 'sonnet', beta.workDir);

    expect(
      resolveSession(
        {
          sessionId: sessionA.sessionId,
          provider: 'codex',
        },
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
          provider: 'claude',
        },
        sessionLookup,
      ),
    ).toBeNull();
    expect(
      resolveSession(
        {
          sessionId: sessionB.sessionId,
          provider: 'claude',
        },
        sessionLookup,
      ),
    ).toMatchObject({
      sessionId: sessionB.sessionId,
      provider: 'claude',
    });
  });

  it('projection lookup reads the canonical session.opened scope mapping deterministically', () => {
    const { mgr, workDir } = setup('canonical-lookup');
    const entry = mgr.allocate({
      provider: 'codex',
      sessionAuthority: { kind: 'orchestration' },
      name: 'alpha',
      model: 'gpt-5',
      cwd: workDir,
      projectRoot: workDir,
      backendNamespace: 'ns-a',
    });
    const sessionLookup = createProjectionSessionLookup(db);
    expect(sessionLookup.readSessionEntry(entry.sessionId)).toMatchObject({
      sessionId: entry.sessionId,
      provider: 'codex',
    });
  });
});
