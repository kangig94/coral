import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { BUNDLED_EXPANSIONS } from '../../expansion/bundled.js';
import { resolveBuildFlavor } from '../../infra/build-flavor.js';
import { acquireDirectoryLock, isDirectoryLockTimeoutError } from '../../infra/fs-lock.js';
import { createRealRuntime } from '../../runtime/real.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Runtime } from '../../runtime/ports.js';
import { installErrorSchema, type InstallError, type InstallResponse, type InstallResult } from './contract.js';
import { describeError, downloadBuffer, ensureExecSucceeded, findCommand, readInstallMeta, writeInstallMeta } from './install-support.js';

const NEEDLE_ARCH_MAP: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
};

const NEEDLE_INSTALL_LOCK_TIMEOUT_MS = 250;
const NEEDLE_GITHUB_REPO = 'kangig94/coral-needle';
const NEEDLE_POST_INSTALL = ['register_expansion'] as const;
const NEEDLE_ENTRY = (() => {
  const entry = BUNDLED_EXPANSIONS.find((candidate) => candidate.id === 'needle');
  if (!entry) {
    throw new Error("BUNDLED_EXPANSIONS must include 'needle' before cli/expansion/install.ts loads.");
  }
  return entry;
})();

type InstallMethod = 'prebuild' | 'source-build';

export type ExpansionInstallLoggerEvent = {
  kind: string;
  message: string;
};

type ExpansionInstallContext = {
  readonly runtime: Runtime;
  readonly logger?: (event: ExpansionInstallLoggerEvent) => void;
};

export interface InstallExpansionOptions {
  readonly runtime?: Runtime;
  readonly logger?: ExpansionInstallContext['logger'];
  readonly lockTimeoutMs?: number;
  readonly update?: boolean;
}

export interface UninstallExpansionOptions {
  readonly runtime?: Runtime;
  readonly logger?: ExpansionInstallContext['logger'];
  readonly lockTimeoutMs?: number;
}

export type LocalExpansionInstallState = {
  readonly targetDir: string;
  readonly addonPath: string;
  readonly installLockPath: string;
  readonly version: string | null;
  readonly method: string | null;
  readonly installed: boolean;
  readonly installLocked: boolean;
  readonly durableState: boolean;
};

function createContext(
  runtime = createRealRuntime(resolveBuildFlavor(process.env)),
  logger?: ExpansionInstallContext['logger'],
): ExpansionInstallContext {
  return {
    runtime,
    ...(logger === undefined ? {} : { logger }),
  };
}

function logInstallEvent(ctx: ExpansionInstallContext, kind: string, message: string): void {
  ctx.logger?.({ kind, message });
}

function metaPath(ctx: ExpansionInstallContext, name: string): string {
  return join(ctx.runtime.paths.coral.engine.dataDir(name), `.${name}-meta.json`);
}

function readInstalledMeta(ctx: ExpansionInstallContext, name: string): { version: string; method: string } | null {
  return readInstallMeta(ctx.runtime.storage, [metaPath(ctx, name)]);
}

function writeInstalledMeta(ctx: ExpansionInstallContext, name: string, method: InstallMethod): void {
  writeInstallMeta(ctx.runtime.storage, metaPath(ctx, name), {
    version: NEEDLE_ENTRY.version,
    method,
  });
}

function hasNonLockArtifacts(ctx: ExpansionInstallContext, name: string): boolean {
  try {
    return ctx.runtime.storage
      .readdirSync(ctx.runtime.paths.coral.engine.dataDir(name), { withFileTypes: true })
      .some((entry) => entry.name !== 'install.lock');
  } catch {
    return false;
  }
}

function isAddonInstalled(ctx: ExpansionInstallContext, name: string): boolean {
  try {
    return ctx.runtime.storage.statSync(ctx.runtime.paths.coral.engine.addonPath(name, 'coral-needle.node')).isFile();
  } catch {
    return false;
  }
}

function isInstallLocked(ctx: ExpansionInstallContext, name: string): boolean {
  try {
    ctx.runtime.storage.statSync(ctx.runtime.paths.coral.engine.installLockPath(name));
    return true;
  } catch {
    return false;
  }
}

function buildInstalledResult(
  status: 'installed' | 'updated' | 'already_installed' | 'already_up_to_date',
  targetDir: string,
  method: string,
): InstallResult {
  return {
    status,
    method,
    version: NEEDLE_ENTRY.version,
    targetDir,
    postInstall: [...NEEDLE_POST_INSTALL],
  };
}

