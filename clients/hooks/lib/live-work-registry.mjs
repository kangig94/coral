// Per-session live-work registry — tracks BOTH subagents and backgrounded
// Bash/Monitor work under ONE session directory, so the Stop-hook readers
// (ralph-loop, kb-promote-gate) ask a single question: is any work still live?
//
// Layout `<sandboxTmp>/coral-work/<projectSlug>/<sessionId>/`:
//   subagents/<agentId>       empty marker; SubagentStart creates it, SubagentStop
//                             removes it. Liveness = the subagent transcript's mtime
//                             within SUBAGENT_WINDOW_MS (fallback: marker mtime).
//                             Subagents are harness-spawned, so there is no in-process
//                             lock we can make them hold — mtime activity is the only
//                             backstop for a SubagentStop that never fired.
//   bg/<id>.launched          the PreToolUse launch record (written before the command runs).
//   bg/<id>.started           the injected wrapper's runtime-start mark.
//   bg/<id>.lock              the wrapper holds an exclusive flock on it for its whole
//                             lifetime and touches it periodically. Liveness = the lock
//                             is still held (`flock -n`), with an mtime-window fallback
//                             where flock(1) is absent. The kernel releases the lock on
//                             ANY death including SIGKILL, so crash detection needs no trap.
//   bg/<id>.exited.<code>     the wrapper's EXIT trap: terminal record carrying $?.
//
// The root is the sandbox-WRITABLE scratch dir (plugin-paths.sandboxTmpDir), NOT
// /tmp/coral — that is read-only inside the command sandbox, and the bg markers
// are written by the wrapper from *inside* the sandbox. Subagent markers are
// hook-written (outside), but live under the same root so one readdir answers the
// whole question and the tree relocates as a unit if the root ever moves.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { claudeConfigDir, isValidSessionId } from './hook-utils.mjs';
import { claudeProjectSlug, projectPathKey, sandboxTmpDir } from './plugin-paths.mjs';

const WORK_DIR = 'coral-work';
const SUBAGENTS_DIR = 'subagents';
const BG_DIR = 'bg';
const SUBAGENT_WINDOW_MS = 60 * 60_000; // 60 min without transcript activity ⇒ presumed dead
const BG_MTIME_WINDOW_MS = 30_000; // flock-absent fallback: no heartbeat within 30s ⇒ dead
const BG_CLEANUP_TTL_MS = 60 * 60_000; // prune terminal/dead bg entries older than this
// `flock -n` never blocks on the lock, so this bounds the fork itself, not the wait. A hook has no event loop
// to interrupt a synchronous child with, so an unbounded one here stalls the hook — and a stalled hook is a
// stalled Claude Code turn.
const LOCK_PROBE_TIMEOUT_MS = 1_000;
// The per-probe bound does not bound the sweep: this loop visits every locked task, so N wedged tasks cost
// N × LOCK_PROBE_TIMEOUT_MS against the Stop hook's own 5s budget. Once this much has been spent, the rest are
// left unprobed — and therefore left alone, since not knowing is not grounds for pruning.
const LOCK_PROBE_SWEEP_BUDGET_MS = 2_000;

function sessionRoot(projectDir, sessionId) {
  return join(sandboxTmpDir(), WORK_DIR, projectPathKey(projectDir), sessionId);
}

function subagentsPath(projectDir, sessionId) {
  return join(sessionRoot(projectDir, sessionId), SUBAGENTS_DIR);
}

function bgPath(projectDir, sessionId) {
  return join(sessionRoot(projectDir, sessionId), BG_DIR);
}

// === Subagent recording (SubagentStart / SubagentStop hooks) ===

// Record that a subagent is running. Unconditional — any session may become a
// ralph/kb reader by the time it stops.
export function recordSubagentStart(projectDir, sessionId, agentId) {
  if (!isValidSessionId(sessionId) || !isValidSessionId(agentId)) return;
  const dir = subagentsPath(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, agentId), '');
}

// Clear the marker. Idempotent and unconditional — a loop that ended mid-subagent
// still gets its marker removed. Drops now-empty registry dirs.
export function recordSubagentStop(projectDir, sessionId, agentId) {
  if (!isValidSessionId(sessionId) || !isValidSessionId(agentId)) return;
  try {
    unlinkSync(join(subagentsPath(projectDir, sessionId), agentId));
  } catch {}
  pruneEmptyDirs(projectDir, sessionId);
}

// === Background-task recording (writer side) ===

