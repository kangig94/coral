import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type {
  EngineInstallLoggerEvent,
  EngineInstaller,
  EngineInstallerOptions,
  LocalExpansionInstallState,
} from '#src/expansion/contract.js';
import { errorMessage } from '#src/infra/error-format.js';
import { downloadBuffer } from '#src/infra/download.js';
import { ensureExecSucceeded, findCommand } from '#src/infra/exec-checks.js';
import { acquireDirectoryLock, isDirectoryLockTimeoutError } from '#src/infra/fs-lock.js';
import { readInstallMeta, writeInstallMeta } from './install-meta.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import type { Runtime } from '#src/runtime/ports.js';
import { NEEDLE_ADDON_FILENAME, needleAddonPath } from './paths.js';

const NEEDLE_ARCH_MAP: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
};
const NEEDLE_INSTALL_LOCK_TIMEOUT_MS = 250;
const NEEDLE_GITHUB_REPO = 'kangig94/coral-needle';
const NEEDLE_POST_INSTALL = ['register_expansion'] as const;

type InstallMethod = 'prebuild' | 'source-build';
type InstallError = {
  status: 'error';
  code: string;
  userMessage: string;
  remediation: string;
  context?: Record<string, unknown>;
};
type InstallResult =
  | {
      status: 'installed' | 'updated' | 'already_installed' | 'already_up_to_date';
      method: string;
      version: string;
      targetDir: string;
      postInstall: string[];
    }
  | { status: 'uninstalled' | 'not_equipped' };

type NeedleInstallContext = EngineInstallerOptions;

function logInstallEvent(ctx: NeedleInstallContext, kind: string, message: string): void {
  ctx.logger?.({ kind, message } satisfies EngineInstallLoggerEvent);
}

function metaPath(ctx: NeedleInstallContext): string {
  return join(ctx.runtime.paths.coral.engine.dataDir(ctx.name), `.${ctx.name}-meta.json`);
}

function writeInstalledMeta(ctx: NeedleInstallContext, method: InstallMethod): void {
  writeInstallMeta(ctx.runtime.storage, metaPath(ctx), { version: ctx.version, method });
}

function hasNonLockArtifacts(ctx: NeedleInstallContext): boolean {
  try {
    return ctx.runtime.storage
      .readdirSync(ctx.runtime.paths.coral.engine.dataDir(ctx.name), { withFileTypes: true })
      .some((entry) => entry.name !== 'install.lock');
  } catch {
    return false;
  }
}

function isAddonInstalled(runtime: Runtime): boolean {
  try {
    return runtime.storage.statSync(needleAddonPath(runtime)).isFile();
  } catch {
    return false;
  }
}

function isInstallLocked(runtime: Runtime, name: string): boolean {
  try {
    runtime.storage.statSync(runtime.paths.coral.engine.installLockPath(name));
    return true;
  } catch {
    return false;
  }
}

function buildInstalledResult(
  ctx: NeedleInstallContext,
  status: 'installed' | 'updated' | 'already_installed' | 'already_up_to_date',
  method: string,
): InstallResult {
  return {
    status,
    method,
    version: ctx.version,
    targetDir: ctx.runtime.paths.coral.engine.dataDir(ctx.name),
    postInstall: [...NEEDLE_POST_INSTALL],
  };
}

function toInstallError(code: Parameters<typeof documentedCoralSetupError>[0], name: string): InstallError {
  const error = documentedCoralSetupError(code, { name });
  return {
    status: 'error',
    code: error.code,
    userMessage: error.userMessage,
    remediation: error.remediation,
    ...(error.context === undefined ? {} : { context: error.context }),
  };
}

function isInstallPathUnwritableError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(String((error as NodeJS.ErrnoException).code))
  );
}

