import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';

let tmpHome = '';
const tmpRoot = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/coral-session-index-test-tmp`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
    tmpdir: () => tmpRoot,
  };
});

import { ProgressStore } from '../progress-store.js';
import { SessionIndex } from '../session-index.js';
import { SessionManager, listSessionShards } from '../session-manager.js';
import { createRealRuntime } from '../runtime.js';

const runtime = createRealRuntime();

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
    const session = new SessionManager(projectRoot, runtime).allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: projectRoot,
      projectRoot,
      backendNamespace: 'ns-hydrate',
    });
    const [shardDir] = listSessionShards(runtime);
    writeFileSync(join(shardDir, 'corrupt.json'), '{not-json', 'utf-8');

    const index = new SessionIndex(runtime);
    index.hydrate(listSessionShards(runtime));

    expect(index.listAll()).toEqual([
      {
        shardHash: basename(shardDir),
        sessions: [
          expect.objectContaining({
            sessionId: session.sessionId,
            provider: 'codex',
            projectRoot,
            backendNamespace: 'ns-hydrate',
            provenanceState: 'authoritative',
            version: 1,
          }),
        ],
      },
    ]);
  });

  it('lazily rereads invalidated sessions on listing', () => {
    const projectRoot = createProjectRoot('invalidate-project');
    const manager = new SessionManager(projectRoot, runtime);
    const session = manager.allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: projectRoot,
      projectRoot,
      backendNamespace: 'ns-invalidate',
    });
    const [shardDir] = listSessionShards(runtime);

    const index = new SessionIndex(runtime);
    index.hydrate(listSessionShards(runtime));

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
    const session = new SessionManager(projectRoot, runtime).allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: projectRoot,
      projectRoot,
      backendNamespace: 'ns-delete',
    });
    const [shardDir] = listSessionShards(runtime);

    const index = new SessionIndex(runtime);
    index.hydrate(listSessionShards(runtime));

    writeFileSync(join(shardDir, `${session.sessionId}.json`), '{not-json', 'utf-8');
    index.reread(basename(shardDir), session.sessionId);

    expect(index.listAll()).toEqual([]);
  });

  it('filters namespace-visible sessions by stored backendNamespace', () => {
    const projectRoot = createProjectRoot('namespace-project');
    const manager = new SessionManager(projectRoot, runtime);
    const visible = manager.allocate({
      provider: 'codex',
      name: 'visible',
      model: 'gpt-5',
      cwd: projectRoot,
      projectRoot,
      backendNamespace: 'ns-visible',
    });
    const foreign = manager.allocate({
      provider: 'codex',
      name: 'foreign',
      model: 'gpt-5',
      cwd: projectRoot,
      projectRoot,
      backendNamespace: 'ns-foreign',
    });
    const legacy = manager.allocate({
      provider: 'codex',
      name: 'legacy-seed',
      model: 'gpt-5',
      cwd: projectRoot,
      projectRoot,
      backendNamespace: 'ns-temp',
    });
    const authoritativeIdle = manager.allocate({
      provider: 'codex',
      name: 'idle',
      model: 'gpt-5',
      cwd: projectRoot,
      projectRoot,
      backendNamespace: 'ns-visible',
    });

    manager.claimForJobSync(visible.sessionId, 'job-visible');
    manager.claimForJobSync(foreign.sessionId, 'job-foreign');
    manager.claimForJobSync(legacy.sessionId, 'job-legacy');

    const [shardDir] = listSessionShards(runtime);
    writeFileSync(
      join(shardDir, `${legacy.sessionId}.json`),
      JSON.stringify(
        {
          ...legacy,
          activeJobId: 'job-legacy',
          backendNamespace: undefined,
          version: legacy.version,
        },
        null,
        2,
      ),
      'utf-8',
    );

    const progressStore = new ProgressStore('ns-visible', runtime);
    progressStore.initJob({
      jobId: 'job-visible',
      sessionId: visible.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: 'ns-visible',
    });
    progressStore.initJob({
      jobId: 'job-foreign',
      sessionId: foreign.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: 'ns-visible',
    });
    progressStore.initJob({
      jobId: 'job-legacy',
      sessionId: legacy.sessionId,
      provider: 'codex',
      projectRoot,
      backendNamespace: 'ns-visible',
    });

    const index = new SessionIndex(runtime);
    index.hydrate(listSessionShards(runtime));

    expect(
      index
        .listAll()
        .flatMap((row) => row.sessions)
        .find((session) => session.sessionId === legacy.sessionId),
    ).toMatchObject({
      sessionId: legacy.sessionId,
      provenanceState: 'legacy_unresolved',
    });

    const visibleSessions = index.listForNamespace('ns-visible', progressStore);
    expect(visibleSessions).toHaveLength(1);
    expect(visibleSessions[0]?.sessions.map((session) => session.sessionId).sort()).toEqual(
      [authoritativeIdle.sessionId, visible.sessionId].sort(),
    );
    expect(visibleSessions[0]?.sessions.every((session) => session.backendNamespace === 'ns-visible')).toBe(true);
  });

  it('hydrates shards created after startup on demand', () => {
    const projectRootA = createProjectRoot('shard-a');
    const sessionA = new SessionManager(projectRootA, runtime).allocate({
      provider: 'codex',
      name: 'alpha',
      model: 'gpt-5',
      cwd: projectRootA,
      projectRoot: projectRootA,
      backendNamespace: 'ns-a',
    });

    const index = new SessionIndex(runtime);
    index.hydrate(listSessionShards(runtime));

    const projectRootB = createProjectRoot('shard-b');
    const sessionB = new SessionManager(projectRootB, runtime).allocate({
      provider: 'codex',
      name: 'beta',
      model: 'gpt-5',
      cwd: projectRootB,
      projectRoot: projectRootB,
      backendNamespace: 'ns-b',
    });

    // Simulate event-driven shard discovery (refreshIndex no longer scans unconditionally)
    // Find the new shard by diffing listShards against known shards
    for (const shardDir of listSessionShards(runtime)) {
      const shardHash = basename(shardDir);
      if (!index.hasShard(shardHash)) {
        index.discoverShard(shardHash);
      }
    }

    expect(
      index
        .listAll()
        .flatMap((row) => row.sessions.map((session) => session.sessionId))
        .sort(),
    ).toEqual([sessionA.sessionId, sessionB.sessionId].sort());
  });
});
