import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Runtime } from '#src/runtime/ports.js';
import type * as InstallHelpersModule from '#src/infra/install-helpers.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { installResponseSchema } from '#src/cli/expansion/contract.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { installExpansion, removeInstallArtifacts } from '#src/cli/expansion/install.js';
import { createDeferred } from '#tools/testing/deferred.js';

const mockState = vi.hoisted(() => ({
  downloadBuffer: vi.fn(),
}));

vi.mock('#src/infra/install-helpers.js', async () => {
  const actual = await vi.importActual<typeof InstallHelpersModule>('#src/infra/install-helpers.js');
  return {
    ...actual,
    downloadBuffer: mockState.downloadBuffer,
  };
});

const createdRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mockState.downloadBuffer.mockReset();
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

function createRuntimeForFixture(
  fixture: ReturnType<typeof createFixture>,
  options: { platform?: string; arch?: string } = {},
): Runtime {
  const realRuntime = createRealRuntime('prod');
  const envRecord: Record<string, string> = {
    HOME: fixture.homeDir,
    USERPROFILE: fixture.homeDir,
  };
  const fixtureEngine = enginePaths('prod', { baseDir: fixture.baseDir });
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  return {
    ...realRuntime,
    env: {
      ...realRuntime.env,
      get: (key) => envRecord[key],
      homedir: () => fixture.homeDir,
      platform: () => platform,
      arch: () => arch,
      cwd: () => fixture.root,
      fullSnapshot: () => envRecord,
      coralSnapshot: () => ({}),
    },
    paths: {
      ...realRuntime.paths,
      get coral() {
        return { ...realRuntime.paths.coral, engine: fixtureEngine };
      },
    },
  };
}

function needleAddonPath(baseDir: string): string {
  return join(enginePaths('prod', { baseDir }).dataDir('needle'), 'coral-needle.node');
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf-8').copy(header, offset, 0, length);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  Buffer.from(encoded, 'utf-8').copy(header, offset, 0, length);
}

function createPrebuildArchive(content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, 'coral-needle.node', 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, content.length, 124, 12);
  writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 'ustar', 257, 6);
  writeTarString(header, '00', 263, 2);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarOctal(header, checksum, 148, 8);

  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024, 0)]));
}