async function withInstallLock<T>(ctx: NeedleInstallContext, run: () => Promise<T>): Promise<T | InstallError> {
  const targetDir = ctx.runtime.paths.coral.engine.dataDir(ctx.name);
  const lockPath = ctx.runtime.paths.coral.engine.installLockPath(ctx.name);
  ctx.runtime.storage.mkdirSync(targetDir, { recursive: true });

  let release: () => void;
  try {
    release = await acquireDirectoryLock(
      lockPath,
      { storage: ctx.runtime.storage, time: ctx.runtime.time },
      ctx.lockTimeoutMs ?? NEEDLE_INSTALL_LOCK_TIMEOUT_MS,
    );
  } catch (error) {
    if (isDirectoryLockTimeoutError(error)) {
      return toInstallError('expansion_install_lock_contended', ctx.name);
    }
    throw error;
  }

  try {
    return await run();
  } finally {
    release();
  }
}

function needlePlatformKey(platformName: string, archName: string): string {
  return `${platformName}-${NEEDLE_ARCH_MAP[archName] ?? archName}`;
}

function tarFieldToString(buffer: Buffer): string {
  return buffer.toString('utf-8').replace(/\0.*$/, '').trim();
}

function tarFieldToNumber(buffer: Buffer): number {
  const raw = tarFieldToString(buffer);
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

function extractTarEntry(archiveBuffer: Buffer, expectedName: string): Buffer {
  const tarBuffer = gunzipSync(archiveBuffer);
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarFieldToString(header.subarray(0, 100));
    const prefix = tarFieldToString(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = tarFieldToNumber(header.subarray(124, 136));
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    offset += 512;
    const data = tarBuffer.subarray(offset, offset + size);
    if ((typeFlag === '0' || typeFlag === '') && (fullName === expectedName || fullName.endsWith(`/${expectedName}`))) {
      return Buffer.from(data);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error(`${expectedName} was not found in the downloaded archive.`);
}

function writeAddonAtomic(ctx: NeedleInstallContext, dest: string, content: Buffer): void {
  const partialPath = `${dest}.part`;
  ctx.runtime.storage.mkdirSync(dirname(dest), { recursive: true });
  ctx.runtime.storage.rmSync(partialPath, { force: true });
  try {
    ctx.runtime.storage.writeFileSync(partialPath, content);
    ctx.runtime.storage.renameSync(partialPath, dest);
  } catch (error) {
    ctx.runtime.storage.rmSync(partialPath, { force: true });
    throw error;
  }
}

async function ensureCmake(runtime: Runtime): Promise<string> {
  const existing = await findCommand(runtime, 'cmake');
  if (existing) return existing;
  const uv = await findCommand(runtime, 'uv');
  if (!uv) throw new Error('cmake is required for the source-build fallback, and uv is not installed to bootstrap it.');
  ensureExecSucceeded(
    uv,
    await runtime.process.exec(uv, ['tool', 'install', 'cmake'], { inheritEnv: true, timeout: 120_000 }),
  );
  const installed = await findCommand(runtime, 'cmake');
  if (!installed) throw new Error('uv reported cmake installed, but cmake is still unavailable on PATH.');
  return installed;
}

async function buildNeedleFromSource(ctx: NeedleInstallContext): Promise<Buffer> {
  const cmake = await ensureCmake(ctx.runtime);
  const buildDir = mkdtempSync(join(tmpdir(), 'coral-needle-build-'));
  try {
    const repoUrl = `https://github.com/${NEEDLE_GITHUB_REPO}.git`;
    const tag = `v${ctx.version}`;
    ensureExecSucceeded(
      'git',
      await ctx.runtime.process.exec('git', ['clone', '--depth', '1', '--branch', tag, repoUrl, 'src'], {
        cwd: buildDir,
        inheritEnv: true,
        timeout: 120_000,
      }),
    );
    const srcDir = join(buildDir, 'src');
    ensureExecSucceeded(
      cmake,
      await ctx.runtime.process.exec(cmake, ['-B', 'build', '.'], { cwd: srcDir, inheritEnv: true, timeout: 900_000 }),
    );
    ensureExecSucceeded(
      cmake,
      await ctx.runtime.process.exec(cmake, ['--build', 'build', '--config', 'Release'], {
        cwd: srcDir,
        inheritEnv: true,
        timeout: 900_000,
      }),
    );
    const builtAddon = [
      join(srcDir, 'build', NEEDLE_ADDON_FILENAME),
      join(srcDir, 'build', 'Release', NEEDLE_ADDON_FILENAME),
    ].find((candidate) => existsSync(candidate));
    if (!builtAddon) throw new Error(`The source build completed without producing ${NEEDLE_ADDON_FILENAME}.`);
    return readFileSync(builtAddon);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

async function installNeedlePrebuild(ctx: NeedleInstallContext): Promise<Buffer> {
  const releaseTag = `v${ctx.version}`;
  const assetName = `coral-needle-${releaseTag}-${needlePlatformKey(ctx.runtime.env.platform(), ctx.runtime.env.arch())}.tar.gz`;
  const url = `https://github.com/${NEEDLE_GITHUB_REPO}/releases/download/${releaseTag}/${assetName}`;
  logInstallEvent(ctx, 'expansion.install.download', `Downloading ${url}`);
  return extractTarEntry(await downloadBuffer(ctx.runtime, url), NEEDLE_ADDON_FILENAME);
}

export const needleInstaller: EngineInstaller = {
  inspect(runtime, name): LocalExpansionInstallState {
    const meta = readInstallMeta(runtime.storage, [
      join(runtime.paths.coral.engine.dataDir(name), `.${name}-meta.json`),
    ]);
    return {
      targetDir: runtime.paths.coral.engine.dataDir(name),
      addonPath: needleAddonPath(runtime),
      installLockPath: runtime.paths.coral.engine.installLockPath(name),
      version: meta?.version ?? null,
      method: meta?.method ?? null,
      installed: isAddonInstalled(runtime),
      installLocked: isInstallLocked(runtime, name),
      durableState: meta !== null || hasNonLockArtifacts({ name, version: '', runtime }),
    };
  },
  async install(ctx): Promise<unknown> {
    try {
      return await withInstallLock(ctx, async () => {
        const current = needleInstaller.inspect(ctx.runtime, ctx.name);
        if (
          current.installed &&
          current.version === ctx.version &&
          (current.method === 'prebuild' || current.method === 'source-build')
        ) {
          return buildInstalledResult(ctx, ctx.update ? 'already_up_to_date' : 'already_installed', current.method);
        }
        const hadExistingInstall = current.durableState;
        const addonPath = needleAddonPath(ctx.runtime);
        const failures: string[] = [];
        for (const method of ['prebuild', 'source-build'] as const) {
          try {
            const addonBytes =
              method === 'prebuild' ? await installNeedlePrebuild(ctx) : await buildNeedleFromSource(ctx);
            writeAddonAtomic(ctx, addonPath, addonBytes);
            writeInstalledMeta(ctx, method);
            return buildInstalledResult(ctx, hadExistingInstall || ctx.update ? 'updated' : 'installed', method);
          } catch (error) {
            if (isInstallPathUnwritableError(error)) throw error;
            failures.push(`${method}: ${errorMessage(error)}`);
            if (method === 'prebuild')
              logInstallEvent(ctx, 'expansion.install.prebuild_failed', failures[0] ?? 'prebuild failed');
          }
        }
        throw new Error(`Could not install ${ctx.name}: ${failures.join('; ')}`);
      });
    } catch (error: unknown) {
      if (isInstallPathUnwritableError(error)) return toInstallError('expansion_install_path_unwritable', ctx.name);
      throw error;
    }
  },
  async uninstall(ctx): Promise<unknown> {
    try {
      return await withInstallLock(ctx, async () => {
        const current = needleInstaller.inspect(ctx.runtime, ctx.name);
        rmSync(ctx.runtime.paths.coral.engine.dataDir(ctx.name), {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
        return { status: current.durableState ? 'uninstalled' : 'not_equipped' } satisfies InstallResult;
      });
    } catch (error: unknown) {
      if (isInstallPathUnwritableError(error)) return toInstallError('expansion_install_path_unwritable', ctx.name);
      throw error;
    }
  },
};
