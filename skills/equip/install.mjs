#!/usr/bin/env node
// Equip installer — downloads Coral companion tooling and runtime dependencies for Claude Code.
// Usage: node install.mjs [--list | [--update] <package>]
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
import { gunzipSync } from 'node:zlib';
import {
  equipmentAddonPath,
  equipmentDataDir,
  equipmentInstallLockPath,
} from './equipment-paths.mjs';
import {
  acquireDirectoryLock,
  isDirectoryLockTimeoutError,
} from './fs-lock.mjs';

const TOOLS_DIR = join(homedir(), '.claude', 'tools');
const KB_ARCH_MAP = { x64: 'amd64', arm64: 'arm64' };
const EQUIPMENT_INSTALL_LOCK_TIMEOUT_MS = 250;
const UNWRITABLE_ERRNOS = new Set(['EACCES', 'EROFS', 'EPERM', 'ENOSPC']);

function kbPlatformKey() {
  return `${platform()}-${KB_ARCH_MAP[arch()] || arch()}`;
}
const KB_SECURITY_NOTICE = 'Store API keys in ~/.coral/.env, not in settings.json.';
const KB_ONBOARDING_CHOICES = [
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

function kbEquipmentDirFromEnv() {
  return equipmentDataDir('needle');
}

function coralEnvPathFromEnv() {
  return join(homedir(), '.coral', '.env');
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
  kb: {
    kind: 'needle',
    name: 'Knowledge Base Vector Runtime',
    description: 'Installs coral-needle native addon for vector search',
    repo: 'kangig94/coral-needle',
    needleVersion: '0.2.0',
    targetDir: () => kbEquipmentDirFromEnv(),
    postInstall: ['backend_shutdown', 'kb_reindex'],
  },
};

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

function emitSetupError(code, userMessage, remediation, context = undefined, extra = {}) {
  emit({
    status: 'error',
    code,
    userMessage,
    remediation,
    ...(context === undefined ? {} : { context }),
    ...extra,
  });
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
  return join(targetDir, '.kb-meta.json');
}

function readTargetMeta(targetDir) {
  try { return JSON.parse(readFileSync(targetMetaPath(targetDir), 'utf-8')); }
  catch { return null; }
}

function writeTargetMeta(targetDir, version, method) {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetMetaPath(targetDir), JSON.stringify({ version, method }));
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

function resolveKbTargetVersion(entry, requestedVersion) {
  const needleVersion = entry.needleVersion;
  if (!needleVersion) {
    throw new Error('kb catalog entry is missing needleVersion');
  }
  if (requestedVersion && requestedVersion !== needleVersion) {
    throw new Error(`kb expects needleVersion ${needleVersion}, not ${requestedVersion}`);
  }
  return needleVersion;
}

function buildKbOnboarding(runtimeDir) {
  return {
    envPath: coralEnvPathFromEnv(),
    requiredEnv: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_API_KEY'],
    providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
    modelEnvKey: 'CORAL_EMBEDDING_MODEL',
    apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
    securityNotice: KB_SECURITY_NOTICE,
    localRuntime: {
      targetDir: runtimeDir,
      bootstrapPackageJson: true,
      packageManager: 'npm',
      packageName: 'onnxruntime-node',
    },
    choices: KB_ONBOARDING_CHOICES,
  };
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

function installKbPrebuild(entry, targetDir, version, platKey) {
  const releaseTag = `v${version}`;
  const assetName = `coral-needle-${releaseTag}-${platKey}.tar.gz`;
  const tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-prebuild-'));

  try {
    const archivePath = join(tempDir, assetName);
    const addonPath = equipmentAddonPath(entry.kind);
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
    throw new Error('cmake is required for KB source builds and uv is not installed.');
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

function installKbSourceBuild(entry, targetDir, version) {
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

    const addonPath = equipmentAddonPath(entry.kind);
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
    ...(entry.kind === 'needle' ? { onboarding: buildKbOnboarding(kbRuntimeDirFromEnv()) } : {}),
    ...extra,
  };
}

async function main() {
  // Parse arguments
  const argv = process.argv.slice(2);
  const update = argv.includes('--update');
  const rawPkg = argv.find((arg) => !arg.startsWith('-'));

  // List catalog
  if (argv.includes('--list') || (!rawPkg && !update)) {
    emit({
      status: 'catalog',
      packages: Object.entries(CATALOG).map(([id, item]) => ({
        id,
        name: item.name,
        description: item.description,
      })),
    });
    return 0;
  }

  if (!rawPkg) {
    emit({ status: 'error', message: 'Package name required with --update' });
    return 1;
  }

  const [pkg, requestedVersion] = rawPkg.split('@');
  const entry = CATALOG[pkg];
  if (!entry) {
    emit({ status: 'error', message: `Unknown package: ${pkg}` });
    return 1;
  }

  const plat = platform();
  const platKey = `${plat}-${arch()}`;
  const ext = plat === 'win32' ? '.exe' : '';
  const toolPath = join(TOOLS_DIR, pkg + ext);

  let targetVersion;
  try {
    targetVersion = entry.kind === 'needle'
      ? resolveKbTargetVersion(entry, requestedVersion)
      : requestedVersion || fetchLatest(entry.repo) || entry.fallbackVersion;
  } catch (error) {
    emit({
      status: 'error',
      message: `Could not install ${pkg}`,
      errors: [error instanceof Error ? error.message : String(error)],
      suggestions: [],
    });
    return 1;
  }

  const errors = [];
  const statusLabel = update ? 'updated' : 'installed';

  if (entry.kind === 'needle') {
    const targetDir = entry.targetDir();
    const addonPath = equipmentAddonPath(entry.kind);
    const installedMeta = readTargetMeta(targetDir);
    const isCurrentInstall = existsSync(addonPath)
      && installedMeta?.version === targetVersion
      && (installedMeta?.method === 'prebuild' || installedMeta?.method === 'source-build');

    if (isCurrentInstall) {
      emit(buildTargetResult(
        update ? 'already_up_to_date' : 'already_installed',
        installedMeta.method,
        targetDir,
        entry,
        { version: targetVersion },
      ));
      return 0;
    }

    const installLockPath = equipmentInstallLockPath(entry.kind);
    try {
      mkdirSync(targetDir, { recursive: true });
      mkdirSync(dirname(installLockPath), { recursive: true });
    } catch (error) {
      if (isUnwritableInstallPathError(error)) {
        emitSetupError(
          'equipment_install_path_unwritable',
          `Cannot write to the Coral equipment install path for ${entry.kind}.`,
          'Check filesystem permissions and free space under ~/.coral/data/equipment/, then retry.',
          { name: entry.kind },
        );
        return 1;
      }
      throw error;
    }

    let releaseInstallLock;
    try {
      releaseInstallLock = await acquireDirectoryLock(installLockPath, EQUIPMENT_INSTALL_LOCK_TIMEOUT_MS);
    } catch (error) {
      if (isDirectoryLockTimeoutError(error)) {
        emitSetupError(
          'equipment_install_lock_contended',
          `Another /equip is in progress for ${entry.kind}.`,
          'Wait for the in-flight install to complete or remove the stale lock file.',
          { name: entry.kind },
        );
        return 1;
      }
      if (isUnwritableInstallPathError(error)) {
        emitSetupError(
          'equipment_install_path_unwritable',
          `Cannot write to the Coral equipment install path for ${entry.kind}.`,
          'Check filesystem permissions and free space under ~/.coral/data/equipment/, then retry.',
          { name: entry.kind },
        );
        return 1;
      }
      throw error;
    }

    const needlePlatKey = kbPlatformKey();
    try {
      try {
        installKbPrebuild(entry, targetDir, targetVersion, needlePlatKey);
        emit(buildTargetResult(statusLabel, 'prebuild', targetDir, entry, { version: targetVersion }));
        return 0;
      } catch (error) {
        if (isUnwritableInstallPathError(error)) {
          emitSetupError(
            'equipment_install_path_unwritable',
            `Cannot write to the Coral equipment install path for ${entry.kind}.`,
            'Check filesystem permissions and free space under ~/.coral/data/equipment/, then retry.',
            { name: entry.kind },
          );
          return 1;
        }
        errors.push(`prebuild: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        installKbSourceBuild(entry, targetDir, targetVersion);
        emit(buildTargetResult(statusLabel, 'source-build', targetDir, entry, { version: targetVersion }));
        return 0;
      } catch (error) {
        if (isUnwritableInstallPathError(error)) {
          emitSetupError(
            'equipment_install_path_unwritable',
            `Cannot write to the Coral equipment install path for ${entry.kind}.`,
            'Check filesystem permissions and free space under ~/.coral/data/equipment/, then retry.',
            { name: entry.kind },
          );
          return 1;
        }
        errors.push(`source-build: ${error instanceof Error ? error.message : String(error)}`);
      }

      const suggestions = [];
      if (errors.some((e) => e.startsWith('prebuild:'))) {
        suggestions.push(`No prebuild available for ${needlePlatKey}. Source build also failed.`);
      }
      if (!findCmd('curl') && !findCmd('wget')) {
        suggestions.push('Install curl or wget so the KB prebuild can be downloaded');
      }
      if (!findCmd('cmake') && !findCmd('uv')) {
        suggestions.push('Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh');
      }

      emit({ status: 'error', message: `Could not install ${pkg}`, errors, suggestions });
      return 1;
    } finally {
      releaseInstallLock?.();
    }
  }

  if (update) {
    const meta = readMeta(pkg);
    if (meta?.version === targetVersion) {
      emit(buildResult('already_up_to_date', meta.method, toolPath, entry, { version: targetVersion }));
      return 0;
    }

    if (existsSync(toolPath)) {
      unlinkSync(toolPath);
    }
  }

  if (!update) {
    if (existsSync(toolPath)) {
      emit(buildResult('already_installed', 'binary', toolPath, entry));
      return 0;
    }
    const systemPath = findCmd(pkg);
    if (systemPath) {
      emit(buildResult('already_installed', 'system', systemPath, entry));
      return 0;
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
      emit(buildResult(statusLabel, 'binary', toolPath, entry, { version: targetVersion }));
      return 0;
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
      emit(buildResult(statusLabel, 'uv', cmd, entry, { version: targetVersion }));
      return 0;
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
      emit(buildResult(statusLabel, 'pipx', cmd, entry, { version: targetVersion }));
      return 0;
    } catch (error) {
      errors.push(`pipx: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const suggestions = [];
  if (!asset) suggestions.push(`No pre-built binary for ${platKey}`);
  if (!findCmd('uv')) suggestions.push('Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh');
  if (!findCmd('pipx')) suggestions.push('Install pipx: python3 -m pip install --user pipx');

  emit({ status: 'error', message: `Could not install ${pkg}`, errors, suggestions });
  return 1;
}

process.exitCode = await main();
