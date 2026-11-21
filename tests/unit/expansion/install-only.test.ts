import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createCliExpansionActivation } from '#src/cli/expansion/index.js';
import * as expansionInstall from '#src/cli/expansion/install.js';
import { installExpansion, uninstallExpansion } from '#src/cli/expansion/install.js';
import { resolveInstallOnlyManifest } from '#src/expansion/install-only.js';
import { resolveEnvBudgetBytes } from '#src/infra/env-sanitize.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { resolveEquippedTools as resolveHookTools } from '../../../clients/hooks/lib/equip-tools.mjs';

const PACKAGE = 'codebase-memory';
const BINARY = 'codebase-memory-mcp';
const INSTALLER = 'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh';
const SUCCESS = { stdout: '', stderr: '', status: 0 };
const createdRoots: string[] = [];

beforeAll(() => {
  resolveEnvBudgetBytes();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function useMountTable(runtime: ReturnType<typeof createRealRuntime>, mounts = ''): void {
  const platform = runtime.env.platform() as NodeJS.Platform;
  const readIncarnation = runtime.process.readProcessIncarnation.bind(runtime.process);
  vi.spyOn(runtime.process, 'readProcessIncarnation').mockImplementation((pid) => readIncarnation(pid, platform));
  vi.spyOn(runtime.env, 'platform').mockReturnValue('linux');
  const readFile = runtime.storage.readFileSync.bind(runtime.storage);
  vi.spyOn(runtime.storage, 'readFileSync').mockImplementation((file, encoding) =>
    file === '/proc/self/mountinfo' ? `1 0 0:1 / / rw - ext4 /dev/root rw\n${mounts}` : readFile(file, encoding),
  );
  vi.spyOn(expansionInstall, 'resolveRuntime').mockReturnValue(runtime);
}

function createFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'coral-install-only-')));
  createdRoots.push(home);
  const pathDir = join(home, 'bin');
  vi.stubEnv('HOME', home);
  vi.stubEnv('PATH', pathDir);
  vi.stubEnv('CORAL_FLAVOR', 'prod');
  const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  useMountTable(runtime);
  return {
    runtime,
    pathBinary: join(pathDir, BINARY),
    standardBinary: join(home, '.local', 'bin', BINARY),
    legacyBinary: join(runtime.paths.coral.engine.dataDir(PACKAGE), BINARY),
  };
}

function seedBinary(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'binary', { mode: 0o755 });
}

