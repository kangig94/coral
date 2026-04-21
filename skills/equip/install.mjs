#!/usr/bin/env node
// Equip installer — downloads Coral companion tooling and runtime dependencies for Claude Code.
// Usage: node install.mjs [--list | [--update] <package> | uninstall <equipment-name>]
// Outputs a single JSON line to stdout.

import { execFileSync, execSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  equipmentAddonPath,
  equipmentDataDir,
  equipmentInstallLockPath,
} from './equipment-paths.mjs';
import {
  tryListEquipment,
  unregisterEquipment as unregisterCoordinatorEquipment,
} from './coordinator-client.mjs';
import {
  acquireDirectoryLock,
  isDirectoryLockTimeoutError,
} from './fs-lock.mjs';

const TOOLS_DIR = join(homedir(), '.claude', 'tools');
const NEEDLE_ARCH_MAP = { x64: 'amd64', arm64: 'arm64' };
const EQUIPMENT_INSTALL_LOCK_TIMEOUT_MS = 250;
const UNWRITABLE_ERRNOS = new Set(['EACCES', 'EROFS', 'EPERM', 'ENOSPC']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function needlePlatformKey() {
  return `${platform()}-${NEEDLE_ARCH_MAP[arch()] || arch()}`;
}

const NEEDLE_SECURITY_NOTICE = 'Store CORAL_EMBEDDING_API_KEY in ~/.coral/.env directly, NOT in settings.json.';
const NEEDLE_REQUIRED_ENV = [
  {
    provider: 'local-onnx',
    env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_MODEL'],
  },
  {
    provider: 'default',
    env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_API_KEY'],
  },
];
const NEEDLE_STATUS_DESCRIPTIONS = {
  equipped: 'Active in the coordinator.',
  catching_up: 'Registered and replaying the corpus.',
  inactive: 'Installed locally but not registered. Run /equip needle to reactivate.',
  unavailable: 'Binary missing. Run /equip needle to reinstall.',
  disabled_pending_reinstall: 'Load failed. Run /equip needle to reinstall.',
  installing: 'Another /equip is currently installing needle.',
  not_equipped: 'Needle is not installed.',
};
const NEEDLE_ONBOARDING_CHOICES = [
  {
    id: 'local-nomic-embed-text',
    label: 'Local model: nomic-embed-text',
    provider: 'local-onnx',
    model: 'nomic-embed-text',
    dims: 768,
  },
  {
    id: 'local-bge-m3',
    label: 'Local model: bge-m3',
    provider: 'local-onnx',
    model: 'bge-m3',
    dims: 1024,
  },
  {
    id: 'manual',
    label: 'Manual setup',
    provider: null,
    model: null,
    dims: null,
  },
];

function kbRuntimeDirFromEnv() {
  return join(homedir(), '.coral', 'data', 'kb');
}

function needleEquipmentDirFromEnv() {
  return equipmentDataDir('needle');
}

function coralEnvPathFromEnv() {
  return join(homedir(), '.coral', '.env');
}

function equipmentInstallRootLabel() {
  return `${dirname(needleEquipmentDirFromEnv())}/`;
}

const CATALOG = {
  cgc: {
    name: 'CodeGraphContext',
    description: 'Indexes code into a graph database for AI-powered analysis',
    repo: 'CodeGraphContext/CodeGraphContext',
    fallbackVersion: 'v0.3.1',
    binaries: {
      'linux-x64': 'cgc-linux-x64',
      'darwin-x64': 'cgc-macos-x64',
      'win32-x64': 'cgc-windows-x64.exe',
    },
    pip: 'codegraphcontext',
  },
  needle: {
    name: 'Knowledge Base Vector Runtime',
    description: 'Installs coral-needle native addon for vector search',
    repo: 'kangig94/coral-needle',
    needleVersion: '0.2.0',
    targetDir: () => needleEquipmentDirFromEnv(),
    postInstall: ['register_equipment'],
  },
};

function isNeedleCatalogEntry(entry) {
  return typeof entry.needleVersion === 'string';
}

function emit(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function findCmd(cmd) {
  try {
    const bin = platform() === 'win32' ? 'where' : 'which';
    return execSync(`${bin} ${cmd}`, { stdio: 'pipe', encoding: 'utf-8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

function download(url, dest) {
  const cmd = findCmd('curl')
    ? `curl -fsSL -o "${dest}" "${url}"`
    : `wget -q -O "${dest}" "${url}"`;
  execSync(cmd, { stdio: 'pipe', timeout: 120_000 });
}

function isUnwritableInstallPathError(error) {
  return error instanceof Error && UNWRITABLE_ERRNOS.has(error.code ?? '');
}

function buildSetupError(code, userMessage, remediation, context = undefined, extra = {}) {
  return {
    status: 'error',
    code,
    userMessage,
    remediation,
    ...(context === undefined ? {} : { context }),
    ...extra,
  };
}

function metaPath(pkg) {
  return join(TOOLS_DIR, `.${pkg}.json`);
}

function readMeta(pkg) {
  try { return JSON.parse(readFileSync(metaPath(pkg), 'utf-8')); }
  catch { return null; }
}

function writeMeta(pkg, version, method) {
  if (!existsSync(TOOLS_DIR)) mkdirSync(TOOLS_DIR, { recursive: true });
  writeFileSync(metaPath(pkg), JSON.stringify({ version, method }));
}

function targetMetaPath(targetDir) {
  return join(targetDir, '.needle-meta.json');
}

function legacyTargetMetaPath(targetDir) {
  return join(targetDir, '.kb-meta.json');
}

function readTargetMeta(targetDir) {
  for (const path of [targetMetaPath(targetDir), legacyTargetMetaPath(targetDir)]) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // Try the next metadata path.
    }
  }

  return null;
}

function writeTargetMeta(targetDir, version, method) {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetMetaPath(targetDir), JSON.stringify({ version, method }));
  rmSync(legacyTargetMetaPath(targetDir), { force: true });
}

function fetchLatest(repo) {
  try {
    const json = execSync(
      `curl -fsSL "https://api.github.com/repos/${repo}/releases/latest"`,
      { stdio: 'pipe', encoding: 'utf-8', timeout: 10_000 },
    );
    return JSON.parse(json).tag_name || null;
  } catch {
    return null;
  }
}

function resolveNeedleTargetVersion(entry, requestedVersion) {
  const needleVersion = entry.needleVersion;
  if (!needleVersion) {
    throw new Error('needle catalog entry is missing needleVersion');
  }
  if (requestedVersion && requestedVersion !== needleVersion) {
    throw new Error(`needle expects packaged version ${needleVersion}, not ${requestedVersion}`);
  }
  return needleVersion;
}

function buildKbOnboarding(runtimeDir) {
  return {
    envPath: coralEnvPathFromEnv(),
    requiredEnv: NEEDLE_REQUIRED_ENV,
    providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
    modelEnvKey: 'CORAL_EMBEDDING_MODEL',
    apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
    securityNotice: NEEDLE_SECURITY_NOTICE,
    localRuntime: {
      targetDir: runtimeDir,
      bootstrapPackageJson: true,
      packageManager: 'npm',
      packageName: 'onnxruntime-node',
    },
    choices: NEEDLE_ONBOARDING_CHOICES,
  };
}

function extractStructuredError(error) {
  const direct = isRecord(error)
    && typeof error.code === 'string'
    && typeof error.userMessage === 'string'
    && typeof error.remediation === 'string'
    ? {
        code: error.code,
        userMessage: error.userMessage,
        remediation: error.remediation,
        context: isRecord(error.context) ? error.context : undefined,
      }
    : null;

  if (direct !== null) {
    return direct;
  }

  if (error instanceof Error) {
    return extractStructuredError(error.cause);
  }

  return null;
}

function coordinatorErrorJson(error, fallbackMessage, suggestions = []) {
  const structured = extractStructuredError(error);
  if (structured !== null) {
    return {
      status: 'error',
      code: structured.code,
      userMessage: structured.userMessage,
      remediation: structured.remediation,
      ...(structured.context === undefined ? {} : { context: structured.context }),
      ...(suggestions.length === 0 ? {} : { suggestions }),
    };
  }

  return {
    status: 'error',
    message: fallbackMessage ?? (error instanceof Error ? error.message : String(error)),
    ...(suggestions.length === 0 ? {} : { suggestions }),
  };
}

function buildErrorResult(message, suggestions = [], extra = {}) {
  return {
    status: 'error',
    message,
    ...(suggestions.length === 0 ? {} : { suggestions }),
    ...extra,
  };
}

function resolveLocalNeedleStatus(entry) {
  const targetDir = entry.targetDir();
  if (existsSync(equipmentInstallLockPath('needle'))) {
    return 'installing';
  }

  return existsSync(equipmentAddonPath('needle')) || readTargetMeta(targetDir) !== null
    ? 'inactive'
    : 'not_equipped';
}

function resolveNeedleCatalogStatus(entry, equipmentView) {
  if (!isRecord(equipmentView) || typeof equipmentView.status !== 'string') {
    return resolveLocalNeedleStatus(entry);
  }

  return equipmentView.status;
}

async function buildCatalogPackages() {
  const coordinatorEquipment = await tryListEquipment({});
  const equipmentByName = new Map(
    Array.isArray(coordinatorEquipment?.equipment)
      ? coordinatorEquipment.equipment
          .filter((item) => isRecord(item) && typeof item.name === 'string')
          .map((item) => [item.name, item])
      : [],
  );

  return Object.entries(CATALOG).map(([id, item]) => {
    if (!isNeedleCatalogEntry(item)) {
      return {
        id,
        name: item.name,
        description: item.description,
      };
    }

    const status = resolveNeedleCatalogStatus(item, equipmentByName.get(id));
    return {
      id,
      name: item.name,
      description: item.description,
      status,
      ...(Object.hasOwn(NEEDLE_STATUS_DESCRIPTIONS, status)
        ? { statusDescription: NEEDLE_STATUS_DESCRIPTIONS[status] }
        : {}),
    };
  });
}

function tarFieldToString(buffer) {
  return buffer.toString('utf-8').replace(/\0.*$/, '').trim();
}

function tarFieldToNumber(buffer) {
  const raw = tarFieldToString(buffer);
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

function extractTarEntry(archivePath, expectedName) {
  const tarBuffer = gunzipSync(readFileSync(archivePath));
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

  throw new Error(`${expectedName} was not found in ${archivePath}`);
}

function installNeedlePrebuild(entry, targetDir, version, platKey) {
  const releaseTag = `v${version}`;
  const assetName = `coral-needle-${releaseTag}-${platKey}.tar.gz`;
  const tempDir = mkdtempSync(join(tmpdir(), 'coral-needle-prebuild-'));

  try {
    const archivePath = join(tempDir, assetName);
    const addonPath = equipmentAddonPath('needle');
    const partialAddonPath = `${addonPath}.part`;
    download(`https://github.com/${entry.repo}/releases/download/${releaseTag}/${assetName}`, archivePath);
    mkdirSync(dirname(addonPath), { recursive: true });
    rmSync(partialAddonPath, { force: true });
    try {
      writeFileSync(partialAddonPath, extractTarEntry(archivePath, 'coral-needle.node'));
      renameSync(partialAddonPath, addonPath);
    } catch (error) {
      rmSync(partialAddonPath, { force: true });
      throw error;
    }
    writeTargetMeta(targetDir, version, 'prebuild');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function ensureCmake() {
  const existing = findCmd('cmake');
  if (existing) {
    return existing;
  }

  const uv = findCmd('uv');
  if (!uv) {
    throw new Error('cmake is required for needle source builds and uv is not installed.');
  }

  execFileSync(uv, ['tool', 'install', 'cmake'], {
    stdio: 'pipe',
    timeout: 300_000,
  });

  const installed = findCmd('cmake');
  if (installed) {
    return installed;
  }

  const fallback = join(homedir(), '.local', 'bin', platform() === 'win32' ? 'cmake.exe' : 'cmake');
  if (existsSync(fallback)) {
    return fallback;
  }

  throw new Error('cmake is still unavailable after uv tool install cmake.');
}

function installNeedleSourceBuild(entry, targetDir, version) {
  const cmake = ensureCmake();
  const buildDir = mkdtempSync(join(tmpdir(), 'coral-needle-build-'));

  try {
    const repoUrl = `https://github.com/${entry.repo}.git`;
    const tag = `v${version}`;
    execSync(`git clone --depth 1 --branch ${tag} ${repoUrl} src`, {
      cwd: buildDir,
      stdio: 'pipe',
      timeout: 120_000,
    });

    const srcDir = join(buildDir, 'src');
    execFileSync(cmake, ['-B', 'build', '.'], {
      cwd: srcDir,
      stdio: 'pipe',
      timeout: 900_000,
    });
    execFileSync(cmake, ['--build', 'build', '--config', 'Release'], {
      cwd: srcDir,
      stdio: 'pipe',
      timeout: 900_000,
    });

    const builtAddon = [
      join(srcDir, 'build', 'coral-needle.node'),
      join(srcDir, 'build', 'Release', 'coral-needle.node'),
    ].find((candidate) => existsSync(candidate));

    if (!builtAddon) {
      throw new Error('cmake build completed without producing coral-needle.node.');
    }

    const addonPath = equipmentAddonPath('needle');
    const partialAddonPath = `${addonPath}.part`;
    mkdirSync(dirname(addonPath), { recursive: true });
    rmSync(partialAddonPath, { force: true });
    try {
      copyFileSync(builtAddon, partialAddonPath);
      renameSync(partialAddonPath, addonPath);
    } catch (error) {
      rmSync(partialAddonPath, { force: true });
      throw error;
    }
    writeTargetMeta(targetDir, version, 'source-build');
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

function buildResult(status, method, cmdPath, entry, extra) {
  return {
    status,
    method,
    command: cmdPath,
    ...extra,
  };
}

function buildTargetResult(status, method, targetDir, entry, extra) {
  return {
    status,
    method,
    targetDir,
    ...(entry.postInstall ? { postInstall: entry.postInstall } : {}),
    ...(isNeedleCatalogEntry(entry) ? { onboarding: buildKbOnboarding(kbRuntimeDirFromEnv()) } : {}),
    ...extra,
  };
}

export async function runInstallCommand(argv = process.argv.slice(2)) {
  const hasUninstallSubcommand = argv[0] === 'uninstall';
  const uninstallTarget = hasUninstallSubcommand ? argv[1] : null;
  const update = argv.includes('--update');
  const rawPkg = argv.find((arg) => !arg.startsWith('-'));

  if (hasUninstallSubcommand) {
    if (!uninstallTarget) {
      return {
        exitCode: 1,
        result: buildErrorResult(
          'uninstall requires a package name',
          ["Use '/equip uninstall needle'."],
        ),
      };
    }

    try {
      const result = await unregisterCoordinatorEquipment({ name: uninstallTarget });
      return {
        exitCode: 0,
        result: {
          ...result,
          name: uninstallTarget,
        },
      };
    } catch (error) {
      return {
        exitCode: 1,
        result: coordinatorErrorJson(
          error,
          `Could not uninstall ${uninstallTarget}`,
          [`Check that the Coral coordinator is running, then retry '/equip uninstall ${uninstallTarget}'.`],
        ),
      };
    }
  }

  if (argv.includes('--list') || (!rawPkg && !update)) {
    try {
      return {
        exitCode: 0,
        result: {
          status: 'catalog',
          packages: await buildCatalogPackages(),
        },
      };
    } catch (error) {
      return {
        exitCode: 1,
        result: coordinatorErrorJson(
          error,
          'Could not list equipment catalog',
          ["Check that the Coral coordinator is running, then retry '/equip --list'."],
        ),
      };
    }
  }

  if (!rawPkg) {
    return {
      exitCode: 1,
      result: buildErrorResult(
        '--update requires a package name',
        ["Use '/equip --update needle'."],
      ),
    };
  }

  const [pkg, requestedVersion] = rawPkg.split('@');
  const entry = CATALOG[pkg];
  if (!entry) {
    return {
      exitCode: 1,
      result: buildErrorResult(
        `Unknown package ${pkg}`,
        ["Run '/equip --list' to see available packages."],
      ),
    };
  }

  const plat = platform();
  const platKey = `${plat}-${arch()}`;
  const ext = plat === 'win32' ? '.exe' : '';
  const toolPath = join(TOOLS_DIR, pkg + ext);

  let targetVersion;
  try {
    targetVersion = isNeedleCatalogEntry(entry)
      ? resolveNeedleTargetVersion(entry, requestedVersion)
      : requestedVersion || fetchLatest(entry.repo) || entry.fallbackVersion;
  } catch (error) {
    return {
      exitCode: 1,
      result: buildErrorResult(
        `Could not install ${pkg}`,
        [`Retry with '/equip ${pkg}' because only the packaged needle version is supported.`],
        {
          errors: [error instanceof Error ? error.message : String(error)],
        },
      ),
    };
  }

  const errors = [];
  const statusLabel = update ? 'updated' : 'installed';

  if (isNeedleCatalogEntry(entry)) {
    const targetDir = entry.targetDir();
    const addonPath = equipmentAddonPath('needle');
    const installedMeta = readTargetMeta(targetDir);
    const isCurrentInstall = existsSync(addonPath)
      && installedMeta?.version === targetVersion
      && (installedMeta?.method === 'prebuild' || installedMeta?.method === 'source-build');

    if (isCurrentInstall) {
      return {
        exitCode: 0,
        result: buildTargetResult(
          update ? 'already_up_to_date' : 'already_installed',
          installedMeta.method,
          targetDir,
          entry,
          { version: targetVersion },
        ),
      };
    }

    const installLockPath = equipmentInstallLockPath('needle');
    try {
      mkdirSync(targetDir, { recursive: true });
      mkdirSync(dirname(installLockPath), { recursive: true });
    } catch (error) {
      if (isUnwritableInstallPathError(error)) {
        return {
          exitCode: 1,
          result: buildSetupError(
            'equipment_install_path_unwritable',
            'Cannot write to the Coral equipment install path for needle.',
            `Check filesystem permissions and free space under ${equipmentInstallRootLabel()}, then retry.`,
            { name: 'needle' },
          ),
        };
      }
      throw error;
    }

    let releaseInstallLock;
    try {
      releaseInstallLock = await acquireDirectoryLock(installLockPath, EQUIPMENT_INSTALL_LOCK_TIMEOUT_MS);
    } catch (error) {
      if (isDirectoryLockTimeoutError(error)) {
        return {
          exitCode: 1,
          result: buildSetupError(
            'equipment_install_lock_contended',
            'Another /equip is in progress for needle.',
            'Wait for the in-flight install to complete or remove the stale lock file.',
            { name: 'needle' },
          ),
        };
      }
      if (isUnwritableInstallPathError(error)) {
        return {
          exitCode: 1,
          result: buildSetupError(
            'equipment_install_path_unwritable',
            'Cannot write to the Coral equipment install path for needle.',
            `Check filesystem permissions and free space under ${equipmentInstallRootLabel()}, then retry.`,
            { name: 'needle' },
          ),
        };
      }
      throw error;
    }

    const needlePlatKey = needlePlatformKey();
    try {
      try {
        installNeedlePrebuild(entry, targetDir, targetVersion, needlePlatKey);
        return {
          exitCode: 0,
          result: buildTargetResult(statusLabel, 'prebuild', targetDir, entry, { version: targetVersion }),
        };
      } catch (error) {
        if (isUnwritableInstallPathError(error)) {
          return {
            exitCode: 1,
            result: buildSetupError(
              'equipment_install_path_unwritable',
              'Cannot write to the Coral equipment install path for needle.',
              `Check filesystem permissions and free space under ${equipmentInstallRootLabel()}, then retry.`,
              { name: 'needle' },
            ),
          };
        }
        errors.push(`prebuild: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        installNeedleSourceBuild(entry, targetDir, targetVersion);
        return {
          exitCode: 0,
          result: buildTargetResult(statusLabel, 'source-build', targetDir, entry, { version: targetVersion }),
        };
      } catch (error) {
        if (isUnwritableInstallPathError(error)) {
          return {
            exitCode: 1,
            result: buildSetupError(
              'equipment_install_path_unwritable',
              'Cannot write to the Coral equipment install path for needle.',
              `Check filesystem permissions and free space under ${equipmentInstallRootLabel()}, then retry.`,
              { name: 'needle' },
            ),
          };
        }
        errors.push(`source-build: ${error instanceof Error ? error.message : String(error)}`);
      }

      const suggestions = [];
      if (errors.some((e) => e.startsWith('prebuild:'))) {
        suggestions.push(`No prebuild available for ${needlePlatKey}. Source build also failed.`);
      }
      if (!findCmd('curl') && !findCmd('wget')) {
        suggestions.push('Install curl or wget so the needle prebuild can be downloaded');
      }
      if (!findCmd('cmake') && !findCmd('uv')) {
        suggestions.push('Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh');
      }

      return {
        exitCode: 1,
        result: { status: 'error', message: `Could not install ${pkg}`, errors, suggestions },
      };
    } finally {
      releaseInstallLock?.();
    }
  }

  if (update) {
    const meta = readMeta(pkg);
    if (meta?.version === targetVersion) {
      return {
        exitCode: 0,
        result: buildResult('already_up_to_date', meta.method, toolPath, entry, { version: targetVersion }),
      };
    }

    if (existsSync(toolPath)) {
      unlinkSync(toolPath);
    }
  }

  if (!update) {
    if (existsSync(toolPath)) {
      return {
        exitCode: 0,
        result: buildResult('already_installed', 'binary', toolPath, entry),
      };
    }
    const systemPath = findCmd(pkg);
    if (systemPath) {
      return {
        exitCode: 0,
        result: buildResult('already_installed', 'system', systemPath, entry),
      };
    }
  }

  const asset = entry.binaries[platKey];
  if (asset) {
    try {
      const url = `https://github.com/${entry.repo}/releases/download/${targetVersion}/${asset}`;
      if (!existsSync(TOOLS_DIR)) mkdirSync(TOOLS_DIR, { recursive: true });
      download(url, toolPath);
      if (plat !== 'win32') chmodSync(toolPath, 0o755);
      writeMeta(pkg, targetVersion, 'binary');
      return {
        exitCode: 0,
        result: buildResult(statusLabel, 'binary', toolPath, entry, { version: targetVersion }),
      };
    } catch (error) {
      errors.push(`binary: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (findCmd('uv')) {
    try {
      const uvCmd = update ? 'upgrade' : 'install';
      execSync(`uv tool ${uvCmd} ${entry.pip}`, { stdio: 'pipe', timeout: 300_000 });
      const cmd = findCmd(pkg) || join(homedir(), '.local', 'bin', pkg);
      writeMeta(pkg, targetVersion, 'uv');
      return {
        exitCode: 0,
        result: buildResult(statusLabel, 'uv', cmd, entry, { version: targetVersion }),
      };
    } catch (error) {
      errors.push(`uv: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (findCmd('pipx')) {
    try {
      const pipxCmd = update ? 'upgrade' : 'install';
      execSync(`pipx ${pipxCmd} ${entry.pip}`, { stdio: 'pipe', timeout: 300_000 });
      const cmd = findCmd(pkg) || join(homedir(), '.local', 'bin', pkg);
      writeMeta(pkg, targetVersion, 'pipx');
      return {
        exitCode: 0,
        result: buildResult(statusLabel, 'pipx', cmd, entry, { version: targetVersion }),
      };
    } catch (error) {
      errors.push(`pipx: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const suggestions = [];
  if (!asset) suggestions.push(`No pre-built binary for ${platKey}`);
  if (!findCmd('uv')) suggestions.push('Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh');
  if (!findCmd('pipx')) suggestions.push('Install pipx: python3 -m pip install --user pipx');

  return {
    exitCode: 1,
    result: { status: 'error', message: `Could not install ${pkg}`, errors, suggestions },
  };
}

async function main() {
  const { exitCode, result } = await runInstallCommand(process.argv.slice(2));
  emit(result);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
