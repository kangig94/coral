import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';

import { coralRoot } from './coral-root.js';

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

  const segments = rawPath.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

/**
 * Derive a stable "source" identifier for a project — `<owner>/<repo>` from
 * the git origin remote, or `local/<basename>` for non-git projects. Cached
 * per projectRoot to avoid re-shelling to git on every call.
 */
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
