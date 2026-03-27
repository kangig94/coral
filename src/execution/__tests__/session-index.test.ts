import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome = '';
const tmpRoot = vi.hoisted(() => `${process.env.TMPDIR || '/tmp'}/coral-session-index-test-tmp`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
    tmpdir: () => tmpRoot,
  };
});

import { ProgressStore } from '../progress-store.js';
import { SessionIndex } from '../session-index.js';
import { SessionManager } from '../session-manager.js';

describe('execution SessionIndex', () => {
  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-session-index-home-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createProjectRoot(name: string): string {
    const projectRoot = join(tmpHome, name);
    mkdirSync(projectRoot, { recursive: true });
    return projectRoot;
  }

  it('hydrates shards leniently and skips corrupt entries', () => {
    const projectRoot = createProjectRoot('hydrate-project');
    const session = new SessionManager(projectRoot).allocate('codex', 'alpha', 'gpt-5', projectRoot, projectRoot);
    const [shardDir] = SessionManager.listShards();
    writeFileSync(join(shardDir, 'corrupt.json'), '{not-json', 'utf-8');

    const index = new SessionIndex();
    index.hydrate(SessionManager.listShards());

    expect(index.listAll()).toEqual([
      {
        shardHash: basename(shardDir),
        sessions: [
          expect.objectContaining({
            sessionId: session.sessionId,
            provider: 'codex',
            projectRoot,
            provenanceState: 'authoritative',
            version: 1,
          }),
        ],
      },
    ]);
  });

  it('lazily rereads invalidated sessions on listing', () => {
    const projectRoot = createProjectRoot('invalidate-project');
    const manager = new SessionManager(projectRoot);
    const session = manager.allocate('codex', 'alpha', 'gpt-5', projectRoot, projectRoot);
    const [shardDir] = SessionManager.listShards();

    const index = new SessionIndex();
    index.hydrate(SessionManager.listShards());

    manager.claimForJobSync(session.sessionId, 'job-1');
    index.invalidate(basename(shardDir), session.sessionId);

    expect(index.listAll()).toEqual([
      {
        shardHash: basename(shardDir),
        sessions: [
          expect.objectContaining({
            sessionId: session.sessionId,
            activeJobId: 'job-1',
            version: 2,
          }),
        ],
      },
    ]);
  });

  it('deletes rows when reread finds a corrupt file', () => {
    const projectRoot = createProjectRoot('delete-project');
    const session = new SessionManager(projectRoot).allocate('codex', 'alpha', 'gpt-5', projectRoot, projectRoot);
    const [shardDir] = SessionManager.listShards();

    const index = new SessionIndex();
    index.hydrate(SessionManager.listShards());

    writeFileSync(join(shardDir, `${session.sessionId}.json`), '{not-json', 'utf-8');
    index.reread(basename(shardDir), session.sessionId);

    expect(index.listAll()).toEqual([]);
  });

  it('filters namespace-visible sessions using activeJobId and progress status', () => {
    const projectRoot = createProjectRoot('namespace-project');
    const manager = new SessionManager(projectRoot);
    const visible = manager.allocate('codex', 'visible', 'gpt-5', projectRoot, projectRoot);
    const foreign = manager.allocate('codex', 'foreign', 'gpt-5', projectRoot, projectRoot);
    const orphaned = manager.allocate('codex', 'orphaned', 'gpt-5', projectRoot, projectRoot);
    const idle = manager.allocate('codex', 'idle', 'gpt-5', projectRoot, projectRoot);

    manager.claimForJobSync(visible.sessionId, 'job-visible');
    manager.claimForJobSync(foreign.sessionId, 'job-foreign');
    manager.claimForJobSync(orphaned.sessionId, 'job-orphaned');

    const progressStore = new ProgressStore();
    progressStore.initJob({ jobId: 'job-visible', sessionId: visible.sessionId, provider: 'codex', projectRoot, backendNamespace: 'ns-visible' });
    progressStore.initJob({ jobId: 'job-foreign', sessionId: foreign.sessionId, provider: 'codex', projectRoot, backendNamespace: 'ns-foreign' });

    const index = new SessionIndex();
    index.hydrate(SessionManager.listShards());

    const visibleSessions = index.listForNamespace('ns-visible', progressStore);
    expect(visibleSessions).toHaveLength(1);
    expect(visibleSessions[0]?.sessions.map((session) => session.sessionId).sort()).toEqual([
      idle.sessionId,
      visible.sessionId,
    ].sort());
  });

  it('hydrates shards created after startup on demand', () => {
    const projectRootA = createProjectRoot('shard-a');
    const sessionA = new SessionManager(projectRootA).allocate('codex', 'alpha', 'gpt-5', projectRootA, projectRootA);

    const index = new SessionIndex();
    index.hydrate(SessionManager.listShards());

    const projectRootB = createProjectRoot('shard-b');
    const sessionB = new SessionManager(projectRootB).allocate('codex', 'beta', 'gpt-5', projectRootB, projectRootB);

    // Simulate event-driven shard discovery (refreshIndex no longer scans unconditionally)
    // Find the new shard by diffing listShards against known shards
    for (const shardDir of SessionManager.listShards()) {
      const shardHash = basename(shardDir);
      if (!index.hasShard(shardHash)) {
        index.discoverShard(shardHash);
      }
    }

    expect(index.listAll().flatMap((row) => row.sessions.map((session) => session.sessionId)).sort()).toEqual([
      sessionA.sessionId,
      sessionB.sessionId,
    ].sort());
  });
});
