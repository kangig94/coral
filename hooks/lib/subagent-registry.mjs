// Per-session live-subagent registry.
//
// The subagent-track hook writes one marker file per subagent under a
// per-session directory: created on SubagentStart, removed on SubagentStop. The
// ralph-loop and kb-promote-gate Stop hooks read it and defer their
// `decision: 'block'` while any subagent of the same session is still live — so
// they don't drive the next iteration / nag for memo promotion while background
// work is still running.
//
// Layout is `<projectTmp>/live-subagents/<sessionId>/<agentId>`: the session
// scopes a directory (not a filename prefix), so counting is a plain readdir and
// there is no cross-session-id ambiguity.
//
// Liveness is judged by the subagent's transcript activity, not by a fixed
// runtime cap: a marker counts as live only while its transcript (fallback: the
// marker itself) was touched within LIVENESS_WINDOW_MS. A marker past that is
// pruned as dead — the backstop for a SubagentStop that never fired (aborted /
// crashed subagent). Clean termination removes the marker immediately, so this
// window is only ever paid on abnormal termination.
//
// Empty session dirs are removed inline (recordStop / hasLiveSubagent). A
// time-based disk sweep is deliberately avoided: a dir's mtime tracks marker
// churn, not the subagent's transcript, so an age check would race a long-lived
// subagent. The only residue is a dir whose subagent died uncleanly in a session
// no reader ever rechecks; that is left for OS temp cleanup.

import { mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { claudeConfigDir, isValidSessionId } from './hook-utils.mjs';
import { projectSlug, projectTmpDir } from './plugin-paths.mjs';

const REGISTRY_DIR = 'live-subagents';
const LIVENESS_WINDOW_MS = 60 * 60_000; // 60 min without transcript activity ⇒ presumed dead

function registryRoot(projectDir) {
  return join(projectTmpDir(projectDir), REGISTRY_DIR);
}

function sessionDir(projectDir, sessionId) {
  return join(registryRoot(projectDir), sessionId);
}

// SubagentStart: record that a subagent is running. Unconditional — any session
// may become a ralph/kb reader by the time it stops.
export function recordStart(projectDir, sessionId, agentId) {
  if (!isValidSessionId(sessionId) || !isValidSessionId(agentId)) return;
  const dir = sessionDir(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, agentId), '');
}

// SubagentStop: clear the marker. Idempotent and unconditional — a loop that
// ended mid-subagent still gets its marker removed. Drops the session dir once
// empty.
export function recordStop(projectDir, sessionId, agentId) {
  if (!isValidSessionId(sessionId) || !isValidSessionId(agentId)) return;
  const dir = sessionDir(projectDir, sessionId);
  try {
    unlinkSync(join(dir, agentId));
  } catch {}
  try {
    rmdirSync(dir); // succeeds only when now empty
  } catch {}
}

// True iff at least one subagent of this session is still live. Prunes dead
// markers as a side effect. `parentTranscriptPath` is the Stop hook's own
// transcript (the parent session); the subagents dir is derived from it, with a
// slug-based fallback when it is absent.
export function hasLiveSubagent(projectDir, sessionId, parentTranscriptPath) {
  if (!isValidSessionId(sessionId)) return false;

  const dir = sessionDir(projectDir, sessionId);
  let markers;
  try {
    markers = readdirSync(dir);
  } catch {
    return false;
  }

  const subagentsDir = resolveSubagentsDir(projectDir, sessionId, parentTranscriptPath);
  const now = Date.now();
  let live = false;

  for (const agentId of markers) {
    const markerPath = join(dir, agentId);
    if (now - lastActivityMs(subagentsDir, agentId, markerPath) <= LIVENESS_WINDOW_MS) {
      live = true;
    } else {
      try {
        unlinkSync(markerPath);
      } catch {}
    }
  }

  if (!live) {
    try {
      rmdirSync(dir);
    } catch {}
  }
  return live;
}

// Most-recent activity for a subagent: its transcript mtime, falling back to the
// marker's own mtime when the transcript can't be resolved. Unknown ⇒ 0 (ancient
// ⇒ treated as dead).
function lastActivityMs(subagentsDir, agentId, markerPath) {
  if (subagentsDir) {
    try {
      return statSync(join(subagentsDir, `agent-${agentId}.jsonl`)).mtimeMs;
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
function resolveSubagentsDir(projectDir, sessionId, parentTranscriptPath) {
  if (parentTranscriptPath) {
    return join(dirname(parentTranscriptPath), basename(parentTranscriptPath).replace(/\.jsonl$/, ''), 'subagents');
  }
  return join(claudeConfigDir(), 'projects', projectSlug(projectDir), sessionId, 'subagents');
}
