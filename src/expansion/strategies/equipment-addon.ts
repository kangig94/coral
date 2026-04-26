import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { Onboarding, InstallResult } from '../contracts.js';
import { describeError, downloadBuffer, ensureExecSucceeded, findCommand, readInstallMeta, writeInstallMeta } from './install-support.js';
import { logStrategyEvent, type ExpansionInstallContext, type Strategy, type StrategyInstallOptions } from './strategy.js';

const NEEDLE_ARCH_MAP: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
};

type InstallMethod = 'prebuild' | 'source-build';

export type OnboardingSpec = Onboarding;

export type EquipmentAddonConfig = {
  name: string;
  repo: string;
  needleVersion: string;
  addonFilename: string;
  postInstall?: readonly string[];
  onboarding?: OnboardingSpec;
};

export type EquipmentAddonDeps = {
  arch(): string;
  downloadBuffer(runtime: ExpansionInstallContext['runtime'], url: string): Promise<Buffer>;
  installSourceBuild(
    runtime: ExpansionInstallContext['runtime'],
    config: EquipmentAddonConfig,
    version: string,
  ): Promise<Buffer>;
  writeAddonAtomic(ctx: ExpansionInstallContext, dest: string, content: Buffer): void;
};

export function writeAddonAtomic(ctx: ExpansionInstallContext, dest: string, content: Buffer): void {
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

export class EquipmentAddonStrategy implements Strategy<EquipmentAddonConfig> {
  private readonly deps: EquipmentAddonDeps;

  constructor(deps: Partial<EquipmentAddonDeps> = {}) {
    this.deps = {
      arch: deps.arch ?? (() => process.arch),
      downloadBuffer: deps.downloadBuffer ?? downloadBuffer,
      installSourceBuild: deps.installSourceBuild ?? buildNeedleFromSource,
      writeAddonAtomic: deps.writeAddonAtomic ?? writeAddonAtomic,
    };
  }

  async install(
    ctx: ExpansionInstallContext,
    config: EquipmentAddonConfig,
    opts: StrategyInstallOptions = {},
  ): Promise<InstallResult> {
    const targetDir = ctx.runtime.paths.coral.equipment.dataDir(config.name);
    const addonPath = ctx.runtime.paths.coral.equipment.addonPath(config.name);
    const hadExistingInstall = hasEquipmentArtifacts(ctx, config);
    const installedMeta = readEquipmentInstallMeta(ctx, config);
    const failures: string[] = [];

    if (
      isAddonInstalled(ctx, config)
      && installedMeta?.version === config.needleVersion
      && (installedMeta.method === 'prebuild' || installedMeta.method === 'source-build')
    ) {
      return buildAlreadyInstalledResult(
        opts.update ? 'already_up_to_date' : 'already_installed',
        targetDir,
        config,
        installedMeta.method,
      );
    }

    try {
      const addonBytes = await this.installPrebuild(ctx, config);
      this.deps.writeAddonAtomic(ctx, addonPath, addonBytes);
      writeEquipmentInstallMeta(ctx, config, 'prebuild');
      return buildInstallResult(hadExistingInstall, targetDir, config, 'prebuild', opts);
    } catch (error) {
      if (isInstallPathUnwritableError(error)) {
        throw error;
      }
      failures.push(`prebuild: ${describeError(error)}`);
      logStrategyEvent(ctx, 'expansion.install.prebuild_failed', failures[0] ?? 'prebuild failed');
    }

    try {
      const addonBytes = await this.deps.installSourceBuild(ctx.runtime, config, config.needleVersion);
      this.deps.writeAddonAtomic(ctx, addonPath, addonBytes);
      writeEquipmentInstallMeta(ctx, config, 'source-build');
      return buildInstallResult(hadExistingInstall, targetDir, config, 'source-build', opts);
    } catch (error) {
      if (isInstallPathUnwritableError(error)) {
        throw error;
      }
      failures.push(`source-build: ${describeError(error)}`);
    }

    throw new Error(`Could not install ${config.name}: ${failures.join('; ')}`);
  }

  async uninstall(ctx: ExpansionInstallContext, config: EquipmentAddonConfig): Promise<InstallResult> {
    const targetDir = ctx.runtime.paths.coral.equipment.dataDir(config.name);
    const hadArtifacts = hasEquipmentArtifacts(ctx, config);
    ctx.runtime.storage.rmSync(targetDir, { recursive: true, force: true });
    return { status: hadArtifacts ? 'uninstalled' : 'not_equipped' };
  }

  isInstalled(ctx: ExpansionInstallContext, config: EquipmentAddonConfig): boolean {
    try {
      return ctx.runtime.storage.statSync(ctx.runtime.paths.coral.equipment.addonPath(config.name)).isFile();
    } catch {
      return false;
    }
  }

  currentVersion(ctx: ExpansionInstallContext, config: EquipmentAddonConfig): string | null {
    return readEquipmentInstallMeta(ctx, config)?.version ?? null;
  }

  private async installPrebuild(ctx: ExpansionInstallContext, config: EquipmentAddonConfig): Promise<Buffer> {
    const releaseTag = `v${config.needleVersion}`;
    const assetBaseName = config.addonFilename.replace(/\.node$/, '');
    const assetName = `${assetBaseName}-${releaseTag}-${needlePlatformKey(ctx.runtime.env.platform(), this.deps.arch())}.tar.gz`;
    const url = `https://github.com/${config.repo}/releases/download/${releaseTag}/${assetName}`;
    logStrategyEvent(ctx, 'expansion.install.download', `Downloading ${url}`);
    const archiveBytes = await this.deps.downloadBuffer(ctx.runtime, url);
    return extractTarEntry(archiveBytes, config.addonFilename);
  }
}

export const equipmentAddonStrategy = new EquipmentAddonStrategy();

function buildInstallResult(
  hadExistingInstall: boolean,
  targetDir: string,
  config: EquipmentAddonConfig,
  method: InstallMethod,
  opts: StrategyInstallOptions,
): InstallResult {
  const payload = {
    method,
    version: config.needleVersion,
    targetDir,
    ...(config.postInstall === undefined
      ? {}
      : { postInstall: [...config.postInstall] as Array<'register_equipment'> }),
    ...(config.onboarding === undefined ? {} : { onboarding: config.onboarding }),
  };

  const status = hadExistingInstall || opts.update ? 'updated' : 'installed';
  return { status, ...payload };
}

function buildAlreadyInstalledResult(
  status: 'already_installed' | 'already_up_to_date',
  targetDir: string,
  config: EquipmentAddonConfig,
  method: InstallMethod,
): InstallResult {
  return {
    status,
    method,
    version: config.needleVersion,
    targetDir,
    ...(config.postInstall === undefined
      ? {}
      : { postInstall: [...config.postInstall] as Array<'register_equipment'> }),
    ...(config.onboarding === undefined ? {} : { onboarding: config.onboarding }),
  };
}

function needlePlatformKey(platformName: string, archName: string): string {
  return `${platformName}-${NEEDLE_ARCH_MAP[archName] ?? archName}`;
}

function equipmentMetaCandidates(ctx: ExpansionInstallContext, config: EquipmentAddonConfig): string[] {
  const targetDir = ctx.runtime.paths.coral.equipment.dataDir(config.name);
  return [join(targetDir, `.${config.name}-meta.json`)];
}

function readEquipmentInstallMeta(ctx: ExpansionInstallContext, config: EquipmentAddonConfig): {
  version: string;
  method: string;
} | null {
  return readInstallMeta(ctx.runtime.storage, equipmentMetaCandidates(ctx, config));
}

function writeEquipmentInstallMeta(ctx: ExpansionInstallContext, config: EquipmentAddonConfig, method: InstallMethod): void {
  const candidates = equipmentMetaCandidates(ctx, config);
  writeInstallMeta(ctx.runtime.storage, candidates[0], {
    version: config.needleVersion,
    method,
  });
}

function hasEquipmentArtifacts(ctx: ExpansionInstallContext, config: EquipmentAddonConfig): boolean {
  if (readEquipmentInstallMeta(ctx, config) !== null) {
    return true;
  }

  try {
    return ctx.runtime.storage.readdirSync(ctx.runtime.paths.coral.equipment.dataDir(config.name), { withFileTypes: true }).some((entry) => entry.name !== 'install.lock');
  } catch {
    return ctx.runtime.storage.existsSync(ctx.runtime.paths.coral.equipment.addonPath(config.name));
  }
}

function isAddonInstalled(ctx: ExpansionInstallContext, config: EquipmentAddonConfig): boolean {
  try {
    return ctx.runtime.storage.statSync(ctx.runtime.paths.coral.equipment.addonPath(config.name)).isFile();
  } catch {
    return false;
  }
}

function isInstallPathUnwritableError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && 'code' in error
    && ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(String((error as NodeJS.ErrnoException).code))
  );
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

