import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { quarantineKbCommit } from '#src/cli/kb-commit-quarantine.js';
import { acquireDirectoryLock } from '#src/infra/fs-lock.js';
import { KB_RUNTIME_AUTHORITY } from '#src/runtime/kb-runtime-authority.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { bindSocket } from '#src/transport/ipc/server.js';

const roots: string[] = [];

function createHarness(): { readonly root: string; readonly runtime: Runtime; readonly commitId: string } {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-commit-quarantine-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const commitId = 'blocking-commit';
  const projectionRoot = join(runtime.paths.coral.kbRuntime.root, KB_RUNTIME_AUTHORITY.corpusProjection);
  const commitDirectory = join(projectionRoot, 'commits', commitId);
  const indexDirectory = join(projectionRoot, 'index', 'commits', commitId);
  mkdirSync(commitDirectory, { recursive: true });
  mkdirSync(indexDirectory, { recursive: true });
  writeFileSync(join(commitDirectory, 'commit.json'), '{malformed', 'utf-8');
  writeFileSync(join(indexDirectory, 'previous-index.json'), 'index-evidence', 'utf-8');
  return { root, runtime, commitId };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('KB commit quarantine', () => {
  it('refuses while the coordinator socket is owned and leaves evidence untouched', async () => {
    const { runtime, commitId } = createHarness();
    const commitPath = join(
      runtime.paths.coral.kbRuntime.root,
      KB_RUNTIME_AUTHORITY.corpusProjection,
      'commits',
      commitId,
      'commit.json',
    );
    const incumbent = createServer();
    await expect(bindSocket(incumbent, runtime.paths.coral.coordinator.socketPath)).resolves.toEqual({
      kind: 'bound',
    });

    try {
      await expect(quarantineKbCommit({ runtime, commitId })).rejects.toThrow(/socket to be unbound/);
      expect(readFileSync(commitPath, 'utf-8')).toBe('{malformed');
    } finally {
      await closeServer(incumbent);
    }
  });

  it('refuses without mutation while KB maintenance is owned', async () => {
    const { runtime, commitId } = createHarness();
    const commitDirectory = join(
      runtime.paths.coral.kbRuntime.root,
      KB_RUNTIME_AUTHORITY.corpusProjection,
      'commits',
      commitId,
    );
    const releaseMaintenance = await acquireDirectoryLock(
      join(runtime.paths.coral.kbRuntime.root, KB_RUNTIME_AUTHORITY.mutationLock),
    );

    try {
      await expect(quarantineKbCommit({ runtime, commitId, maintenanceTimeoutMs: 10 })).rejects.toThrow(
        /Directory lock timeout/,
      );
      expect(readFileSync(join(commitDirectory, 'commit.json'), 'utf-8')).toBe('{malformed');
    } finally {
      releaseMaintenance();
    }
  });

  it('quarantines only the named KB evidence and never touches store-reset or unrelated artifacts', async () => {
    const { runtime, commitId } = createHarness();
    const projectionRoot = join(runtime.paths.coral.kbRuntime.root, KB_RUNTIME_AUTHORITY.corpusProjection);
    const otherCommit = join(projectionRoot, 'commits', 'other-commit');
    const unrelatedKbFile = join(runtime.paths.coral.kbRuntime.root, 'unrelated.txt');
    const storeFile = runtime.paths.coral.store.dbFile;
    mkdirSync(otherCommit, { recursive: true });
    mkdirSync(dirname(storeFile), { recursive: true });
    writeFileSync(join(otherCommit, 'commit.json'), 'other', 'utf-8');
    writeFileSync(unrelatedKbFile, 'unrelated', 'utf-8');
    writeFileSync(storeFile, 'store-sentinel', 'utf-8');

    const result = await quarantineKbCommit({ runtime, commitId });

    expect(result.artifacts).toEqual(['commit', 'index']);
    expect(existsSync(join(projectionRoot, 'commits', commitId))).toBe(false);
    expect(existsSync(join(projectionRoot, 'index', 'commits', commitId))).toBe(false);
    expect(readFileSync(join(otherCommit, 'commit.json'), 'utf-8')).toBe('other');
    expect(readFileSync(unrelatedKbFile, 'utf-8')).toBe('unrelated');
    expect(readFileSync(storeFile, 'utf-8')).toBe('store-sentinel');
    expect(readFileSync(join(result.quarantineDir, 'commit', 'commit.json'), 'utf-8')).toBe('{malformed');
    expect(readFileSync(join(result.quarantineDir, 'index', 'previous-index.json'), 'utf-8')).toBe('index-evidence');
  });
});
