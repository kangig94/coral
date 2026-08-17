import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export const PROJECT_SOURCE_CACHE_MAX_ENTRIES = 256;

/**
 * `git remote get-url` is a config read, but it stats up the directory tree and honours `include.path`, so a
 * `projectRoot` on a stalled network mount wedges it the same way any other subprocess wedges. This call runs
 * synchronously on the coordinator's startup path (`runtime.paths.projectSource`), and the cache below means
 * one wedge is enough — the entry it would have written never appears, but the boot it blocks never finishes
 * either.
 *
 * Its own bound rather than the incarnation probe's: that one observes a local process and normally answers in
 * well under 100ms, while this one may legitimately touch a slow filesystem. Sharing a number would tie two
 * schedules that have no reason to move together. Five seconds is long enough not to mistake a cold mount for
 * a hang, and short enough that a hung mount does not hold a boot.
 *
 * Best-effort in the same way and for the same reason as every synchronous timeout here: Node signals the
 * child and keeps waiting, so a child that ignores the signal still overruns. On timeout the existing `catch`
 * already falls back to the deterministic local source name, which is the conservative answer.
 */
const GIT_REMOTE_PROBE_TIMEOUT_MS = 5_000;

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
      timeout: GIT_REMOTE_PROBE_TIMEOUT_MS,
    }).trim();
    source = parseRemoteSource(remote) ?? source;
  } catch {
    // Non-git projects use a deterministic local source name.
  }

  rememberProjectSource(projectRoot, source);
  return source;
}
