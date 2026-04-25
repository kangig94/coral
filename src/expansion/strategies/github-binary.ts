import { dirname, join } from 'node:path';

import type { InstallResult } from '../contracts.js';
import {
  downloadBuffer,
  fetchLatestReleaseTag,
  findCommand,
  readInstallMeta,
  toolsDirForHome,
  writeInstallMeta,
} from './install-support.js';
import {
  logStrategyEvent,
  type ExpansionInstallContext,
  type Strategy,
  type StrategyInstallOptions,
} from './strategy.js';
import { nowIsoString } from '../../infra/time.js';

export type GithubBinaryConfig = {
  name: string;
  repo: string;
  fallbackVersion: string;
  binaries: Record<string, string>;
  pip?: string;
};

export type BinaryAtomicWriter = (ctx: ExpansionInstallContext, dest: string, content: Buffer, mode?: number) => void;

export type GithubBinaryDeps = {
  arch(): string;
  downloadBuffer(runtime: ExpansionInstallContext['runtime'], url: string): Promise<Buffer>;
  fetchLatestReleaseTag(runtime: ExpansionInstallContext['runtime'], repo: string): Promise<string | null>;
  writeBinaryAtomic(ctx: ExpansionInstallContext, dest: string, content: Buffer, mode?: number): void;
};

type GithubBinaryExternalInstallMeta = {
  method: 'system';
  command: string;
  detectedAt: string;
};

export type GithubBinaryInstallState = {
  installed: boolean;
  method: string | null;
  version: string | null;
  command: string | null;
};

export function writeBinaryAtomic(ctx: ExpansionInstallContext, dest: string, content: Buffer, mode?: number): void {
  const partialPath = `${dest}.part`;
  ctx.runtime.storage.mkdirSync(dirname(dest), { recursive: true });
  ctx.runtime.storage.rmSync(partialPath, { force: true });

  try {
    ctx.runtime.storage.writeFileSync(partialPath, content, mode === undefined ? undefined : { mode });
    if (mode !== undefined) {
      ctx.runtime.storage.chmodSync(partialPath, mode);
    }
    ctx.runtime.storage.renameSync(partialPath, dest);
  } catch (error) {
    ctx.runtime.storage.rmSync(partialPath, { force: true });
    throw error;
  }
}

export class GithubBinaryStrategy implements Strategy<GithubBinaryConfig> {
  private readonly deps: GithubBinaryDeps;

  constructor(deps: Partial<GithubBinaryDeps> = {}) {
    this.deps = {
      arch: deps.arch ?? (() => process.arch),
      downloadBuffer: deps.downloadBuffer ?? downloadBuffer,
      fetchLatestReleaseTag: deps.fetchLatestReleaseTag ?? fetchLatestReleaseTag,
      writeBinaryAtomic: deps.writeBinaryAtomic ?? writeBinaryAtomic,
    };
  }

  async install(
    ctx: ExpansionInstallContext,
    config: GithubBinaryConfig,
    opts: StrategyInstallOptions = {},
  ): Promise<InstallResult> {
    const hadExistingInstall = hasBinaryArtifacts(ctx, config);
    const platformName = ctx.runtime.env.platform();
    const platformKey = `${platformName}-${this.deps.arch()}`;
    const assetName = config.binaries[platformKey];
    const commandPath = binaryPathFor(ctx, config);
    const installState = inspectGithubBinaryInstall(ctx, config);
    const installedMeta = readBinaryInstallMeta(ctx, config);

    if (!opts.update) {
      if (installState.installed) {
        return {
          status: 'already_installed',
          method: installState.method ?? 'binary',
          ...(installState.version === null ? {} : { version: installState.version }),
          ...(installState.command === null ? {} : { command: installState.command }),
        };
      }

      const systemPath = findCommand(ctx.runtime, config.name);
      if (systemPath) {
        writeExternalInstallMeta(ctx, config, systemPath);
        return {
          status: 'already_installed',
          method: 'system',
          command: systemPath,
        };
      }
    }

    const targetVersion = (await this.deps.fetchLatestReleaseTag(ctx.runtime, config.repo)) ?? config.fallbackVersion;

    if (opts.update && isInstalledBinary(ctx, config) && installedMeta?.version === targetVersion) {
      return {
        status: 'already_up_to_date',
        method: installedMeta.method,
        version: targetVersion,
        command: commandPath,
      };
    }

    if (!assetName) {
      throw new Error(`No GitHub binary configured for ${config.name} on ${platformKey}.`);
    }

    const url = `https://github.com/${config.repo}/releases/download/${targetVersion}/${assetName}`;
    logStrategyEvent(ctx, 'expansion.install.download', `Downloading ${url}`);
    const binaryBytes = await this.deps.downloadBuffer(ctx.runtime, url);
    this.deps.writeBinaryAtomic(ctx, commandPath, binaryBytes, platformName === 'win32' ? undefined : 0o755);
    writeBinaryInstallMeta(ctx, config, targetVersion);
    deleteExternalInstallMeta(ctx, config);

    return {
      status: hadExistingInstall || opts.update ? 'updated' : 'installed',
      method: 'binary',
      version: targetVersion,
      command: commandPath,
    };
  }

