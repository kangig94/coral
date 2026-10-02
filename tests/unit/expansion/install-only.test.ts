import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { resolveInstallOnlyManifest } from '#src/expansion/install-only.js';
import { installResponseSchema } from '#src/expansion/rpc-contract.js';
import { installExpansion, uninstallExpansion } from '#src/cli/expansion/install.js';
import type {
  GenerationMutationCoordination,
  GenerationWriterLease,
} from '#src/store/generation-mutation-coordination.js';
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

/** Decode a POSIX single-quoted token (e.g. `'a'\''b'` -> `a'b`). */
function decodePosixSingleQuoted(token: string): string {
  let out = '';
  for (let i = 0; i < token.length; ) {
    const ch = token[i];
    if (ch === "'") {
      i += 1;
      while (i < token.length && token[i] !== "'") out += token[i++];
      i += 1;
    } else if (ch === '\\' && token[i + 1] === "'") {
      out += "'";
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The `--dir=` value is the final pipeline token; decode it back to a real path. */
function extractDir(pipeline: string): string {
  return decodePosixSingleQuoted(pipeline.slice(pipeline.indexOf('--dir=') + '--dir='.length));
}

/** Mock `bash -c '<pipeline>'` to behave like a successful install.sh run. */
function stubSuccessfulInstall(runtime: Runtime): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(runtime.process, 'exec').mockImplementation(async (_command, args) => {
    writeFileSync(join(extractDir(args[1] ?? ''), BINARY), 'binary');
    return { stdout: '', stderr: '', status: 0 };
  });
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function recordGenerationCoordination(events: string[]): GenerationMutationCoordination {
  return {
    async completeReadiness(_runtime, mutation) {
      events.push(`readiness:${mutation.kind}`);
      return {
        release() {
          events.push('readiness-release');
        },
      };
    },
    async acquireWriterLease(_runtime, mutation) {
      events.push(`writer:${mutation.kind}`);
      let owned = true;
      return {
        directoryLock: {} as GenerationWriterLease['directoryLock'],
        assertOwned() {
          if (!owned) throw new Error('test writer lease released early');
        },
        release() {
          owned = false;
          events.push('writer-release');
        },
      };
    },
  };
}

describe('install-only codebase-memory', () => {
  it.each([
    { operation: 'install', kind: 'install' },
    { operation: 'update', kind: 'update' },
    { operation: 'install-only unequip', kind: 'uninstall' },
  ] as const)(
    'orders $operation as readiness release, writer lease, then first package mkdir',
    async ({ operation, kind }) => {
      const fixture = createFixture();
      const runtime = createRuntimeForFixture(fixture);
      const events: string[] = [];
      const generationCoordination = recordGenerationCoordination(events);

      if (operation === 'install-only unequip') {
        mkdirSync(dataDir(fixture.baseDir), { recursive: true });
        writeFileSync(binaryPath(fixture.baseDir), 'binary');
        vi.spyOn(runtime.process, 'exec').mockResolvedValue({ stdout: '', stderr: '', status: 0 });
      } else {
        stubSuccessfulInstall(runtime);
      }

      const mkdir = runtime.storage.mkdirSync.bind(runtime.storage);
      vi.spyOn(runtime.storage, 'mkdirSync').mockImplementation((path, options) => {
        events.push('mkdir');
        mkdir(path, options);
      });

      if (operation === 'install-only unequip') {
        await uninstallExpansion(PACKAGE, { runtime, generationCoordination });
      } else {
        await installExpansion(PACKAGE, {
          runtime,
          generationCoordination,
          ...(operation === 'update' ? { update: true } : {}),
        });
      }

      expect(events.slice(0, 3)).toEqual([`readiness:${kind}`, 'readiness-release', `writer:${kind}`]);
      expect(events.indexOf('mkdir')).toBeGreaterThan(events.indexOf(`writer:${kind}`));
      expect(events.at(-1)).toBe('writer-release');
    },
  );

  it('runs the install pipeline and reports the installed binary path', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const exec = stubSuccessfulInstall(runtime);

    const result = installResponseSchema.parse(await installExpansion(PACKAGE, { runtime }));

    expect(result).toEqual({
      status: 'installed',
      method: 'shell',
      version: 'latest',
      targetDir: dataDir(fixture.baseDir),
      command: binaryPath(fixture.baseDir),
    });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]?.[0]).toBe('bash');
    expect(exec.mock.calls[0]?.[1]?.[0]).toBe('-c');
    const pipeline = exec.mock.calls[0]?.[1]?.[1] as string;
    expect(pipeline).toContain('install.sh');
    expect(pipeline).toContain('--ui');
    expect(pipeline).toContain(`--dir='${dataDir(fixture.baseDir)}'`);
    expect(pathExists(binaryPath(fixture.baseDir))).toBe(true);
  });

  it('updates an installed package in place via the binary update subcommand', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    mkdirSync(dataDir(fixture.baseDir), { recursive: true });
    writeFileSync(binaryPath(fixture.baseDir), 'old');
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue({ stdout: '', stderr: '', status: 0 });

    const result = await installExpansion(PACKAGE, { runtime, update: true });

    expect(result).toMatchObject({ status: 'updated', method: 'shell' });
    const command = exec.mock.calls[0]?.[1]?.[1] ?? '';
    expect(command).toContain(`${binaryPath(fixture.baseDir)}' update`);
    expect(command).not.toContain('install.sh');
  });

  it('surfaces expansion_install_command_failed with stderr detail on non-zero exit', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    vi.spyOn(runtime.process, 'exec').mockResolvedValue({ stdout: '', stderr: 'network down', status: 1 });

    const result = installResponseSchema.parse(await installExpansion(PACKAGE, { runtime }));

    expect(result).toMatchObject({
      status: 'error',
      code: 'expansion_install_command_failed',
      context: { name: PACKAGE, detail: 'network down' },
    });
  });

  it('errors when the pipeline succeeds but produces no binary', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    vi.spyOn(runtime.process, 'exec').mockResolvedValue({ stdout: '', stderr: '', status: 0 });

    const result = installResponseSchema.parse(await installExpansion(PACKAGE, { runtime }));

    expect(result).toMatchObject({
      status: 'error',
      code: 'expansion_install_command_failed',
      context: { name: PACKAGE },
    });
  });

  it('returns expansion_install_lock_contended when another install holds the lock', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const blocker = createDeferred<void>();
    const lockAcquired = createDeferred<void>();
    vi.spyOn(runtime.process, 'exec').mockImplementation(async (_command, args) => {
      const dir = extractDir(args[1] ?? '');
      lockAcquired.resolve();
      await blocker.promise;
      writeFileSync(join(dir, BINARY), 'binary');
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

  it.each(['install', 'uninstall'] as const)(
    'rejects a foreign identity before direct %s can touch package storage',
    async (operation) => {
      const fixture = createFixture();
      const runtime = createRuntimeForFixture(fixture);
      const installer = resolveInstallOnlyManifest(PACKAGE)?.installer;
      if (installer === undefined) {
        throw new Error('expected install-only package');
      }
      const exec = vi.spyOn(runtime.process, 'exec');
      const foreignDir = runtime.paths.coral.engine.dataDir('foreign-package');

      await expect(
        installer[operation]({
          name: 'foreign-package',
          version: 'latest',
          runtime,
        }),
      ).rejects.toThrow(/identity mismatch/u);
      expect(exec).not.toHaveBeenCalled();
      expect(pathExists(foreignDir)).toBe(false);
    },
  );

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

  it('still removes the binary when the binary uninstall subcommand fails', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    mkdirSync(dataDir(fixture.baseDir), { recursive: true });
    writeFileSync(binaryPath(fixture.baseDir), 'binary');
    vi.spyOn(runtime.process, 'exec').mockRejectedValue(new Error('spawn failed'));

    expect(await uninstallExpansion(PACKAGE, { runtime })).toEqual({ status: 'uninstalled' });
    expect(pathExists(dataDir(fixture.baseDir))).toBe(false);
  });
});