async function buildNeedleFromSource(
  runtime: ExpansionInstallContext['runtime'],
  config: EquipmentAddonConfig,
  version: string,
): Promise<Buffer> {
  const cmake = ensureCmake(runtime);
  const buildDir = mkdtempSync(join(tmpdir(), 'coral-needle-build-'));

  try {
    const repoUrl = `https://github.com/${config.repo}.git`;
    const tag = `v${version}`;
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
      join(srcDir, 'build', config.addonFilename),
      join(srcDir, 'build', 'Release', config.addonFilename),
    ].find((candidate) => existsSync(candidate));

    if (!builtAddon) {
      throw new Error(`cmake build completed without producing ${config.addonFilename}.`);
    }

    return readFileSync(builtAddon);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

function ensureCmake(runtime: ExpansionInstallContext['runtime']): string {
  const existing = findCommand(runtime, 'cmake');
  if (existing) {
    return existing;
  }

  const uv = findCommand(runtime, 'uv');
  if (!uv) {
    throw new Error('cmake is required for needle source builds and uv is not installed.');
  }

  ensureExecSucceeded(
    uv,
    runtime.process.execSync(uv, ['tool', 'install', 'cmake'], {
      inheritEnv: true,
      timeout: 300_000,
    }),
  );

  const installed = findCommand(runtime, 'cmake');
  if (installed) {
    return installed;
  }

  const fallback = join(runtime.env.homedir(), '.local', 'bin', runtime.env.platform() === 'win32' ? 'cmake.exe' : 'cmake');
  if (existsSync(fallback)) {
    return fallback;
  }

  throw new Error('cmake is still unavailable after uv tool install cmake.');
}
