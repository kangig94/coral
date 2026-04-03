#!/usr/bin/env node
// Equip installer — downloads and configures MCP tools for Claude Code.
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
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, '..', '..');
const TOOLS_DIR = join(homedir(), '.claude', 'tools');
const KB_SUPPORTED_PLATFORMS = new Set([
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
]);
const KB_SECURITY_NOTICE = 'API key는 ~/.coral/.env에 직접 기록하세요. settings.json이 아닌 ~/.coral/.env에.';
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
    mcp: {
      serverName: 'CodeGraphContext',
      args: ['mcp', 'start'],
    },
  },
  kb: {
    kind: 'kb-addon',
    name: 'Knowledge Base Vector Runtime',
    description: 'Installs the native KB vector runtime and embedding onboarding data',
    repo: 'kangig94/coral',
    targetDir: () => kbRuntimeDirFromEnv(),
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

function kbAddonPath(targetDir) {
  return join(targetDir, 'vec', 'coral-vec.node');
}

function readPackagedCsrcVersion() {
  const manifestPath = join(PLUGIN_ROOT, 'bridge', 'manifest.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (!parsed || typeof parsed.csrcVersion !== 'string' || parsed.csrcVersion.length === 0) {
    throw new Error(`Packaged bridge manifest is missing csrcVersion: ${manifestPath}`);
  }
  return parsed.csrcVersion;
}

function resolveKbTargetVersion(requestedVersion) {
  const csrcVersion = readPackagedCsrcVersion();
  if (requestedVersion && requestedVersion !== csrcVersion) {
    throw new Error(`kb expects packaged csrcVersion ${csrcVersion}, not ${requestedVersion}`);
  }
  return csrcVersion;
}

function buildKbOnboarding(targetDir) {
  return {
    envPath: coralEnvPathFromEnv(),
    requiredEnv: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_API_KEY'],
    providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
    modelEnvKey: 'CORAL_EMBEDDING_MODEL',
    apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
    securityNotice: KB_SECURITY_NOTICE,
    localRuntime: {
      targetDir,
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
  const releaseTag = `csrc@${version}`;
  const assetName = `${releaseTag}-${platKey}.tar.gz`;
  const tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-prebuild-'));

  try {
    const archivePath = join(tempDir, assetName);
    const addonPath = kbAddonPath(targetDir);
    download(`https://github.com/${entry.repo}/releases/download/${releaseTag}/${assetName}`, archivePath);
    mkdirSync(dirname(addonPath), { recursive: true });
    writeFileSync(addonPath, extractTarEntry(archivePath, 'coral-vec.node'));
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

function installKbSourceBuild(targetDir, version) {
  const cmake = ensureCmake();
  execFileSync(cmake, ['-B', 'build', 'csrc/'], {
    cwd: PLUGIN_ROOT,
    stdio: 'pipe',
    timeout: 900_000,
  });
  execFileSync(cmake, ['--build', 'build', '--config', 'Release'], {
    cwd: PLUGIN_ROOT,
    stdio: 'pipe',
    timeout: 900_000,
  });

  const builtAddon = [
    join(PLUGIN_ROOT, 'build', 'coral-vec.node'),
    join(PLUGIN_ROOT, 'build', 'Release', 'coral-vec.node'),
  ].find((candidate) => existsSync(candidate));

  if (!builtAddon) {
    throw new Error('cmake build completed without producing build/coral-vec.node.');
  }

  const addonPath = kbAddonPath(targetDir);
  mkdirSync(dirname(addonPath), { recursive: true });
  copyFileSync(builtAddon, addonPath);
  writeTargetMeta(targetDir, version, 'source-build');
}

function buildResult(status, method, cmdPath, entry, extra) {
  return {
    status,
    method,
    command: cmdPath,
    mcp: {
      serverName: entry.mcp.serverName,
      command: cmdPath,
      args: entry.mcp.args,
    },
    ...extra,
  };
}

function buildTargetResult(status, method, targetDir, entry, extra) {
  return {
    status,
    method,
    targetDir,
    ...(entry.postInstall ? { postInstall: entry.postInstall } : {}),
    ...(entry.kind === 'kb-addon' ? { onboarding: buildKbOnboarding(targetDir) } : {}),
    ...extra,
  };
}

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
  process.exit(0);
}

if (!rawPkg) {
  emit({ status: 'error', message: 'Package name required with --update' });
  process.exit(1);
}

const [pkg, requestedVersion] = rawPkg.split('@');
const entry = CATALOG[pkg];
if (!entry) {
  emit({ status: 'error', message: `Unknown package: ${pkg}` });
  process.exit(1);
}

const plat = platform();
const platKey = `${plat}-${arch()}`;
const ext = plat === 'win32' ? '.exe' : '';
const toolPath = join(TOOLS_DIR, pkg + ext);

let targetVersion;
try {
  targetVersion = entry.kind === 'kb-addon'
    ? resolveKbTargetVersion(requestedVersion)
    : requestedVersion || fetchLatest(entry.repo) || entry.fallbackVersion;
} catch (error) {
  emit({
    status: 'error',
    message: `Could not install ${pkg}`,
    errors: [error instanceof Error ? error.message : String(error)],
    suggestions: [],
  });
  process.exit(1);
}

const errors = [];
const statusLabel = update ? 'updated' : 'installed';

if (entry.kind === 'kb-addon') {
  const targetDir = entry.targetDir();
  const addonPath = kbAddonPath(targetDir);
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
    process.exit(0);
  }

  if (KB_SUPPORTED_PLATFORMS.has(platKey)) {
    try {
      installKbPrebuild(entry, targetDir, targetVersion, platKey);
      emit(buildTargetResult(statusLabel, 'prebuild', targetDir, entry, { version: targetVersion }));
      process.exit(0);
    } catch (error) {
      errors.push(`prebuild: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    installKbSourceBuild(targetDir, targetVersion);
    emit(buildTargetResult(statusLabel, 'source-build', targetDir, entry, { version: targetVersion }));
    process.exit(0);
  } catch (error) {
    errors.push(`source-build: ${error instanceof Error ? error.message : String(error)}`);
  }

  const suggestions = [];
  if (!KB_SUPPORTED_PLATFORMS.has(platKey)) {
    suggestions.push(`No KB prebuild is published for ${platKey}`);
  }
  if (!findCmd('curl') && !findCmd('wget')) {
    suggestions.push('Install curl or wget so the KB prebuild can be downloaded');
  }
  if (!findCmd('cmake') && !findCmd('uv')) {
    suggestions.push('Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh');
  }

  emit({ status: 'error', message: `Could not install ${pkg}`, errors, suggestions });
  process.exit(1);
}

if (update) {
  const meta = readMeta(pkg);
  if (meta?.version === targetVersion) {
    emit(buildResult('already_up_to_date', meta.method, toolPath, entry, { version: targetVersion }));
    process.exit(0);
  }

  if (existsSync(toolPath)) {
    unlinkSync(toolPath);
  }
}

if (!update) {
  if (existsSync(toolPath)) {
    emit(buildResult('already_installed', 'binary', toolPath, entry));
    process.exit(0);
  }
  const systemPath = findCmd(pkg);
  if (systemPath) {
    emit(buildResult('already_installed', 'system', systemPath, entry));
    process.exit(0);
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
    process.exit(0);
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
    process.exit(0);
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
    process.exit(0);
  } catch (error) {
    errors.push(`pipx: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const suggestions = [];
if (!asset) suggestions.push(`No pre-built binary for ${platKey}`);
if (!findCmd('uv')) suggestions.push('Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh');
if (!findCmd('pipx')) suggestions.push('Install pipx: python3 -m pip install --user pipx');

emit({ status: 'error', message: `Could not install ${pkg}`, errors, suggestions });
process.exit(1);
