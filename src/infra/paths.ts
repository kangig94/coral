import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const JOBS_DIR = join(tmpdir(), 'coral-jobs');

function coralHome(): string {
  return join(homedir(), '.claude', 'coral');
}

const namespaceCache = new Map<string, string>();
const projectSourceCache = new Map<string, string>();
let _buildFlavor: 'prod' | 'dev' = 'prod';

function fallbackProjectSource(projectRoot: string): string {
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

export function coralRoot(): string {
  return join(homedir(), '.coral');
}

export function setBuildFlavor(flavor: 'prod' | 'dev'): void {
  _buildFlavor = flavor;
}

export function currentBuildFlavor(): 'prod' | 'dev' {
  return _buildFlavor;
}

export function kbRoot(): string {
  const custom = process.env.CORAL_KB_PATH;
  if (custom) return custom.startsWith('~') ? join(homedir(), custom.slice(1)) : custom;
  return join(coralRoot(), currentBuildFlavor() === 'dev' ? 'kb-dev' : 'kb');
}

export function kbDir(): string {
  return join(kbRoot(), 'notes');
}

export function resolveProjectSource(projectRoot: string): string {
  const cached = projectSourceCache.get(projectRoot);
  if (cached) return cached;

  let source = fallbackProjectSource(projectRoot);
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    source = parseRemoteSource(remote) ?? source;
  } catch {
    // Fall back to local source naming when the repo has no origin or is not a git checkout.
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
  const ns = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  namespaceCache.set(pluginRoot, ns);
  return ns;
}

export function installationDir(pluginRoot: string): string {
  return join(coralHome(), 'installations', pluginRootNamespace(pluginRoot));
}

export function backendInfoPath(pluginRoot: string): string {
  return join(installationDir(pluginRoot), 'backend.json');
}

export function backendLockPath(pluginRoot: string): string {
  return join(installationDir(pluginRoot), 'backend.lock');
}

export function sessionBase(): string {
  return join(coralHome(), 'execution', 'sessions');
}

export function discussSourcesPath(): string {
  return join(coralRoot(), 'discuss-sources.json');
}

/**
 * Returns the base directory that stores discuss sessions for a project source.
 */
export function discussBaseDirForSource(source: string): string {
  return join(projectDataDirForSource(source), 'discuss');
}

/**
 * Returns the base directory that stores discuss sessions for a project.
 */
export function discussBaseDir(projectRoot: string): string {
  return discussBaseDirForSource(resolveProjectSource(projectRoot));
}

/**
 * Returns the discovery file path used to enumerate discuss sessions for a project source.
 */
export function discussDiscoveryPathForSource(source: string): string {
  return join(discussBaseDirForSource(source), 'discovery.json');
}

/**
 * Returns the discovery file path used to enumerate discuss sessions for a project.
 */
export function discussDiscoveryPath(projectRoot: string): string {
  return discussDiscoveryPathForSource(resolveProjectSource(projectRoot));
}

/**
 * Returns the summary index path used to list discuss sessions without loading snapshots for a project source.
 */
export function discussSummaryIndexPathForSource(source: string): string {
  return join(discussBaseDirForSource(source), 'summary-index.json');
}

/**
 * Returns the summary index path used to list discuss sessions without loading snapshots.
 */
export function discussSummaryIndexPath(projectRoot: string): string {
  return discussSummaryIndexPathForSource(resolveProjectSource(projectRoot));
}

/**
 * Returns the directory that stores one discuss session for a project source.
 */
export function discussSessionDirForSource(source: string, sessionId: string): string {
  return join(discussBaseDirForSource(source), sessionId);
}

/**
 * Returns the directory that stores one discuss session.
 */
export function discussSessionDir(projectRoot: string, sessionId: string): string {
  return discussSessionDirForSource(resolveProjectSource(projectRoot), sessionId);
}

/**
 * Returns the durable snapshot path for a discuss session directory.
 */
export function discussStatePath(sessionDir: string): string {
  return join(sessionDir, 'state.json');
}

/**
 * Returns the durable event log path for a discuss session directory.
 */
export function discussEventLogPath(sessionDir: string): string {
  return join(sessionDir, 'event-log.jsonl');
}
