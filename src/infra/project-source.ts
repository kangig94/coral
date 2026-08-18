import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import { backendLog } from './backend-log.js';
import { INDECISIVE_PROBE_REPROBE_INTERVAL_MS, STANDING_PROBE_ERRNOS } from './process-constants.js';

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
 * not have two answers.
 *
 * Best-effort like every synchronous timeout here: Node signals the child and keeps waiting, so a child that
 * ignores the signal still overruns. What happens on timeout is not "fall back and move on" — see
 * `resolveProjectSource`, where a non-answer is remembered only until `INDECISIVE_PROBE_REPROBE_INTERVAL_MS`.
 */
const GIT_REMOTE_PROBE_TIMEOUT_MS = 2_000;

const projectSourceCache = new Map<string, string>();
/** When a root last failed to produce an answer, so a wedge is re-probed per interval rather than per call. */
const indecisiveProbeAt = new Map<string, number>();

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

function rememberIndecisiveProbe(projectRoot: string, detail: string): void {
  // Said out loud because this was the one site of five that declined in silence, and it is the one whose
  // value lands on disk: `projectData` derives a directory from the string this function makes us fall back
  // to, so a memo written now is filed under a name a later read will not look for. At most once per interval
  // per root, since the hold below suppresses the re-probe.
  backendLog.warn(
    `Could not derive the project source for ${projectRoot} (${detail}); using the local fallback for now, which is not a statement that this project has no git remote.`,
  );
  indecisiveProbeAt.delete(projectRoot);
  indecisiveProbeAt.set(projectRoot, Date.now());

  while (indecisiveProbeAt.size > PROJECT_SOURCE_CACHE_MAX_ENTRIES) {
    const oldest = indecisiveProbeAt.keys().next().value;
    if (oldest === undefined) return;
    indecisiveProbeAt.delete(oldest);
  }
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
 * Whether the probe produced an answer. Two shapes count: git ran and exited with a status — including the
 * ordinary "not a repository" and "no such remote" exits — or it could not be run for a reason that will not
 * change (`STANDING_PROBE_ERRNOS`). Anything else is the system declining to answer right now.
 */
/** What the probe reported, for the operator-facing line — the errno when there is one, the message otherwise. */
function probeDetail(error: unknown): string {
  const errno = error as NodeJS.ErrnoException | null;
  return errno?.code ?? errno?.message ?? 'unknown error';
}

function probeWasDecisive(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errno = error as NodeJS.ErrnoException & { status?: unknown };
  if (typeof errno.status === 'number') return true;
  return typeof errno.code === 'string' && STANDING_PROBE_ERRNOS.has(errno.code);
}

/**
 * Derive a stable "source" identifier for a project — `<owner>/<repo>` from the git origin remote, or
 * `local/<basename>` when there is no remote to read.
 *
 * **An answer is remembered; a non-answer is remembered only briefly.** `local/<basename>` covers two
 * different things: git told us there is no remote, and git could not be run just now. Only the first is a
 * fact about the project. Caching the second permanently is how a wedge becomes permanent — `projectData`
 * derives the per-project directory from this string (`runtime/real.ts`) and `kb/paths.ts` puts memos inside
 * it, so a probe that could not run would file a memo under `local/<basename>` while every later read, after
 * the mount recovers, looks under `<owner>/<repo>` and does not find it. Not caching it at all is how one
 * stalled mount becomes one blocking probe *per row* on the loops that call this. It is therefore cached with
 * an expiry, which is neither.
 *
 * `probeWasDecisive` draws the line, and it enumerates the *standing* failures rather than the transient ones
 * on purpose: an errno nobody listed then costs a re-probe instead of a wrong answer nobody can see.
 *
 * Two things this does not do. It does not make the two meanings distinguishable to a caller — the return is
 * one `string`, and a caller inside the window still gets the local name. And because the fallback now expires,
 * one root can answer `local/x` early in a process and `<owner>/x` later, which callers that key state by
 * source (`discuss/shell/runtime-services.ts`) or persist it (`discuss/shell/recovery.ts`'s `sourceId`) are not
 * written for. Both are `docs/todo/project-source-undecidable.md`.
 */
export function resolveProjectSource(projectRoot: string): string {
  const cached = projectSourceCache.get(projectRoot);
  if (cached !== undefined) {
    rememberProjectSource(projectRoot, cached);
    return cached;
  }

  const local = localProjectSource(projectRoot);
  // What the shared interval buys here specifically: this is called once per row inside `snapshotsForSource`
  // (`discuss/read-queries.ts`) and twice per candidate during discuss recovery, so without the hold one
  // stalled mount is `GIT_REMOTE_PROBE_TIMEOUT_MS` × rows of synchronous, uninterruptible blocking — past the
  // coordinator's startup deadline at eight rows.
  const lastIndecisiveAt = indecisiveProbeAt.get(projectRoot);
  if (lastIndecisiveAt !== undefined && Date.now() - lastIndecisiveAt < INDECISIVE_PROBE_REPROBE_INTERVAL_MS) {
    return local;
  }

  let remote: string;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_REMOTE_PROBE_TIMEOUT_MS,
    }).trim();
  } catch (error: unknown) {
    if (probeWasDecisive(error)) {
      indecisiveProbeAt.delete(projectRoot);
      rememberProjectSource(projectRoot, local);
    } else {
      rememberIndecisiveProbe(projectRoot, probeDetail(error));
    }
    return local;
  }

  indecisiveProbeAt.delete(projectRoot);
  const source = parseRemoteSource(remote) ?? local;
  rememberProjectSource(projectRoot, source);
  return source;
}
