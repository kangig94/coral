import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Runtime } from '../../runtime/index.js';
import { createRealRuntime } from '../../runtime/real.js';
import { installResponseSchema } from '../contracts.js';
import { equipmentDataDir, equipmentInstallLockPath } from '../paths.js';
import { equipmentAddonStrategy } from '../strategies/equipment-addon.js';
import { installExpansion, removeInstallArtifacts } from '../install.js';

const createdRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-expansion-install-'));
  createdRoots.push(root);
  const homeDir = join(root, 'home');
  const baseDir = join(homeDir, '.coral');
  mkdirSync(homeDir, { recursive: true });
  return { root, homeDir, baseDir };
}

function createRuntimeForFixture(fixture: ReturnType<typeof createFixture>): Runtime {
  const realRuntime = createRealRuntime();
  const envRecord: Record<string, string> = {
    HOME: fixture.homeDir,
    USERPROFILE: fixture.homeDir,
  };

  return {
    ...realRuntime,
    env: {
      ...realRuntime.env,
      get: (key) => envRecord[key],
      homedir: () => fixture.homeDir,
      platform: () => process.platform,
      cwd: () => fixture.root,
      fullSnapshot: () => envRecord,
      coralSnapshot: () => ({}),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe('installExpansion', () => {
  it('resolves the catalog binding, creates the target dir, and dispatches to the strategy under the lock', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const installSpy = vi.spyOn(equipmentAddonStrategy, 'install').mockImplementation(async (ctx) => {
      expect(statSync(ctx.paths.equipmentDataDir('needle')).isDirectory()).toBe(true);
      expect(statSync(ctx.paths.equipmentInstallLockPath('needle')).isDirectory()).toBe(true);
      return {
        status: 'installed',
        method: 'prebuild',
        version: '0.2.0',
        targetDir: ctx.paths.equipmentDataDir('needle'),
        postInstall: ['register_equipment'],
      };
    });

    const result = await installExpansion('needle', { runtime });

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(installResponseSchema.parse(result)).toEqual({
      status: 'installed',
      method: 'prebuild',
      version: '0.2.0',
      targetDir: equipmentDataDir('needle', { baseDir: fixture.baseDir, env: runtime.env.fullSnapshot() }),
      postInstall: ['register_equipment'],
    });
    expect(pathExists(equipmentInstallLockPath('needle', { baseDir: fixture.baseDir, env: runtime.env.fullSnapshot() }))).toBe(
      false,
    );
  });

  it('returns a structured unknown_equipment error when the name is not in the catalog', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);

    const result = await installExpansion('missing-package', { runtime });

    expect(installResponseSchema.parse(result)).toMatchObject({
      status: 'error',
      code: 'unknown_equipment',
      context: { name: 'missing-package' },
    });
  });

  it('forwards update intent through the install dispatcher', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const installSpy = vi.spyOn(equipmentAddonStrategy, 'install').mockResolvedValue({
      status: 'already_up_to_date',
      method: 'prebuild',
      version: '0.2.0',
      targetDir: equipmentDataDir('needle', { baseDir: fixture.baseDir, env: runtime.env.fullSnapshot() }),
      postInstall: ['register_equipment'],
    });

    const result = await installExpansion('needle', { runtime, update: true });

    expect(result).toEqual({
      status: 'already_up_to_date',
      method: 'prebuild',
      version: '0.2.0',
      targetDir: equipmentDataDir('needle', { baseDir: fixture.baseDir, env: runtime.env.fullSnapshot() }),
      postInstall: ['register_equipment'],
    });
    expect(installSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), { update: true });
  });

  it('returns equipment_install_lock_contended when another install holds the lock', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const blocker = deferred<void>();
    const started = deferred<void>();
    const installSpy = vi.spyOn(equipmentAddonStrategy, 'install').mockImplementation(async () => {
      started.resolve();
      await blocker.promise;
      return {
        status: 'installed',
        method: 'prebuild',
        version: '0.2.0',
        targetDir: equipmentDataDir('needle', { baseDir: fixture.baseDir, env: runtime.env.fullSnapshot() }),
        postInstall: ['register_equipment'],
      };
    });

    const firstInstall = installExpansion('needle', { runtime, lockTimeoutMs: 25 });
    await started.promise;

    const secondInstall = await installExpansion('needle', { runtime, lockTimeoutMs: 25 });
    blocker.resolve();

    expect(installResponseSchema.parse(secondInstall)).toMatchObject({
      status: 'error',
      code: 'equipment_install_lock_contended',
      context: { name: 'needle' },
    });
    expect((await firstInstall).status).toBe('installed');
    expect(installSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the lock and rethrows strategy failures', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const installSpy = vi
      .spyOn(equipmentAddonStrategy, 'install')
      .mockRejectedValueOnce(new Error('simulated install failure'));

    await expect(installExpansion('needle', { runtime, lockTimeoutMs: 25 })).rejects.toThrow('simulated install failure');
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(pathExists(equipmentInstallLockPath('needle', { baseDir: fixture.baseDir, env: runtime.env.fullSnapshot() }))).toBe(
      false,
    );
  });
});

describe('removeInstallArtifacts', () => {
  it('removes local expansion artifacts for uninstall cleanup', async () => {
    const fixture = createFixture();
    const targetDir = equipmentDataDir('needle', { baseDir: fixture.baseDir });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'coral-needle.node'), Buffer.from('addon'));
    writeFileSync(join(targetDir, '.needle-meta.json'), JSON.stringify({ version: '0.2.0', method: 'prebuild' }), 'utf-8');
    vi.stubEnv('HOME', fixture.homeDir);
    vi.stubEnv('USERPROFILE', fixture.homeDir);

    await removeInstallArtifacts('needle');

    expect(pathExists(targetDir)).toBe(false);
  });

  it('removes the equipment data dir for github-binary cleanup', async () => {
    const fixture = createFixture();
    const targetDir = equipmentDataDir('cgc', { baseDir: fixture.baseDir });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'state.json'), '{"ok":true}', 'utf-8');
    vi.stubEnv('HOME', fixture.homeDir);
    vi.stubEnv('USERPROFILE', fixture.homeDir);

    await removeInstallArtifacts('cgc');

    expect(pathExists(targetDir)).toBe(false);
  });
});

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
