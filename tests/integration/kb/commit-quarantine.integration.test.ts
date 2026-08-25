import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { quarantineKbCommit } from '#src/cli/kb-commit-quarantine.js';
import { acquireDirectoryLock } from '#src/infra/fs-lock.js';
import { KB_RUNTIME_AUTHORITY } from '#src/runtime/kb-runtime-authority.js';
import { serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  generationMutationCoordinationSeam,
  resolveGenerationBoundaryPaths,
  tryAcquireGenerationWriterLease,
} from '#src/store/generation-mutation-coordination.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { bindSocket } from '#src/transport/ipc/server.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

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
  vi.restoreAllMocks();
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
      await expect(quarantineKbCommit({ runtime, commitId })).rejects.toMatchObject({
        code: 'coordinator_socket_in_use',
        remediation: expect.stringContaining('coral-cli backend shutdown'),
      });
      expect(readFileSync(commitPath, 'utf-8')).toBe('{malformed');
    } finally {
      await closeServer(incumbent);
    }
  });

  it('refuses without mutation while a generation writer lease is live', async () => {
    const { runtime, commitId } = createHarness();
    const commitDirectory = join(
      runtime.paths.coral.kbRuntime.root,
      KB_RUNTIME_AUTHORITY.corpusProjection,
      'commits',
      commitId,
    );
    const readiness = await generationMutationCoordinationSeam.completeReadiness(runtime, currentCoralStoreFormat(), {
      kind: 'kb-child',
      name: 'orphaned-kb-daemon',
    });
    readiness.release();
    const writer = await generationMutationCoordinationSeam.acquireWriterLease(runtime, {
      kind: 'kb-child',
      name: 'orphaned-kb-daemon',
    });

    try {
      let refusal: unknown;
      try {
        await quarantineKbCommit({ runtime, commitId, maintenanceTimeoutMs: 10 });
      } catch (error: unknown) {
        refusal = error;
      }
      expect(serializeCoralSetupError(refusal)).toMatchObject({
        code: 'legacy_source_not_quiescent',
        context: { operation: 'kb-commit', holder: expect.stringContaining('orphaned-kb-daemon') },
      });
      expect(readFileSync(join(commitDirectory, 'commit.json'), 'utf-8')).toBe('{malformed');
    } finally {
      writer.release();
    }
  });

  it('preserves an unknown writer observation through the quarantine command error', async () => {
    const { runtime, commitId } = createHarness();
    const pid = runtime.env.pid();
    const incarnation = testIncarnation(pid);
    let now = runtime.time.now();
    const writerRuntime: Runtime = {
      ...runtime,
      process: {
        ...runtime.process,
        readProcessIncarnation: () => incarnation,
        observeLiveness: () => 'unknown',
      },
      time: {
        ...runtime.time,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    };
    const attempt = tryAcquireGenerationWriterLease(writerRuntime, {
      kind: 'kb-child',
      name: 'unobservable-kb-daemon',
    });
    if (attempt.kind !== 'acquired') throw new Error(`Expected writer lease, received ${attempt.kind}`);

    try {
      let refusal: unknown;
      try {
        await quarantineKbCommit({ runtime: writerRuntime, commitId, maintenanceTimeoutMs: 10 });
      } catch (error: unknown) {
        refusal = error;
      }
      const serialized = serializeCoralSetupError(refusal);
      expect(serialized).toMatchObject({
        code: 'legacy_source_not_quiescent',
        context: {
          operation: 'kb-commit',
          writerObservation: 'unknown',
          holder: expect.stringContaining('unobservable-kb-daemon'),
          retryCommand: `coral-cli backend kb-commit quarantine --flavor prod --commit ${commitId}`,
        },
        remediation: expect.stringContaining('Restore process-identity and liveness observation'),
      });
      expect(serialized?.remediation).toContain('after ten minutes without a heartbeat');
      expect(serialized?.remediation).not.toContain("Run this build's own 'coral-cli backend shutdown'");
    } finally {
      attempt.lease.release();
    }
  });

  it('translates an exclusive generation maintenance-lock timeout', async () => {
    const { runtime, commitId } = createHarness();
    const paths = resolveGenerationBoundaryPaths(runtime);
    mkdirSync(paths.coordinationRoot, { recursive: true });
    const releaseMaintenance = await acquireDirectoryLock(paths.maintenanceLock);

    try {
      await expect(quarantineKbCommit({ runtime, commitId, maintenanceTimeoutMs: 10 })).rejects.toMatchObject({
        code: 'legacy_source_not_quiescent',
        context: { operation: 'kb-commit', holder: 'generation maintenance lock' },
      });
    } finally {
      releaseMaintenance();
    }
  });

  it('rejects an unsafe ID before binding the coordinator socket', async () => {
    const { runtime } = createHarness();

    await expect(quarantineKbCommit({ runtime, commitId: '../../evil' })).rejects.toMatchObject({
      code: 'kb_commit_id_invalid',
    });
    expect(existsSync(runtime.paths.coral.coordinator.socketPath)).toBe(false);
  });

  it('reports absent and already-retained evidence as documented refusals', async () => {
    const { runtime, commitId } = createHarness();
    const projectionRoot = join(runtime.paths.coral.kbRuntime.root, KB_RUNTIME_AUTHORITY.corpusProjection);
    rmSync(join(projectionRoot, 'commits', commitId), { recursive: true });

    await expect(quarantineKbCommit({ runtime, commitId })).rejects.toMatchObject({ code: 'kb_commit_not_found' });

    mkdirSync(join(projectionRoot, 'commits', commitId), { recursive: true });
    mkdirSync(join(projectionRoot, 'quarantine', commitId), { recursive: true });
    await expect(quarantineKbCommit({ runtime, commitId })).rejects.toMatchObject({
      code: 'kb_commit_already_quarantined',
    });
  });

  it('translates durable metadata and filesystem failures without reporting an internal crash', async () => {
    const { runtime, commitId } = createHarness();
    const projectionRoot = join(runtime.paths.coral.kbRuntime.root, KB_RUNTIME_AUTHORITY.corpusProjection);
    const sync = runtime.storage.syncDirectoryDurableSync.bind(runtime.storage);
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) =>
      path === projectionRoot ? false : sync(path),
    );

    await expect(quarantineKbCommit({ runtime, commitId })).rejects.toMatchObject({
      code: 'kb_commit_quarantine_failed',
      context: { commitId, reason: 'directory-sync-failed', directory: projectionRoot },
    });

    vi.restoreAllMocks();
    const rename = runtime.storage.renameSync.bind(runtime.storage);
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      if (source === join(projectionRoot, 'commits', commitId)) {
        throw Object.assign(new Error('rename refused'), { code: 'EPERM' });
      }
      rename(source, destination);
    });
    await expect(quarantineKbCommit({ runtime, commitId })).rejects.toMatchObject({
      code: 'kb_commit_quarantine_failed',
      context: { commitId, reason: 'filesystem-operation-failed', cause: 'rename refused' },
    });
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

    const paths = resolveGenerationBoundaryPaths(runtime);
    const events: string[] = [];
    const mkdir = runtime.storage.mkdirSync.bind(runtime.storage);
    vi.spyOn(runtime.storage, 'mkdirSync').mockImplementation((path, options) => {
      if (path === paths.adoptionLock) {
        expect(existsSync(runtime.paths.coral.coordinator.socketPath)).toBe(true);
        events.push('adoption');
      }
      if (path === paths.maintenanceLock) {
        expect(existsSync(paths.adoptionLock)).toBe(true);
        events.push('maintenance');
      }
      return mkdir(path, options);
    });
    const rename = runtime.storage.renameSync.bind(runtime.storage);
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      if (source === join(projectionRoot, 'commits', commitId)) {
        expect(existsSync(runtime.paths.coral.coordinator.socketPath)).toBe(true);
        expect(existsSync(paths.adoptionLock)).toBe(true);
        expect(existsSync(paths.maintenanceLock)).toBe(true);
        events.push('quarantine');
      }
      rename(source, destination);
    });

    const result = await quarantineKbCommit({ runtime, commitId });

    expect(result.artifacts).toEqual(['commit', 'index']);
    expect(existsSync(join(projectionRoot, 'commits', commitId))).toBe(false);
    expect(existsSync(join(projectionRoot, 'index', 'commits', commitId))).toBe(false);
    expect(readFileSync(join(otherCommit, 'commit.json'), 'utf-8')).toBe('other');
    expect(readFileSync(unrelatedKbFile, 'utf-8')).toBe('unrelated');
    expect(readFileSync(storeFile, 'utf-8')).toBe('store-sentinel');
    expect(readFileSync(join(result.quarantineDir, 'commit', 'commit.json'), 'utf-8')).toBe('{malformed');
    expect(readFileSync(join(result.quarantineDir, 'index', 'previous-index.json'), 'utf-8')).toBe('index-evidence');
    expect(events).toEqual(['adoption', 'maintenance', 'quarantine']);
  });
});