function toInstallError(code: Parameters<typeof documentedCoralSetupError>[0], name: string): InstallError {
  const error = documentedCoralSetupError(code, { name });
  return installErrorSchema.parse({
    status: 'error',
    code: error.code,
    userMessage: error.userMessage,
    remediation: error.remediation,
    ...(error.context === undefined ? {} : { context: error.context }),
  });
}

function isInstallPathUnwritableError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(String((error as NodeJS.ErrnoException).code))
  );
}

async function withInstallLock<T>(
  name: string,
  ctx: ExpansionInstallContext,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T | InstallError> {
  const targetDir = ctx.runtime.paths.coral.engine.dataDir(name);
  const lockPath = ctx.runtime.paths.coral.engine.installLockPath(name);
  ctx.runtime.storage.mkdirSync(targetDir, { recursive: true });

  let release: () => void;
  try {
    release = await acquireDirectoryLock(
      lockPath,
      {
        storage: ctx.runtime.storage,
        time: ctx.runtime.time,
      },
      timeoutMs,
    );
  } catch (error) {
    if (isDirectoryLockTimeoutError(error)) {
      return toInstallError('expansion_install_lock_contended', name);
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
    if (header.every((byte) => byte === 0)) {
      break;
    }

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

function writeAddonAtomic(ctx: ExpansionInstallContext, dest: string, content: Buffer): void {
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

function ensureCmake(runtime: Runtime): string {
  const existing = findCommand(runtime, 'cmake');
  if (existing) {
    return existing;
  }

  const uv = findCommand(runtime, 'uv');
  if (!uv) {
    throw new Error('cmake is required for the source-build fallback, and uv is not installed to bootstrap it.');
  }

  ensureExecSucceeded(
    uv,
    runtime.process.execSync(uv, ['tool', 'install', 'cmake'], {
      inheritEnv: true,
      timeout: 120_000,
    }),
  );

  const installed = findCommand(runtime, 'cmake');
  if (!installed) {
    throw new Error('uv reported cmake installed, but cmake is still unavailable on PATH.');
  }
  return installed;
}

async function buildNeedleFromSource(runtime: Runtime): Promise<Buffer> {
  const cmake = ensureCmake(runtime);
  const buildDir = mkdtempSync(join(tmpdir(), 'coral-needle-build-'));

  try {
    const repoUrl = `https://github.com/${NEEDLE_GITHUB_REPO}.git`;
    const tag = `v${NEEDLE_ENTRY.version}`;
    ensureExecSucceeded(
      'git',
      runtime.process.execSync('git', ['clone', '--depth', '1', '--branch', tag, repoUrl, 'src'], {
        cwd: buildDir,
        inheritEnv: true,
        timeout: 120_000,
      }),
    );

    const srcDir = join(buildDir, 'src');
    ensureExecSucceeded(
      cmake,
      runtime.process.execSync(cmake, ['-B', 'build', '.'], {
        cwd: srcDir,
        inheritEnv: true,
        timeout: 900_000,
      }),
    );
    ensureExecSucceeded(
      cmake,
      runtime.process.execSync(cmake, ['--build', 'build', '--config', 'Release'], {
        cwd: srcDir,
        inheritEnv: true,
        timeout: 900_000,
      }),
    );

    const builtAddon = [
      join(srcDir, 'build', 'coral-needle.node'),
      join(srcDir, 'build', 'Release', 'coral-needle.node'),
    ].find((candidate) => existsSync(candidate));

    if (!builtAddon) {
      throw new Error('The source build completed without producing coral-needle.node.');
    }

    return readFileSync(builtAddon);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

async function installNeedlePrebuild(ctx: ExpansionInstallContext): Promise<Buffer> {
  const releaseTag = `v${NEEDLE_ENTRY.version}`;
  const assetBaseName = 'coral-needle';
  const assetName = `${assetBaseName}-${releaseTag}-${needlePlatformKey(ctx.runtime.env.platform(), process.arch)}.tar.gz`;
  const url = `https://github.com/${NEEDLE_GITHUB_REPO}/releases/download/${releaseTag}/${assetName}`;
  logInstallEvent(ctx, 'expansion.install.download', `Downloading ${url}`);
  const archiveBytes = await downloadBuffer(ctx.runtime, url);
  return extractTarEntry(archiveBytes, 'coral-needle.node');
}

export function inspectExpansionInstallState(runtime: Runtime, name: string): LocalExpansionInstallState {
  const ctx = createContext(runtime);
  const installedMeta = readInstalledMeta(ctx, name);
  return {
    targetDir: runtime.paths.coral.engine.dataDir(name),
    addonPath: runtime.paths.coral.engine.addonPath(name, 'coral-needle.node'),
    installLockPath: runtime.paths.coral.engine.installLockPath(name),
    version: installedMeta?.version ?? null,
    method: installedMeta?.method ?? null,
    installed: isAddonInstalled(ctx, name),
    installLocked: isInstallLocked(ctx, name),
    durableState: installedMeta !== null || hasNonLockArtifacts(ctx, name),
  };
}

export async function installExpansion(name: string, opts: InstallExpansionOptions = {}): Promise<InstallResponse> {
  if (name !== 'needle') {
    return toInstallError('unknown_expansion', name);
  }

  const ctx = createContext(opts.runtime ?? createRealRuntime(resolveBuildFlavor(process.env)), opts.logger);
  try {
    return await withInstallLock(name, ctx, opts.lockTimeoutMs ?? NEEDLE_INSTALL_LOCK_TIMEOUT_MS, async () => {
      const current = inspectExpansionInstallState(ctx.runtime, name);
      if (
        current.installed &&
        current.version === NEEDLE_ENTRY.version &&
        (current.method === 'prebuild' || current.method === 'source-build')
      ) {
        return buildInstalledResult(
          opts.update ? 'already_up_to_date' : 'already_installed',
          current.targetDir,
          current.method,
        );
      }

      const hadExistingInstall = current.durableState;
      const addonPath = ctx.runtime.paths.coral.engine.addonPath(name, 'coral-needle.node');
      const failures: string[] = [];

      try {
        const addonBytes = await installNeedlePrebuild(ctx);
        writeAddonAtomic(ctx, addonPath, addonBytes);
        writeInstalledMeta(ctx, name, 'prebuild');
        return buildInstalledResult(
          hadExistingInstall || opts.update ? 'updated' : 'installed',
          current.targetDir,
          'prebuild',
        );
      } catch (error) {
        if (isInstallPathUnwritableError(error)) {
          throw error;
        }
        failures.push(`prebuild: ${describeError(error)}`);
        logInstallEvent(ctx, 'expansion.install.prebuild_failed', failures[0] ?? 'prebuild failed');
      }

      try {
        const addonBytes = await buildNeedleFromSource(ctx.runtime);
        writeAddonAtomic(ctx, addonPath, addonBytes);
        writeInstalledMeta(ctx, name, 'source-build');
        return buildInstalledResult(
          hadExistingInstall || opts.update ? 'updated' : 'installed',
          current.targetDir,
          'source-build',
        );
      } catch (error) {
        if (isInstallPathUnwritableError(error)) {
          throw error;
        }
        failures.push(`source-build: ${describeError(error)}`);
      }

      throw new Error(`Could not install ${name}: ${failures.join('; ')}`);
    });
  } catch (error: unknown) {
    if (isInstallPathUnwritableError(error)) {
      return toInstallError('expansion_install_path_unwritable', name);
    }
    throw error;
  }
}

export async function removeInstallArtifacts(runtime: Runtime, name: string): Promise<void> {
  rmSync(runtime.paths.coral.engine.dataDir(name), {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

export async function uninstallExpansion(name: string, opts: UninstallExpansionOptions = {}): Promise<InstallResponse> {
  if (name !== 'needle') {
    return toInstallError('unknown_expansion', name);
  }

  const ctx = createContext(opts.runtime ?? createRealRuntime(resolveBuildFlavor(process.env)), opts.logger);
  try {
    return await withInstallLock(name, ctx, opts.lockTimeoutMs ?? NEEDLE_INSTALL_LOCK_TIMEOUT_MS, async () => {
      const current = inspectExpansionInstallState(ctx.runtime, name);
      await removeInstallArtifacts(ctx.runtime, name);
      return { status: current.durableState ? 'uninstalled' : 'not_equipped' };
    });
  } catch (error: unknown) {
    if (isInstallPathUnwritableError(error)) {
      return toInstallError('expansion_install_path_unwritable', name);
    }
    throw error;
  }
}
