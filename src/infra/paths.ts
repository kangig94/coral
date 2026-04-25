import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { hashToken } from './hash.js';

export function jobsDir(): string {
  return join(tmpdir(), 'coral-jobs');
}

const namespaceCache = new Map<string, string>();
const projectSourceCache = new Map<string, string>();
let _buildFlavor: 'prod' | 'dev' = 'prod';
let _settledBuildFlavor: 'prod' | 'dev' | null = null;

function localProjectSource(projectRoot: string): string {
  return `local/${basename(projectRoot)}`;
}

function parseRemoteSource(remote: string): string | null {
  const normalized = remote
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (!normalized) return null;

  const sshPath = normalized.match(/^[^@]+@[^:]+:(.+)$/)?.[1];
  const rawPath = sshPath ?? parseRemoteUrlPath(normalized);
  if (!rawPath) return null;

  const segments = rawPath.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

function parseRemoteUrlPath(remote: string): string | null {
  try {
    return new URL(remote).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function coralRoot(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.coral');
}

export function setBuildFlavor(flavor: 'prod' | 'dev'): void {
  if (_settledBuildFlavor !== null) {
    if (_settledBuildFlavor !== flavor) {
      throw new Error(`Build flavor already set to ${_settledBuildFlavor}; cannot change to ${flavor}`);
    }
    return;
  }
  _settledBuildFlavor = flavor;
  _buildFlavor = flavor;
}

export function currentBuildFlavor(): 'prod' | 'dev' {
  return _buildFlavor;
}

export function getSettledBuildFlavor(): 'prod' | 'dev' | null {
  return _settledBuildFlavor;
}

/**
 * Returns the KB markdown root. The directory may not exist — callers are
 * responsible for creation.
 */
export function kbRoot(flavor: 'prod' | 'dev' = currentBuildFlavor(), baseDir?: string): string {
  if (baseDir !== undefined) {
    return join(coralRoot(baseDir), flavor === 'dev' ? 'kb-dev' : 'kb');
  }

  const custom = process.env.CORAL_KB_PATH;
  if (custom) return custom.startsWith('~') ? join(homedir(), custom.slice(1)) : custom;
  return join(coralRoot(), flavor === 'dev' ? 'kb-dev' : 'kb');
}

export function kbDir(): string {
  return join(kbRoot(), 'notes');
}

export function resolveProjectSource(projectRoot: string): string {
  const cached = projectSourceCache.get(projectRoot);
  if (cached) return cached;

  let source = localProjectSource(projectRoot);
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    source = parseRemoteSource(remote) ?? source;
  } catch {
    // Non-git projects use a deterministic local source name.
  }

  projectSourceCache.set(projectRoot, source);
  return source;
}

export function sourceToSlug(source: string): string {
  return source.replace(/\//g, '-');
}

export function projectDataDirForSource(source: string): string {
  return join(coralRoot(), 'projects', sourceToSlug(source));
}

export function projectDataDir(projectRoot: string): string {
  return projectDataDirForSource(resolveProjectSource(projectRoot));
}

export function pluginRootNamespace(pluginRoot: string): string {
  const cached = namespaceCache.get(pluginRoot);
  if (cached) return cached;
  const canonical = realpathSync(pluginRoot);
  const ns = hashToken(canonical, 12);
  namespaceCache.set(pluginRoot, ns);
  return ns;
}
