import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { installResponseSchema } from '#src/expansion/rpc-contract.js';
import { installExpansion, uninstallExpansion } from '#src/cli/expansion/install.js';
import { createDeferred } from '#tools/testing/deferred.js';

const PACKAGE = 'codebase-memory';
const BINARY = 'codebase-memory-mcp';
const createdRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(homeName = 'home') {
  const root = mkdtempSync(join(tmpdir(), 'coral-install-only-'));
  createdRoots.push(root);
  const homeDir = join(root, homeName);
  const baseDir = join(homeDir, '.coral');
  mkdirSync(homeDir, { recursive: true });
  return { root, homeDir, baseDir };
}

// Scope the WHOLE path tree to the fixture, not just the engine family. Overriding
// `engine` alone used to work only because generation coordination reverse-derived
// its root from `engineRoot`; once the generation family became published path
// authority, a partial override let the install pipeline take its adoption lock in
// the developer's real ~/.coral.
function createRuntimeForFixture(fixture: ReturnType<typeof createFixture>): Runtime {
  return createRealRuntime('prod', { baseDir: fixture.baseDir });
}

function dataDir(baseDir: string): string {
  return enginePaths('prod', { baseDir }).dataDir(PACKAGE);
}

function binaryPath(baseDir: string): string {
  return join(dataDir(baseDir), BINARY);
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

describe('install-only codebase-memory', () => {
  it('returns expansion_install_lock_contended when another install holds the lock', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const blocker = createDeferred<void>();
    const lockAcquired = createDeferred<void>();
    vi.spyOn(runtime.process, 'exec').mockImplementation(async () => {
      lockAcquired.resolve();
      await blocker.promise;
      writeFileSync(binaryPath(fixture.baseDir), 'binary');
      return { stdout: '', stderr: '', status: 0 };
    });

    const first = installExpansion(PACKAGE, { runtime, lockTimeoutMs: 25 });
    await lockAcquired.promise;

    const second = await installExpansion(PACKAGE, { runtime, lockTimeoutMs: 25 });
    blocker.resolve();

    expect(installResponseSchema.parse(second)).toMatchObject({
      status: 'error',
      code: 'expansion_install_lock_contended',
      context: { name: PACKAGE },
    });
    expect((await first).status).toBe('installed');
  });

  it('runs the binary uninstall subcommand, then removes the package data directory', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    mkdirSync(dataDir(fixture.baseDir), { recursive: true });
    writeFileSync(binaryPath(fixture.baseDir), 'binary');
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue({ stdout: '', stderr: '', status: 0 });

    expect(await uninstallExpansion(PACKAGE, { runtime })).toEqual({ status: 'uninstalled' });
    expect(exec.mock.calls[0]?.[1]?.[1] ?? '').toContain(`${binaryPath(fixture.baseDir)}' uninstall`);
    expect(pathExists(dataDir(fixture.baseDir))).toBe(false);
  });
});