  async uninstall(ctx: ExpansionInstallContext, config: GithubBinaryConfig): Promise<InstallResult> {
    const hadArtifacts = hasBinaryArtifacts(ctx, config);
    ctx.runtime.storage.rmSync(ctx.runtime.paths.coral.equipment.dataDir(config.name), { recursive: true, force: true });
    try {
      ctx.runtime.storage.unlinkSync(binaryPathFor(ctx, config));
    } catch {
      /* empty */
    }
    try {
      ctx.runtime.storage.unlinkSync(metaPathFor(ctx, config));
    } catch {
      /* empty */
    }

    return { status: hadArtifacts ? 'uninstalled' : 'not_equipped' };
  }

  isInstalled(ctx: ExpansionInstallContext, config: GithubBinaryConfig): boolean {
    return inspectGithubBinaryInstall(ctx, config).installed;
  }

  currentVersion(ctx: ExpansionInstallContext, config: GithubBinaryConfig): string | null {
    return inspectGithubBinaryInstall(ctx, config).version;
  }
}

export const githubBinaryStrategy = new GithubBinaryStrategy();

export function inspectGithubBinaryInstall(
  ctx: ExpansionInstallContext,
  config: GithubBinaryConfig,
): GithubBinaryInstallState {
  const commandPath = binaryPathFor(ctx, config);
  const installedMeta = readBinaryInstallMeta(ctx, config);

  if (isInstalledBinary(ctx, config)) {
    return {
      installed: true,
      method: installedMeta?.method ?? 'binary',
      version: installedMeta?.version ?? null,
      command: commandPath,
    };
  }

  const externalInstall = readExternalInstallMeta(ctx, config);
  if (externalInstall !== null) {
    return {
      installed: true,
      method: externalInstall.method,
      version: null,
      command: externalInstall.command,
    };
  }

  return {
    installed: false,
    method: null,
    version: null,
    command: null,
  };
}

function binaryPathFor(ctx: ExpansionInstallContext, config: GithubBinaryConfig): string {
  const extension = ctx.runtime.env.platform() === 'win32' ? '.exe' : '';
  return join(toolsDirForHome(ctx.runtime.env.homedir()), `${config.name}${extension}`);
}

function metaPathFor(ctx: ExpansionInstallContext, config: GithubBinaryConfig): string {
  return join(toolsDirForHome(ctx.runtime.env.homedir()), `.${config.name}.json`);
}

function externalInstallPathFor(ctx: ExpansionInstallContext, config: GithubBinaryConfig): string {
  return join(ctx.runtime.paths.coral.equipment.dataDir(config.name), '.external-install.json');
}

function writeBinaryInstallMeta(ctx: ExpansionInstallContext, config: GithubBinaryConfig, version: string): void {
  writeInstallMeta(ctx.runtime.storage, metaPathFor(ctx, config), {
    version,
    method: 'binary',
  });
}

function readBinaryInstallMeta(
  ctx: ExpansionInstallContext,
  config: GithubBinaryConfig,
): { version: string; method: string } | null {
  return readInstallMeta(ctx.runtime.storage, [metaPathFor(ctx, config)]);
}

function readExternalInstallMeta(
  ctx: ExpansionInstallContext,
  config: GithubBinaryConfig,
): GithubBinaryExternalInstallMeta | null {
  try {
    const parsed = JSON.parse(
      ctx.runtime.storage.readFileSync(externalInstallPathFor(ctx, config), 'utf-8'),
    ) as Partial<GithubBinaryExternalInstallMeta>;

    if (
      parsed.method === 'system' &&
      typeof parsed.command === 'string' &&
      parsed.command.trim().length > 0 &&
      typeof parsed.detectedAt === 'string' &&
      parsed.detectedAt.trim().length > 0
    ) {
      return {
        method: 'system',
        command: parsed.command,
        detectedAt: parsed.detectedAt,
      };
    }
  } catch {
    /* empty */
  }

  return null;
}

function writeExternalInstallMeta(ctx: ExpansionInstallContext, config: GithubBinaryConfig, command: string): void {
  const targetDir = ctx.runtime.paths.coral.equipment.dataDir(config.name);
  const filePath = externalInstallPathFor(ctx, config);
  ctx.runtime.storage.mkdirSync(targetDir, { recursive: true });
  if (
    !ctx.runtime.storage.writeAtomicSync(
      filePath,
      JSON.stringify({
        method: 'system',
        command,
        detectedAt: nowIsoString(ctx.runtime.time),
      } satisfies GithubBinaryExternalInstallMeta),
      { encoding: 'utf-8' },
    )
  ) {
    throw new Error(`Atomic write failed: ${filePath}`);
  }
}

function deleteExternalInstallMeta(ctx: ExpansionInstallContext, config: GithubBinaryConfig): void {
  try {
    ctx.runtime.storage.unlinkSync(externalInstallPathFor(ctx, config));
  } catch {
    /* empty */
  }
}

function hasBinaryArtifacts(ctx: ExpansionInstallContext, config: GithubBinaryConfig): boolean {
  if (readBinaryInstallMeta(ctx, config) !== null) {
    return true;
  }

  if (readExternalInstallMeta(ctx, config) !== null) {
    return true;
  }

  try {
    return ctx.runtime.storage.statSync(binaryPathFor(ctx, config)).isFile();
  } catch {
    return false;
  }
}

function isInstalledBinary(ctx: ExpansionInstallContext, config: GithubBinaryConfig): boolean {
  try {
    return ctx.runtime.storage.statSync(binaryPathFor(ctx, config)).isFile();
  } catch {
    return false;
  }
}
