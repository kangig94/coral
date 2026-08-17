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
 * Failures that describe this moment rather than this environment. Each says the system could not run the
 * probe just now: it took too long, there were no process slots, or there were no file descriptors. Ask again
 * later and the answer can differ.
 *
 * Not claimed to be exhaustive — errno space is larger than any list — which is why the criterion is written
 * down beside it. Anything not named here is cached, so adding an entry is how a newly-recognised transient
 * failure stops being remembered as a standing fact.
 */
const TRANSIENT_PROBE_ERRNOS: ReadonlySet<string> = new Set(['ETIMEDOUT', 'EAGAIN', 'EMFILE', 'ENFILE']);

/**
 * Whether the probe failed for a reason that could answer differently next time.
 *
 * Everything outside `TRANSIENT_PROBE_ERRNOS` is a standing fact about the environment and is cached as one.
 * `git` exiting non-zero (`status: 128`) is the ordinary "not a repository" / "no such remote" answer, and
 * `ENOENT` is git not being installed, which will not change under a running daemon.
 *
 * Both directions of this have been wrong here. The first predicate asked "did git answer at all", keyed on
 * `status` being a number; `ENOENT` has `status: null`, so a machine without git re-spawned it on every call
 * for the daemon's lifetime — and `resolveProjectSource` runs per provider operation and per KB tool call. The
 * second named only `ETIMEDOUT`, which cached a fork that failed for want of process slots as though it were a
 * fact about the repository.
 */
function probeWasTransient(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  try {
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' && TRANSIENT_PROBE_ERRNOS.has(code);
  } catch {
    return false;
  }
}

/**
 * Derive a stable "source" identifier for a project — `<owner>/<repo>` from the git origin remote, or
 * `local/<basename>` when there is no remote to read. Cached per projectRoot to avoid re-shelling to git on
 * every call.
 *
 * **A transient failure is answered but not remembered.** `local/<basename>` covers two situations — there is
 * no git remote, which is a standing fact, and the probe timed out, which is a statement about one moment —
 * and this cache outlives the second. Caching it is how a wedge becomes permanent: `projectData` derives the
 * per-project directory from this string (`runtime/real.ts`) and `kb/paths.ts` puts memos inside it, so a
 * timed-out probe would file a memo under `local/<basename>` while every later read, after the mount
 * recovers, looks under `<owner>/<repo>` and does not find it.
 *
 * Only the timeout is treated that way — see `probeWasTransient`. A missing git binary or a non-zero exit is
 * cached like any other answer, because re-asking cannot change either, and not caching them would re-spawn
 * git on every call for the life of the daemon.
 *
 * This does not make the two meanings distinguishable to a caller: the function still returns one `string`,
 * and a caller inside the wedged window still gets the local name. Closing that needs a disposition in the
 * return type — `docs/todo/project-source-undecidable.md`.
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
    if (!probeWasTransient(error)) rememberProjectSource(projectRoot, local);
    return local;
  }

  const source = parseRemoteSource(remote) ?? local;
  rememberProjectSource(projectRoot, source);
  return source;
}
