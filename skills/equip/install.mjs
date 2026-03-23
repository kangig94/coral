#!/usr/bin/env node
// Equip installer — downloads and configures MCP tools for Claude Code.
// Usage: node install.mjs [--list | [--update] <package>]
// Outputs a single JSON line to stdout.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { platform, arch, homedir } from 'node:os';

const TOOLS_DIR = join(homedir(), '.claude', 'tools');

function kbRuntimeDirFromEnv() {
  return join(homedir(), '.coral', 'data', 'kb');
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
    name: 'Knowledge Base (LanceDB)',
    description: 'Enhanced KB search with structured queries and future vector support',
    npm: '@lancedb/lancedb',
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

function npmViewVersion(pkg) {
  try {
    return execSync(`npm view ${pkg} version`, {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function localPackageVersion(targetDir, pkgName) {
  try {
    const pkgPath = join(targetDir, 'node_modules', pkgName, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
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

function buildResult(status, method, cmdPath, entry, extra) {
  return {
    status, method, command: cmdPath,
    mcp: {
      serverName: entry.mcp.serverName,
      command: cmdPath,
      args: entry.mcp.args,
    },
    ...extra,
  };
}

function buildLocalNpmResult(status, method, targetDir, entry, extra) {
  return {
    status,
    method,
    targetDir,
    ...(entry.postInstall ? { postInstall: entry.postInstall } : {}),
    ...extra,
  };
}

// Parse arguments
const argv = process.argv.slice(2);
const update = argv.includes('--update');
const rawPkg = argv.find(a => !a.startsWith('-'));

// List catalog
if (argv.includes('--list') || (!rawPkg && !update)) {
  emit({
    status: 'catalog',
    packages: Object.entries(CATALOG).map(([id, e]) => ({
      id, name: e.name, description: e.description,
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

const ext = platform() === 'win32' ? '.exe' : '';
const toolPath = join(TOOLS_DIR, pkg + ext);
const plat = platform();
const platKey = `${plat}-${arch()}`;

// Resolve target version
const targetVersion = entry.npm
  ? requestedVersion || npmViewVersion(entry.npm) || 'latest'
  : requestedVersion || fetchLatest(entry.repo) || entry.fallbackVersion;

const errors = [];
const statusLabel = update ? 'updated' : 'installed';

if (entry.npm) {
  const targetDir = entry.targetDir();
  const installedVersion = localPackageVersion(targetDir, entry.npm);
  if (installedVersion === targetVersion) {
    const meta = readTargetMeta(targetDir);
    if (meta?.version !== targetVersion || meta?.method !== 'local-npm') {
      writeTargetMeta(targetDir, targetVersion, 'local-npm');
    }
    emit(buildLocalNpmResult(
      update ? 'already_up_to_date' : 'already_installed',
      'local-npm',
      targetDir,
      entry,
      { version: targetVersion },
    ));
    process.exit(0);
  }

  if (findCmd('npm')) {
    try {
      mkdirSync(targetDir, { recursive: true });
      if (!existsSync(join(targetDir, 'package.json'))) {
        execSync('npm init -y', { cwd: targetDir, stdio: 'pipe' });
      }
      execSync(`npm install ${entry.npm}@${targetVersion}`, {
        cwd: targetDir,
        stdio: 'pipe',
        timeout: 300_000,
      });
      writeTargetMeta(targetDir, targetVersion, 'local-npm');
      emit(buildLocalNpmResult(
        statusLabel,
        'local-npm',
        targetDir,
        entry,
        { version: targetVersion },
      ));
      process.exit(0);
    } catch (e) {
      errors.push(`local-npm: ${e.message}`);
    }
  }

  const suggestions = [];
  if (!findCmd('npm')) suggestions.push('Install npm / Node.js to enable local package installs');
  emit({ status: 'error', message: `Could not install ${pkg}`, errors, suggestions });
  process.exit(1);
}

if (update) {
  const meta = readMeta(pkg);
  if (meta?.version === targetVersion) {
    emit(buildResult('already_up_to_date', meta.method, toolPath, entry, { version: targetVersion }));
    process.exit(0);
  }

  // Clean old binary for re-download
  if (existsSync(toolPath)) unlinkSync(toolPath);
}

// Check already installed (install mode only)
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

// Strategy 1: Pre-built binary
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
  } catch (e) {
    errors.push(`binary: ${e.message}`);
  }
}

// Strategy 2: uv tool install/upgrade
if (findCmd('uv')) {
  try {
    const uvCmd = update ? 'upgrade' : 'install';
    execSync(`uv tool ${uvCmd} ${entry.pip}`, { stdio: 'pipe', timeout: 300_000 });
    const cmd = findCmd(pkg) || join(homedir(), '.local', 'bin', pkg);
    writeMeta(pkg, targetVersion, 'uv');
    emit(buildResult(statusLabel, 'uv', cmd, entry, { version: targetVersion }));
    process.exit(0);
  } catch (e) {
    errors.push(`uv: ${e.message}`);
  }
}

// Strategy 3: pipx install/upgrade
if (findCmd('pipx')) {
  try {
    const pipxCmd = update ? 'upgrade' : 'install';
    execSync(`pipx ${pipxCmd} ${entry.pip}`, { stdio: 'pipe', timeout: 300_000 });
    const cmd = findCmd(pkg) || join(homedir(), '.local', 'bin', pkg);
    writeMeta(pkg, targetVersion, 'pipx');
    emit(buildResult(statusLabel, 'pipx', cmd, entry, { version: targetVersion }));
    process.exit(0);
  } catch (e) {
    errors.push(`pipx: ${e.message}`);
  }
}

// All strategies failed
const suggestions = [];
if (!asset) suggestions.push(`No pre-built binary for ${platKey}`);
if (!findCmd('uv')) suggestions.push('Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh');
if (!findCmd('pipx')) suggestions.push('Install pipx: python3 -m pip install --user pipx');

emit({ status: 'error', message: `Could not install ${pkg}`, errors, suggestions });
process.exit(1);
