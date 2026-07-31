import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { resolveInstallOnlyManifest } from '#src/expansion/install-only.js';
import { installResponseSchema } from '#src/expansion/rpc-contract.js';
import { inspectExpansionInstallState, installExpansion, uninstallExpansion } from '#src/cli/expansion/install.js';
import type { GenerationMutationCoordination } from '#src/store/generation-mutation-coordination.js';
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

function createRuntimeForFixture(fixture: ReturnType<typeof createFixture>): Runtime {
  const realRuntime = createRealRuntime('prod');
  const fixtureEngine = enginePaths('prod', { baseDir: fixture.baseDir });
  return {
    ...realRuntime,
    paths: {
      ...realRuntime.paths,
      get coral() {
        return { ...realRuntime.paths.coral, engine: fixtureEngine };
      },
    },
  };
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

async function waitForCondition(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
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

  it('shell-quotes a data dir that contains a single quote', async () => {
    const fixture = createFixture("ho'me");
    const runtime = createRuntimeForFixture(fixture);
    const exec = stubSuccessfulInstall(runtime);

    const result = installResponseSchema.parse(await installExpansion(PACKAGE, { runtime }));

    // The decoder in stubSuccessfulInstall only writes the binary at the real
    // (quote-containing) dataDir if singleQuote escaped it correctly.
    expect(result).toMatchObject({ status: 'installed', command: binaryPath(fixture.baseDir) });
    expect(pathExists(binaryPath(fixture.baseDir))).toBe(true);
    const pipeline = exec.mock.calls[0]?.[1]?.[1] as string;
    expect(pipeline).toContain(`'\\''`);
  });

  it('returns already_installed without re-running the pipeline', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    mkdirSync(dataDir(fixture.baseDir), { recursive: true });
    writeFileSync(binaryPath(fixture.baseDir), 'binary');
    const exec = vi.spyOn(runtime.process, 'exec');

    const result = await installExpansion(PACKAGE, { runtime });

    expect(result).toMatchObject({ status: 'already_installed', command: binaryPath(fixture.baseDir) });
    expect(exec).not.toHaveBeenCalled();
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

  it('runs the install pipeline for update when not yet installed', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const exec = stubSuccessfulInstall(runtime);

    const result = await installExpansion(PACKAGE, { runtime, update: true });

    expect(result).toMatchObject({ status: 'updated', command: binaryPath(fixture.baseDir) });
    expect(exec.mock.calls[0]?.[1]?.[1] as string).toContain('install.sh');
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
    vi.spyOn(runtime.process, 'exec').mockImplementation(async (_command, args) => {
      const dir = extractDir(args[1] ?? '');
      await blocker.promise;
      writeFileSync(join(dir, BINARY), 'binary');
      return { stdout: '', stderr: '', status: 0 };
    });

    const first = installExpansion(PACKAGE, { runtime, lockTimeoutMs: 25 });
    await waitForCondition(() =>
      pathExists(enginePaths('prod', { baseDir: fixture.baseDir }).installLockPath(PACKAGE)),
    );

    const second = await installExpansion(PACKAGE, { runtime, lockTimeoutMs: 25 });
    blocker.resolve();

    expect(installResponseSchema.parse(second)).toMatchObject({
      status: 'error',
      code: 'expansion_install_lock_contended',
      context: { name: PACKAGE },
    });
    expect((await first).status).toBe('installed');
  });

  it('rechecks installed state after a concurrent direct install releases the package lock', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const installer = resolveInstallOnlyManifest(PACKAGE)?.installer;
    if (installer === undefined) {
      throw new Error('expected install-only package');
    }
    const firstEntered = createDeferred<void>();
    const finishFirst = createDeferred<void>();
    const exec = vi.spyOn(runtime.process, 'exec').mockImplementation(async (_command, args) => {
      firstEntered.resolve();
      await finishFirst.promise;
      writeFileSync(join(extractDir(args[1] ?? ''), BINARY), 'binary');
      return { stdout: '', stderr: '', status: 0 };
    });
    const options = { name: PACKAGE, version: 'latest', runtime, lockTimeoutMs: 1000 };

    const first = installer.install(options);
    await firstEntered.promise;
    const second = installer.install(options);
    finishFirst.resolve();

    await expect(first).resolves.toMatchObject({ status: 'installed' });
    await expect(second).resolves.toMatchObject({ status: 'already_installed' });
    expect(exec).toHaveBeenCalledOnce();
  });

  it('waits for a concurrent direct install before deciding whether to uninstall', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const installer = resolveInstallOnlyManifest(PACKAGE)?.installer;
    if (installer === undefined) {
      throw new Error('expected install-only package');
    }
    const installEntered = createDeferred<void>();
    const finishInstall = createDeferred<void>();
    vi.spyOn(runtime.process, 'exec').mockImplementation(async (_command, args) => {
      const shellCommand = args[1] ?? '';
      if (shellCommand.includes('install.sh')) {
        installEntered.resolve();
        await finishInstall.promise;
        writeFileSync(join(extractDir(shellCommand), BINARY), 'binary');
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    const options = { name: PACKAGE, version: 'latest', runtime, lockTimeoutMs: 1000 };

    const installing = installer.install(options);
    await installEntered.promise;
    const uninstalling = installer.uninstall(options);
    finishInstall.resolve();

    await expect(installing).resolves.toMatchObject({ status: 'installed' });
    await expect(uninstalling).resolves.toMatchObject({ status: 'uninstalled' });
    expect(pathExists(dataDir(fixture.baseDir))).toBe(false);
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

  it('inspects installed state from the binary presence', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    expect(inspectExpansionInstallState(runtime, PACKAGE).installed).toBe(false);

    mkdirSync(dataDir(fixture.baseDir), { recursive: true });
    writeFileSync(binaryPath(fixture.baseDir), 'binary');

    expect(inspectExpansionInstallState(runtime, PACKAGE)).toMatchObject({
      installed: true,
      method: 'shell',
      addonPath: binaryPath(fixture.baseDir),
    });
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

  it('still removes the binary when the binary uninstall subcommand fails', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    mkdirSync(dataDir(fixture.baseDir), { recursive: true });
    writeFileSync(binaryPath(fixture.baseDir), 'binary');
    vi.spyOn(runtime.process, 'exec').mockRejectedValue(new Error('spawn failed'));

    expect(await uninstallExpansion(PACKAGE, { runtime })).toEqual({ status: 'uninstalled' });
    expect(pathExists(dataDir(fixture.baseDir))).toBe(false);
  });

  it('reports not_equipped when uninstalling an absent package', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);

    expect(await uninstallExpansion(PACKAGE, { runtime })).toEqual({ status: 'not_equipped' });
  });
});