describe('install-only codebase-memory', () => {
  it('returns expansion_install_lock_contended when another install holds the lock', async () => {
    const { runtime, standardBinary } = createFixture();
    const blocker = createDeferred<void>();
    const lockAcquired = createDeferred<void>();
    vi.spyOn(runtime.process, 'exec').mockImplementation(async () => {
      lockAcquired.resolve();
      await blocker.promise;
      seedBinary(standardBinary);
      return SUCCESS;
    });

    const first = installExpansion(PACKAGE, { runtime, lockTimeoutMs: 25 });
    await lockAcquired.promise;

    const second = await installExpansion(PACKAGE, { runtime, lockTimeoutMs: 25 });
    blocker.resolve();

    expect(second).toMatchObject({
      status: 'error',
      code: 'expansion_install_lock_contended',
      context: { name: PACKAGE },
    });
    expect((await first).status).toBe('installed');
  });

  it('uses the upstream defaults and verifies installation in the standard directory', async () => {
    const { runtime, standardBinary, legacyBinary } = createFixture();
    const exec = vi.spyOn(runtime.process, 'exec').mockImplementation(async () => {
      seedBinary(standardBinary);
      return SUCCESS;
    });

    const result = await installExpansion(PACKAGE, { runtime });
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      'bash',
      ['-o', 'pipefail', '-c', `curl -fsSL ${INSTALLER} | bash`],
      expect.objectContaining({ inheritEnv: true }),
    );
    expect(result).toMatchObject({ status: 'installed', command: standardBinary, targetDir: dirname(standardBinary) });
    expect(existsSync(dirname(legacyBinary))).toBe(false);
  });

  it('reports the first executable on PATH ahead of the standard copy and avoids a redundant install', async () => {
    const { runtime, pathBinary, standardBinary } = createFixture();
    seedBinary(pathBinary);
    seedBinary(standardBinary);
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue(SUCCESS);

    const cli = createCliExpansionActivation();
    expect(await cli.info(PACKAGE)).toMatchObject({
      status: 'info',
      package: {
        status: 'installed',
        command: pathBinary,
        targetDir: dirname(standardBinary),
        confirmDownload: expect.stringContaining('may create or overwrite the updater at ~/.local/bin/install.sh'),
      },
    });
    expect(await cli.list()).toMatchObject({
      status: 'catalog',
      packages: expect.arrayContaining([
        expect.objectContaining({ id: PACKAGE, command: pathBinary, targetDir: dirname(standardBinary) }),
      ]),
    });
    expect(await installExpansion(PACKAGE, { runtime })).toMatchObject({
      status: 'already_installed',
      command: pathBinary,
      targetDir: dirname(standardBinary),
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('uses the hook lookup for status and mutations without probing rejected PATH entries', async () => {
    const { pathBinary, standardBinary } = createFixture();
    const home = dirname(dirname(pathBinary));
    const remote = join(home, 'remote');
    const unknown = join(home, 'unknown');
    const symlinked = join(home, 'linked');
    seedBinary(pathBinary);
    seedBinary(join(remote, BINARY));
    seedBinary(join(unknown, BINARY));
    mkdirSync(symlinked);
    symlinkSync(pathBinary, join(symlinked, BINARY));
    vi.stubEnv('PATH', [remote, unknown, symlinked, dirname(pathBinary)].join(delimiter));
    const runtime = createRealRuntime('prod');
    useMountTable(runtime, `2 1 0:2 / ${remote} rw - nfs remote rw\n3 1 0:3 / ${unknown} rw - autofs auto rw\n`);
    const stat = vi.spyOn(runtime.storage, 'statSync');
    const lstat = vi.spyOn(runtime.storage, 'lstatSync');
    const access = vi.spyOn(runtime.storage, 'assertExecutableSync');
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue(SUCCESS);
    const cli = createCliExpansionActivation();

    expect(resolveHookTools(runtime.env, runtime.storage)).toEqual([expect.objectContaining({ id: PACKAGE })]);
    expect(await cli.info(PACKAGE)).toMatchObject({ status: 'info', package: { command: pathBinary } });
    expect(await cli.list()).toMatchObject({
      status: 'catalog',
      packages: expect.arrayContaining([expect.objectContaining({ id: PACKAGE, command: pathBinary })]),
    });
    expect(await cli.equip(PACKAGE)).toMatchObject({ status: 'already_installed', command: pathBinary });
    for (const result of [await cli.update(PACKAGE), await cli.unequip(PACKAGE)]) {
      expect(result).toMatchObject({ status: 'error', context: expect.objectContaining({ path: pathBinary }) });
    }
    expect(exec).not.toHaveBeenCalled();
    expect(access.mock.calls).toEqual(Array.from({ length: 6 }, () => [pathBinary]));
    for (const [file] of [...stat.mock.calls, ...lstat.mock.calls]) {
      for (const dir of [remote, unknown]) {
        expect(String(file) === dir || String(file).startsWith(dir + '/')).toBe(false);
      }
    }
    expect(stat).not.toHaveBeenCalledWith(join(symlinked, BINARY));
    expect(stat).not.toHaveBeenCalledWith(standardBinary);
  });

  it('updates the standard copy by rerunning the upstream installer', async () => {
    const { standardBinary } = createFixture();
    seedBinary(standardBinary);
    vi.stubEnv('PATH', dirname(standardBinary));
    const runtime = createRealRuntime('prod');
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue(SUCCESS);

    expect(await installExpansion(PACKAGE, { runtime, update: true })).toMatchObject({
      status: 'updated',
      command: standardBinary,
      targetDir: dirname(standardBinary),
    });
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      'bash',
      ['-o', 'pipefail', '-c', `curl -fsSL ${INSTALLER} | bash`],
      expect.objectContaining({ inheritEnv: true }),
    );
  });

  it('directs update and uninstall to the owner of the resolved external copy', async () => {
    const { runtime, pathBinary, standardBinary } = createFixture();
    seedBinary(pathBinary);
    seedBinary(standardBinary);
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue(SUCCESS);

    for (const result of [
      await installExpansion(PACKAGE, { runtime, update: true }),
      await uninstallExpansion(PACKAGE, { runtime }),
    ]) {
      expect(result).toMatchObject({ status: 'error', code: 'expansion_external_tool_managed' });
      expect(result).toHaveProperty('remediation', expect.stringContaining(pathBinary));
    }
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(pathBinary)).toBe(true);
    expect(existsSync(standardBinary)).toBe(true);
  });

  it('directs standard-copy uninstall to the tool without invoking it', async () => {
    const { runtime, standardBinary } = createFixture();
    seedBinary(standardBinary);
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue(SUCCESS);

    expect(await uninstallExpansion(PACKAGE, { runtime })).toMatchObject({
      status: 'error',
      code: 'expansion_external_tool_managed',
      remediation: expect.stringContaining(`'${standardBinary}' uninstall`),
    });
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(standardBinary)).toBe(true);
  });

  it('reports and migrates the legacy binary even when another copy is available on PATH', async () => {
    const { runtime, pathBinary, standardBinary, legacyBinary } = createFixture();
    seedBinary(legacyBinary);
    const unrelatedFile = join(dirname(legacyBinary), 'keep');
    writeFileSync(unrelatedFile, 'unrelated');
    const cli = createCliExpansionActivation();
    expect(await cli.info(PACKAGE)).toMatchObject({
      status: 'info',
      package: { status: 'not_installed', statusDescription: expect.stringContaining(legacyBinary) },
    });
    seedBinary(pathBinary);
    expect(await cli.info(PACKAGE)).toMatchObject({
      status: 'info',
      package: { status: 'installed', command: pathBinary, statusDescription: expect.stringContaining(legacyBinary) },
    });

    const exec = vi.spyOn(runtime.process, 'exec').mockImplementation(async () => {
      expect(existsSync(legacyBinary)).toBe(true);
      seedBinary(standardBinary);
      return SUCCESS;
    });
    expect(await installExpansion(PACKAGE, { runtime })).toMatchObject({
      status: 'installed',
      command: pathBinary,
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(existsSync(legacyBinary)).toBe(false);
    expect(existsSync(unrelatedFile)).toBe(true);
    const info = await cli.info(PACKAGE);
    expect(info).toMatchObject({ status: 'info', package: { command: pathBinary } });
    expect(info).not.toHaveProperty('package.statusDescription');
  });

  it.each(['package directory', 'engine root'])(
    'skips removal after the installer replaces the %s with a symlink',
    async (redirected) => {
      const { runtime, standardBinary, legacyBinary } = createFixture();
      seedBinary(legacyBinary);
      const parent = redirected === 'package directory' ? dirname(legacyBinary) : dirname(dirname(legacyBinary));
      const displaced = `${parent}-displaced`;
      const external = redirected === 'package directory' ? join(displaced, BINARY) : join(displaced, PACKAGE, BINARY);
      vi.spyOn(runtime.process, 'exec').mockImplementation(async () => {
        seedBinary(standardBinary);
        renameSync(parent, displaced);
        symlinkSync(displaced, parent, 'dir');
        return SUCCESS;
      });

      const installer = resolveInstallOnlyManifest(PACKAGE)!.installer;
      expect(
        await installer.install({ runtime, name: PACKAGE, version: 'latest', operationLockHeld: true }),
      ).toMatchObject({
        status: 'installed',
        command: standardBinary,
        statusDescription: expect.stringContaining('symlinked or outside'),
      });
      expect(await createCliExpansionActivation().info(PACKAGE)).toMatchObject({
        status: 'info',
        package: { command: standardBinary, statusDescription: expect.stringContaining('symlinked or outside') },
      });
      expect(existsSync(external)).toBe(true);
      expect(existsSync(legacyBinary)).toBe(true);
    },
  );

  it('reports a retained legacy copy and uses the standard install without retrying cleanup', async () => {
    const { runtime, standardBinary, legacyBinary } = createFixture();
    const legacyDir = dirname(legacyBinary);
    const displaced = `${legacyDir}-displaced`;
    const external = join(displaced, BINARY);
    seedBinary(external);
    symlinkSync(displaced, legacyDir, 'dir');
    const exec = vi.spyOn(runtime.process, 'exec').mockImplementation(async () => {
      seedBinary(standardBinary);
      return SUCCESS;
    });
    const cli = createCliExpansionActivation();

    const before = await cli.info(PACKAGE);
    expect(before).toMatchObject({
      status: 'info',
      package: { status: 'not_installed', statusDescription: expect.stringContaining('symlink') },
    });
    expect(before).not.toHaveProperty('package.statusDescription', expect.stringContaining("Run '/equip"));
    const applied = await installExpansion(PACKAGE, { runtime });
    expect(applied).toMatchObject({
      status: 'installed',
      command: standardBinary,
      statusDescription: expect.stringContaining(legacyBinary),
    });
    expect(applied).toHaveProperty('statusDescription', expect.stringContaining('symlink'));
    if (applied.status !== 'installed') throw new Error('Expected the standard installation to succeed');
    const info = await cli.info(PACKAGE);
    expect(info).toMatchObject({
      status: 'info',
      package: {
        status: 'installed',
        command: standardBinary,
        statusDescription: applied.statusDescription,
      },
    });
    expect(await installExpansion(PACKAGE, { runtime })).toMatchObject({
      status: 'already_installed',
      command: standardBinary,
      statusDescription: applied.statusDescription,
    });
    expect(exec).toHaveBeenCalledOnce();
    expect(existsSync(external)).toBe(true);
  });

  it('preserves the binary when a directory symlink makes the standard and legacy paths aliases', async () => {
    const { runtime, standardBinary, legacyBinary } = createFixture();
    seedBinary(legacyBinary);
    mkdirSync(dirname(dirname(standardBinary)), { recursive: true });
    symlinkSync(dirname(legacyBinary), dirname(standardBinary), 'dir');
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue(SUCCESS);

    expect(await createCliExpansionActivation().info(PACKAGE)).toMatchObject({
      status: 'info',
      package: { statusDescription: expect.stringContaining('resolves to the legacy copy') },
    });
    expect(await installExpansion(PACKAGE, { runtime })).toMatchObject({
      status: 'error',
      code: 'expansion_install_command_failed',
      remediation: expect.stringContaining('resolves to the legacy copy'),
    });
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(legacyBinary)).toBe(true);
    expect(existsSync(standardBinary)).toBe(true);
  });

  it('preserves the legacy copy if the installer fails or leaves no usable standard binary', async () => {
    const { runtime, standardBinary, legacyBinary, pathBinary } = createFixture();
    seedBinary(legacyBinary);
    seedBinary(pathBinary);
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValueOnce({ ...SUCCESS, status: 1 });
    exec.mockImplementationOnce(async () => {
      mkdirSync(dirname(standardBinary), { recursive: true });
      writeFileSync(standardBinary, 'binary', { mode: 0o644 });
      return SUCCESS;
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await installExpansion(PACKAGE, { runtime })).toMatchObject({
        status: 'error',
        code: 'expansion_install_command_failed',
      });
      expect(existsSync(legacyBinary)).toBe(true);
    }
  });
});
