import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export const PROJECT_SOURCE_CACHE_MAX_ENTRIES = 256;

const projectSourceCache = new Map<string, string>();

function localProjectSource(projectRoot: string): string {
  return `local/${basename(projectRoot)}`;
}

function parseRemoteUrlPath(remote: string): string | null {
  try {
    return new URL(remote).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  } catch {
    return null;
  }
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

  const segments = rawPath.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;

  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

function rememberProjectSource(projectRoot: string, source: string): void {
  projectSourceCache.delete(projectRoot);
  projectSourceCache.set(projectRoot, source);

  while (projectSourceCache.size > PROJECT_SOURCE_CACHE_MAX_ENTRIES) {
    const oldestProjectRoot = projectSourceCache.keys().next().value;
    if (oldestProjectRoot === undefined) {
      return;
    }
    projectSourceCache.delete(oldestProjectRoot);
  }
}

/**
 * Derive a stable "source" identifier for a project — `<owner>/<repo>` from
 * the git origin remote, or `local/<basename>` for non-git projects. Cached
 * per projectRoot to avoid re-shelling to git on every call.
 */
export function resolveProjectSource(projectRoot: string): string {
  const cached = projectSourceCache.get(projectRoot);
  if (cached !== undefined) {
    rememberProjectSource(projectRoot, cached);
    return cached;
  }

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

  rememberProjectSource(projectRoot, source);
  return source;
}
