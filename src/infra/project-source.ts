import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export const PROJECT_SOURCE_CACHE_MAX_ENTRIES = 256;

/**
 * `git remote get-url` is a config read, but it stats up the directory tree and honours `include.path`, so a
 * `projectRoot` on a stalled network mount wedges it the way any other subprocess wedges — synchronously,
 * blocking the event loop, with no abort able to reach it.
 *
 * It is reachable during coordinator startup, though not on every boot: discuss recovery resolves a source per
 * persisted discussion row (`discuss/shell/recovery.ts`), so a tree with no persisted discussions never calls
 * it there. It is also called per provider operation and per KB tool call, which is the more common way to
 * meet it.
 *
 * 2s, matching what `clients/hooks/lib/hook-utils.mjs` already uses for this same command — one command should
 * not have two answers. An earlier version of this comment argued for 5s on the grounds that a possibly-remote
 * filesystem read deserves a longer schedule than a local process probe; that reasoning is fine and the hook
 * falsifies its conclusion, having run the identical command under a tighter bound all along.
 *
 * Best-effort like every synchronous timeout here: Node signals the child and keeps waiting, so a child that
 * ignores the signal still overruns. What happens on timeout is not "fall back and move on" — see
 * `resolveProjectSource`, where a non-answer is deliberately not cached.
 */
const GIT_REMOTE_PROBE_TIMEOUT_MS = 2_000;

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
 * Whether git ran and answered. A non-null `status` means the process started, did its work, and exited with
 * that code — including the ordinary "not a repository" and "no such remote" answers, which are answers. A
 * spawn failure or a timeout has no `status`: git never told us anything.
 *
 * The distinction decides what may be cached, and getting it wrong is not cosmetic — see `resolveProjectSource`.
 */
function gitAnswered(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  try {
    return typeof Reflect.get(error, 'status') === 'number';
  } catch {
    return false;
  }
}

/**
 * Derive a stable "source" identifier for a project — `<owner>/<repo>` from the git origin remote, or
 * `local/<basename>` when there is no remote to read. Cached per projectRoot to avoid re-shelling to git on
 * every call.
 *
 * **Only a decisive answer is cached.** `local/<basename>` means two different things — "this project has no
 * git remote", which git told us, and "git never answered", which is a guess — and this cache outlives the
 * condition that produced it. Caching the guess is how a transient wedge becomes permanent: `projectData`
 * derives the per-project directory from this string (`runtime/real.ts`), and `kb/paths.ts` puts memos inside
 * it, so a wedged probe would file a memo under `local/<basename>` while every later read — after the mount
 * recovers and the real source resolves — looks under `<owner>/<repo>` and does not find it.
 *
 * So a non-answer is returned but not remembered, and the next call probes again. What that costs is a repeat
 * of the bound above on a permanently unreachable root; what it buys is that the fallback stops being durable.
 * It does not make the two meanings distinguishable to a caller — this function still returns one `string`,
 * and a caller inside the wedged window still gets the local name. Closing that needs a disposition in the
 * return type, which is `docs/todo/project-source-undecidable.md`.
 */
export function resolveProjectSource(projectRoot: string): string {
  const cached = projectSourceCache.get(projectRoot);
  if (cached !== undefined) {
    rememberProjectSource(projectRoot, cached);
    return cached;
  }

  const local = localProjectSource(projectRoot);
  let remote: string;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_REMOTE_PROBE_TIMEOUT_MS,
    }).trim();
  } catch (error: unknown) {
    if (gitAnswered(error)) rememberProjectSource(projectRoot, local);
    return local;
  }

  const source = parseRemoteSource(remote) ?? local;
  rememberProjectSource(projectRoot, source);
  return source;
}