// Called by the PreToolUse hook for a `run_in_background` Bash/Monitor command:
// records the `.launched` marker and returns `{ id, wrapper }` — a shell preamble
// to prepend (as leading statements, before the original command) so the process
// records its own liveness. Returns null on invalid input or a filesystem error,
// in which case the caller leaves the command unwrapped: recording is best-effort
// and must never block the command from running.
export function beginBgTask(projectDir, sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  const id = randomBytes(8).toString('hex');
  try {
    const dir = bgPath(projectDir, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.launched`), '');
    return { id, wrapper: bgWrapperPreamble(dir, id) };
  } catch {
    return null;
  }
}

// Shell preamble prepended before the original command. Every step is fail-open —
// a registry-write failure must NEVER block or abort the user's command:
//   - `true > <lock>` first proves the lock file is openable, so the guarded
//     `exec 9>>` runs only when it cannot fatally fail (an exec redirect failure
//     aborts a non-interactive shell). It uses `true` (an ordinary utility), NOT
//     the `:` special built-in — a redirect failure on a special built-in fatally
//     aborts a POSIX shell (dash) even inside an `if` condition, which would kill
//     the very command this guard exists to protect.
//   - the MAIN shell holds the exclusive flock on fd 9, so the kernel releases it
//     the instant the shell dies by ANY means (incl. SIGKILL) — crash-safe
//     liveness with no reliance on the trap.
//   - a heartbeat subshell refreshes the lock mtime for the flock(1)-absent
//     fallback and self-exits when the main shell dies (`kill -0 $$`), so no
//     orphan loop survives a SIGKILL.
//   - the EXIT trap captures `$?` first, then records `.exited.<code>` (exit-code
//     precision only — never the liveness signal).
//   - `|| true` / `2>/dev/null` on the remaining steps keeps them non-fatal even
//     if the invoking shell has `set -e` active.
export function bgWrapperPreamble(bgDir, id) {
  const dir = shSingleQuote(bgDir);
  return [
    `__cbg=${dir}`,
    `__cid='${id}'`,
    'mkdir -p "$__cbg" 2>/dev/null || true',
    'if true > "$__cbg/$__cid.lock" 2>/dev/null; then exec 9>>"$__cbg/$__cid.lock"; command -v flock >/dev/null 2>&1 && flock -x 9 || true; fi',
    'true > "$__cbg/$__cid.started" 2>/dev/null',
    '( while kill -0 $$ 2>/dev/null; do touch "$__cbg/$__cid.lock" 2>/dev/null || true; sleep 10; done ) & __chb=$!',
    'trap \'__cc=$?; kill "$__chb" 2>/dev/null; true > "$__cbg/$__cid.exited.$__cc" 2>/dev/null; exit $__cc\' EXIT',
  ].join('; ');
}

function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// === Combined read: is any work of this session still live? ===

// True iff at least one subagent OR backgrounded Bash/Monitor task of this
// session is still live. Prunes dead entries as a side effect. `transcriptPath`
// is the Stop hook's own (parent) transcript; the subagents dir is derived from
// it, with a slug-based fallback when it is absent.
export function hasLiveWork(projectDir, sessionId, transcriptPath) {
  if (!isValidSessionId(sessionId)) return false;
  // Evaluate both so each kind prunes its own dead markers even when the other
  // is already live.
  const subagentLive = hasLiveSubagent(projectDir, sessionId, transcriptPath);
  const bgLive = hasLiveBg(projectDir, sessionId);
  if (!subagentLive && !bgLive) pruneEmptyDirs(projectDir, sessionId);
  return subagentLive || bgLive;
}

// === Subagent liveness ===

function hasLiveSubagent(projectDir, sessionId, transcriptPath) {
  const dir = subagentsPath(projectDir, sessionId);
  let markers;
  try {
    markers = readdirSync(dir);
  } catch {
    return false;
  }

  const transcriptsDir = resolveSubagentsDir(projectDir, sessionId, transcriptPath);
  const now = Date.now();
  let live = false;

  for (const agentId of markers) {
    const markerPath = join(dir, agentId);
    if (now - lastActivityMs(transcriptsDir, agentId, markerPath) <= SUBAGENT_WINDOW_MS) {
      live = true;
    } else {
      try {
        unlinkSync(markerPath);
      } catch {}
    }
  }

  return live;
}

// Most-recent activity for a subagent: its transcript mtime, falling back to the
// marker's own mtime when the transcript can't be resolved. Unknown ⇒ 0 (ancient
// ⇒ treated as dead).
function lastActivityMs(transcriptsDir, agentId, markerPath) {
  if (transcriptsDir) {
    try {
      return statSync(join(transcriptsDir, `agent-${agentId}.jsonl`)).mtimeMs;
    } catch {}
  }
  try {
    return statSync(markerPath).mtimeMs;
  } catch {}
  return 0;
}

// Parent transcript `<projects>/<slug>/<sessionId>.jsonl` sits beside the
// subagents dir `<projects>/<slug>/<sessionId>/subagents/`. Deriving from the
// parent path avoids guessing Claude's project-slug munging; the slug fallback
// only runs when the path is unavailable.
function resolveSubagentsDir(projectDir, sessionId, transcriptPath) {
  if (typeof transcriptPath === 'string' && transcriptPath) {
    return join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ''), 'subagents');
  }
  return join(claudeConfigDir(), 'projects', claudeProjectSlug(projectDir), sessionId, 'subagents');
}

// === Background-task liveness (reconcile) ===

function hasLiveBg(projectDir, sessionId) {
  const dir = bgPath(projectDir, sessionId);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }

  const tasks = new Map(); // id -> { lock, exited, newestMs }
  for (const name of entries) {
    const parsed = parseBgMarker(name);
    if (!parsed) continue;
    const task = tasks.get(parsed.id) ?? { lock: false, exited: false, newestMs: 0 };
    if (parsed.kind === 'lock') task.lock = true;
    if (parsed.kind === 'exited') task.exited = true;
    let mtime = 0;
    try {
      mtime = statSync(join(dir, name)).mtimeMs;
    } catch {}
    if (mtime > task.newestMs) task.newestMs = mtime;
    tasks.set(parsed.id, task);
  }

  const now = Date.now();
  const probeDeadline = now + LOCK_PROBE_SWEEP_BUDGET_MS;
  let live = false;
  for (const [id, task] of tasks) {
    if (Date.now() >= probeDeadline) {
      // Out of budget. Every remaining task is treated as live and none is pruned: they were not looked at,
      // and a hook that runs out of time has observed nothing about them.
      live = true;
      break;
    }
    if (isBgTaskLive(dir, id, task, now)) {
      live = true;
    } else if (now - task.newestMs > BG_CLEANUP_TTL_MS) {
      // Dead — keep recent terminals around for exit-code reads, sweep old ones.
      pruneBgTask(dir, id);
    }
  }
  return live;
}

function isBgTaskLive(dir, id, task, now) {
  if (task.exited) return false; // clean terminal record present
  if (task.lock) {
    const held = lockHeld(join(dir, `${id}.lock`));
    if (held === true) return true; // flock still held ⇒ process alive
    if (held === false) return false; // flock free ⇒ process died/released
    // held === null ⇒ flock(1) unavailable ⇒ fall through to mtime window
  }
  // No lock yet (wrapper still starting) or no flock(1): recent activity ⇒ alive.
  return now - task.newestMs <= BG_MTIME_WINDOW_MS;
}

function parseBgMarker(name) {
  for (const kind of ['launched', 'started', 'lock']) {
    const suffix = `.${kind}`;
    if (name.endsWith(suffix)) return { id: name.slice(0, -suffix.length), kind };
  }
  const exited = name.match(/^(.+)\.exited\.-?\d+$/);
  if (exited) return { id: exited[1], kind: 'exited' };
  return null;
}

// Probe whether an exclusive flock on `lockPath` is still held. Namespace-agnostic
// (inode-based), so it works across the command-sandbox boundary where a pid
// probe would not. Returns true (held/alive), false (free/dead), or null when the
// probe could not answer, so the caller falls back to the mtime window.
//
// Three answers, and which one an unanswerable probe gets is the whole question here.
//
// `null` means "flock(1) is not installed", and the mtime window exists for exactly that: a machine with no
// flock still has a heartbeat to read. It is *not* a general "could not tell", and an earlier revision made it
// one — routing every non-ENOENT failure there on the reasoning that `true` had no expiry while the window
// does. The reasoning missed that the window is not independent of the failure. The heartbeat is
// `while kill -0 $$; do touch …; sleep 10; done` (see `bgWrapperPreamble` below) — `touch` and `sleep` are
// external commands, so the conditions that stop this probe forking (EAGAIN, EMFILE, ENOMEM) are the same
// conditions that stop the heartbeat refreshing the mtime. Deferring to it then reads a stale timestamp,
// concludes the task is dead, un-gates ralph and kb while it is still running, and after the cleanup TTL
// unlinks a live task's lock file so it is invisible forever.
//
// Un-gating live work and pruning a live task are both finalizations, so an unanswered probe may authorize
// neither. It reports `true` — the conservative direction — and that is not the unbounded hold it looks like:
// the probe is bounded, so the next hook invocation asks again, and a machine that recovers answers `false` on
// its own. What the old code lacked was the bound, not this direction.
//
// `err.status` is a number only when flock actually ran and exited.
function lockHeld(lockPath) {
  try {
    execFileSync('flock', ['-n', lockPath, '-c', 'true'], {
      stdio: 'ignore',
      timeout: LOCK_PROBE_TIMEOUT_MS,
    });
    return false; // acquired ⇒ not held
  } catch (err) {
    if (typeof err?.status === 'number') return true; // flock ran and refused ⇒ busy ⇒ held
    if (err?.code === 'ENOENT') return null; // flock(1) absent ⇒ the mtime window is the designed fallback
    return true; // could not ask ⇒ do not conclude the work is gone
  }
}

function pruneBgTask(dir, id) {
  for (const suffix of ['.launched', '.started', '.lock']) {
    try {
      unlinkSync(join(dir, `${id}${suffix}`));
    } catch {}
  }
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${id}.exited.`)) {
      try {
        unlinkSync(join(dir, name));
      } catch {}
    }
  }
}

// === Cleanup ===

function pruneEmptyDirs(projectDir, sessionId) {
  // rmdir only succeeds on an empty dir, so this is a safe best-effort sweep.
  tryRmdir(subagentsPath(projectDir, sessionId));
  tryRmdir(bgPath(projectDir, sessionId));
  tryRmdir(sessionRoot(projectDir, sessionId));
}

function tryRmdir(dir) {
  try {
    rmdirSync(dir);
  } catch {}
}
