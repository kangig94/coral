import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import { backendLog } from './backend-log.js';
import { INDECISIVE_PROBE_REPROBE_INTERVAL_MS } from './process-constants.js';
import { classifyThrownExecOutcome } from './port-types.js';

/** Bounds both per-root maps below — the resolved-source cache and the indecisive-probe timestamps alike. */
export const PROJECT_SOURCE_MAP_MAX_ENTRIES = 256;

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

/**
 * A remote URL as `<owner>/<repo>`, or `null` when it names no such pair.
 *
 * Exported for one reason: `clients/hooks/lib/hook-utils.mjs` must spell this rule again — hooks may not
 * import from `src/` — and both spellings name the same `~/.coral/projects[-dev]/<slug>` directory. A single
 * table in `tests/unit/hooks/hook-project-source.test.ts` drives both, because the two had already diverged
 * on five of nineteen remotes underneath a comment saying they must agree.
 */
export function parseRemoteSource(remote: string): string | null {
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
  // Said out loud because this decline is the one whose value lands on disk: `projectData` derives a
  // directory from the string this function makes us fall back to, so a memo written now is filed under a
  // name a later read will not look for. Every other site that declines on a non-answer either throws or
  // returns a verdict its caller renders; this one returned a plausible string and said nothing. At most once
  // per interval per root, since the hold below suppresses the re-probe.
  //
  // An earlier revision put a count here — "the one site of five" — and it went stale the next time a site
  // was converted, which is the whole lesson of this branch applied to its own comments: a number in prose is
  // a claim, and this one had nothing checking it.
  backendLog.warn(
    `Could not derive the project source for ${projectRoot} (${detail}); using the local fallback for now, which is not a statement that this project has no git remote.`,
  );
  indecisiveProbeAt.delete(projectRoot);
  indecisiveProbeAt.set(projectRoot, Date.now());

  while (indecisiveProbeAt.size > PROJECT_SOURCE_MAP_MAX_ENTRIES) {
    const oldest = indecisiveProbeAt.keys().next().value;
    if (oldest === undefined) return;
    indecisiveProbeAt.delete(oldest);
  }
}

function rememberProjectSource(projectRoot: string, source: string): void {
  projectSourceCache.delete(projectRoot);
  projectSourceCache.set(projectRoot, source);

  while (projectSourceCache.size > PROJECT_SOURCE_MAP_MAX_ENTRIES) {
    const oldestProjectRoot = projectSourceCache.keys().next().value;
    if (oldestProjectRoot === undefined) {
      return;
    }
    projectSourceCache.delete(oldestProjectRoot);
  }
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
 * `classifyThrownExecOutcome` (`infra/port-types.ts`) draws the line — the same owner `git-sync.ts` and both
 * provider preflights use. This file reads a thrown error rather than an `ExecResult` only because it sits
 * below the runtime composition (`runtime/real.ts` imports it to build `paths.projectSource`) and so has no
 * port to read a result from; that is why the owner has two entry points rather than this file having its own
 * predicate, which is what it had until the rule was given one home.
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
  // (`discuss/read-queries.ts`), so without the hold one stalled mount is `GIT_REMOTE_PROBE_TIMEOUT_MS` × rows
  // of synchronous, uninterruptible blocking — past the coordinator's startup deadline at eight rows. Discuss
  // recovery calls this twice per candidate, so the same deadline is crossed at four candidates instead.
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
    const outcome = classifyThrownExecOutcome(error);
    // `answered` alone is decisive here: `launch-refused` is a standing fact about this machine, not a report
    // about this project's remote (`process-constants.ts`'s `STANDING_PROBE_ERRNOS`), so it takes the same
    // indecisive-with-expiry path as `no-answer` rather than being cached as "no remote" for the process's life.
    if (outcome.kind === 'answered') {
      indecisiveProbeAt.delete(projectRoot);
      rememberProjectSource(projectRoot, local);
    } else {
      rememberIndecisiveProbe(projectRoot, outcome.kind === 'launch-refused' ? outcome.code : outcome.detail);
    }
    return local;
  }

  indecisiveProbeAt.delete(projectRoot);
  const source = parseRemoteSource(remote) ?? local;
  rememberProjectSource(projectRoot, source);
  return source;
}