describe('installExpansion', () => {
  it('installs needle into the expansion path and writes install metadata', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture, { platform: 'linux', arch: 'arm64' });
    const addonBytes = Buffer.from('needle-addon');
    mockState.downloadBuffer.mockResolvedValue(createPrebuildArchive(addonBytes));

    const result = await installExpansion('needle', { runtime });

    expect(installResponseSchema.parse(result)).toEqual({
      status: 'installed',
      method: 'prebuild',
      version: '0.2.0',
      targetDir: enginePaths('prod', { baseDir: fixture.baseDir }).dataDir('needle'),
      postInstall: ['register_expansion'],
    });
    expect(readFileSync(needleAddonPath(fixture.baseDir))).toEqual(addonBytes);
    expect(mockState.downloadBuffer).toHaveBeenCalledWith(
      runtime,
      'https://github.com/kangig94/coral-needle/releases/download/v0.2.0/coral-needle-v0.2.0-linux-arm64.tar.gz',
    );
    expect(
      JSON.parse(
        readFileSync(
          join(enginePaths('prod', { baseDir: fixture.baseDir }).dataDir('needle'), '.needle-meta.json'),
          'utf-8',
        ),
      ),
    ).toEqual({ version: '0.2.0', method: 'prebuild' });
    expect(pathExists(enginePaths('prod', { baseDir: fixture.baseDir }).installLockPath('needle'))).toBe(false);
  });

  it('falls back to source build through tracked async exec when the prebuild is unavailable', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture, { platform: 'linux', arch: 'x64' });
    const builtAddon = Buffer.from('source-built-addon');
    mockState.downloadBuffer.mockRejectedValue(new Error('prebuild missing'));
    const execSyncSpy = vi.spyOn(runtime.process, 'execSync').mockImplementation(() => {
      throw new Error('execSync should not be used by needle install.');
    });
    const execSpy = vi.spyOn(runtime.process, 'exec').mockImplementation(async (command, args, options) => {
      if (command === 'which' && args[0] === 'cmake') {
        return { stdout: '/usr/bin/cmake\n', stderr: '', status: 0 };
      }
      if (command === 'git' && args[0] === 'clone') {
        mkdirSync(join(options?.cwd ?? '', 'src'), { recursive: true });
        return { stdout: '', stderr: '', status: 0 };
      }
      if (command === '/usr/bin/cmake' && args.join(' ') === '-B build .') {
        return { stdout: '', stderr: '', status: 0 };
      }
      if (command === '/usr/bin/cmake' && args.join(' ') === '--build build --config Release') {
        const buildDir = join(options?.cwd ?? '', 'build');
        mkdirSync(buildDir, { recursive: true });
        writeFileSync(join(buildDir, 'coral-needle.node'), builtAddon);
        return { stdout: '', stderr: '', status: 0 };
      }
      throw new Error(`unexpected exec ${command} ${JSON.stringify(args)}`);
    });

    const result = await installExpansion('needle', { runtime });

    expect(result).toEqual({
      status: 'installed',
      method: 'source-build',
      version: '0.2.0',
      targetDir: enginePaths('prod', { baseDir: fixture.baseDir }).dataDir('needle'),
      postInstall: ['register_expansion'],
    });
    expect(readFileSync(needleAddonPath(fixture.baseDir))).toEqual(builtAddon);
    expect(execSyncSpy).not.toHaveBeenCalled();
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth', '1', '--branch', 'v0.2.0', 'https://github.com/kangig94/coral-needle.git', 'src'],
      expect.objectContaining({ inheritEnv: true, timeout: 120_000 }),
    );
    expect(execSpy).toHaveBeenCalledWith(
      '/usr/bin/cmake',
      ['-B', 'build', '.'],
      expect.objectContaining({ inheritEnv: true, timeout: 900_000 }),
    );
    expect(execSpy).toHaveBeenCalledWith(
      '/usr/bin/cmake',
      ['--build', 'build', '--config', 'Release'],
      expect.objectContaining({ inheritEnv: true, timeout: 900_000 }),
    );
  });

  it('returns a structured unknown_expansion error for names outside the bundled manifest', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);

    const result = await installExpansion('missing-package', { runtime });

    expect(installResponseSchema.parse(result)).toMatchObject({
      status: 'error',
      code: 'unknown_expansion',
      context: { name: 'missing-package' },
    });
  });

  it('returns already_up_to_date when the installed addon already matches the bundled version', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const targetDir = enginePaths('prod', { baseDir: fixture.baseDir }).dataDir('needle');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(needleAddonPath(fixture.baseDir), Buffer.from('addon'));
    writeFileSync(
      join(targetDir, '.needle-meta.json'),
      JSON.stringify({ version: '0.2.0', method: 'prebuild' }),
      'utf-8',
    );

    const result = await installExpansion('needle', { runtime, update: true });

    expect(result).toEqual({
      status: 'already_up_to_date',
      method: 'prebuild',
      version: '0.2.0',
      targetDir,
      postInstall: ['register_expansion'],
    });
    expect(mockState.downloadBuffer).not.toHaveBeenCalled();
  });

  it('returns expansion_install_lock_contended when another install holds the runtime lock', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const blocker = createDeferred<void>();
    mockState.downloadBuffer.mockImplementation(async () => {
      await blocker.promise;
      return createPrebuildArchive(Buffer.from('addon'));
    });

    const firstInstall = installExpansion('needle', { runtime, lockTimeoutMs: 25 });
    await waitForCondition(() =>
      pathExists(enginePaths('prod', { baseDir: fixture.baseDir }).installLockPath('needle')),
    );

    const secondInstall = await installExpansion('needle', { runtime, lockTimeoutMs: 25 });
    blocker.resolve();

    expect(installResponseSchema.parse(secondInstall)).toMatchObject({
      status: 'error',
      code: 'expansion_install_lock_contended',
      context: { name: 'needle' },
    });
    expect((await firstInstall).status).toBe('installed');
  });
});

describe('removeInstallArtifacts', () => {
  it('removes local expansion artifacts for uninstall cleanup', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const targetDir = runtime.paths.coral.engine.dataDir('needle');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'coral-needle.node'), Buffer.from('addon'));
    writeFileSync(
      join(targetDir, '.needle-meta.json'),
      JSON.stringify({ version: '0.2.0', method: 'prebuild' }),
      'utf-8',
    );

    await removeInstallArtifacts(runtime, 'needle');

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

async function waitForCondition(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
}
