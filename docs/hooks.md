# Hooks

Hooks provide automatic context injection, backend warm-start, compaction recovery, KB reminders, CLI path resolution, prompt-mode Ralph looping, and flavor-aware self-gating.

## Overview

Hook registration lives in `hooks/hooks.json`. Coral uses these Claude Code hook events:

| Event | Scripts | Purpose |
| --- | --- | --- |
| `SessionStart` (`*`) | `session-start.mjs`, `hud-auto-update.mjs` | Inject `INJECT.md` (and spawn the backend daemon — absorbed from the former `backend-warm-start.mjs`), refresh HUD |
| `SessionStart` (`compact`) | `kb-promote-gate.mjs`, `post-compact.mjs` | Restore KB/promotion guidance and recover active jobs after compaction |
| `SubagentStart` | `subagent-start.mjs` | Inject subagent-safe `INJECT.md` |
| `PreCompact` | `pre-compact.mjs` | Snapshot active jobs before compaction |
| `UserPromptSubmit` | `kb-promote-gate.mjs`, `ralph-loop.mjs`, `kb-memo-reminder.mjs`, `coral-skill-vars.mjs` | KB flags, Ralph loop state, memo reminders, skill vars |
| `PreToolUse` (`Skill`) | `kb-promote-gate.mjs`, `ralph-loop.mjs`, `coral-skill-vars.mjs` | Same state setup for skill-initiated flows |
| `PreToolUse` (`Bash`) | `cli-resolve.mjs` | Resolve bare `coral-cli` calls to the plugin-local bundle |
| `PreToolUse` (`Monitor`) | `cli-monitor-guard.mjs` | Guard Monitor tool calls |
| `PostToolUseFailure` | `kb-lookup-reminder.mjs` | KB reminder on explicit tool failures |
| `PostToolUse` (`Bash`) | `kb-lookup-reminder.mjs` | KB reminder on silent-failure command output |
| `Stop` | `ralph-loop.mjs`, `kb-promote-gate.mjs` | Prompt-mode looping and KB promotion enforcement |

All hook scripts are Node.js ESM files that read JSON from stdin, write JSON to stdout, and fail open.

## Hook Self-Gating

All shipped hook entrypoints run `exitIfChildProcess()` first and `exitIfWrongFlavor()` second. `exitIfChildProcess()` suppresses Coral child-process reentry. `exitIfWrongFlavor()` compares `CORAL_FLAVOR` (unset => `prod`) with the hook bundle's own `bridge/manifest.json` flavor, exits `0` on mismatch, and exits `1` with stderr for unrecognized values. This is what allows marketplace prod hooks and locally registered dev hooks to coexist without cross-firing.

The HUD auto-update hook adds one more gate: it refreshes the HUD only when `buildFlavor() === 'prod'`, so dev registrations never overwrite the prod HUD.

## SessionStart

`hooks/session-start.mjs` reads `INJECT.md`, resolves project placeholders, strips owner/session-only blocks as needed, and returns the text through `hookSpecificOutput.additionalContext`.

KB wake-up cache support uses hook-local path helpers only: `kbRuntimeDir(flavor)` resolves `~/.coral/data/kb` or `~/.coral/data-dev/kb`, while `storeDbPath(flavor)` resolves the separate backend store DB at `~/.coral/data/store/store.db` or `~/.coral/data-dev/store/store.db`. The snapshot reader opens `kb_corpus_state` read-only from the store DB path, or from the sibling store DB when given a KB runtime dir, and fails open with `null` on any error.

The current Claude Code hook runtime verified for this implementation is Node.js `v22.18.0`, where `node:sqlite` still emits `ExperimentalWarning: SQLite is an experimental feature`. The hook imports `node:sqlite` through `hooks/lib/sqlite.mjs`, which suppresses the warning by detaching `warning` listeners around a lazy dynamic import and restoring them afterwards; missing or unreadable SQLite support therefore fails open instead of breaking hook startup.

It also:

- adds `Bash(node *coral-cli*)` permission to `.claude/settings.local.json`
- optionally creates `.claude/coral -> ~/.coral/projects/{slug}/` when `CORAL_AUTO_SYMLINK=1`
- updates `.gitignore` for generated local files when Coral creates them
- refreshes the HUD only for prod builds; `hud-auto-update.mjs` exits early for dev flavor even if the hook is registered locally

Provider-launched Codex and Claude sessions also receive `INJECT.md`, but that happens through `src/providers/inject.ts` and the provider adapters, not through a separate bridge prepend layer.

## Backend Warm-start

`hooks/session-start.mjs` unconditionally spawns `bridge/coral-backend.cjs` near the top of its body (logic absorbed from the former `backend-warm-start.mjs`). The daemon's `bindWithHandoff` / `requestIncumbentShutdown` contention layer is the single source of truth for staleness: a healthy same-bundle peer makes the new daemon throw `BackendAlreadyRunningError` and exit; a mismatching peer triggers IPC `transport.shutdown` and the new daemon takes over the bound socket. The hook stays free of bundle/flavor comparison so the contention contract has one canonical home. Failures are ignored and the CLI can start the backend lazily later.

## Compact Recovery

Two hooks run after compaction:

- `kb-promote-gate.mjs` restores memo-review and KB-promotion guidance
- `pre-compact.mjs` snapshots recent jobs for the current project from `projection_jobs`
- `post-compact.mjs` reads that snapshot and tells the user how to recover work

`post-compact.mjs` now describes recovery in CLI terms:

- pending jobs: `coral-cli wait --jobs "<job-id list>"`
- terminal jobs without inline artifacts: `coral-cli wait --jobs "<job>" --embed`
- missing or unreadable job state: do not rerun `wait` unless a verified artifact path exists

Implementation notes:

- snapshots are written under the project temp directory (`/tmp/coral/<project-slug>/hooks/active-jobs-*.json`)
- terminal recovery uses the durable artifact path under `~/.coral/exports/jobs/<jobId>/result.md` in prod or `~/.coral/exports-dev/jobs/<jobId>/result.md` in dev
- `<os-tmpdir>/coral-jobs/<jobId>/` contains live scratch artifacts such as stdout/stderr/intermediates only
- hook recovery reads CLI-visible job state and durable result artifacts, not file-backed job status records

The wait guidance matches the current CLI contract: terminal text always includes `Result path: <path>`, and `--embed` preview text is only a convenience layer. Read the printed result path for the durable artifact.

## SubagentStart

`hooks/subagent-start.mjs` injects the same behavioral guidance into Claude-native subagents, but strips owner-only and session-only blocks so subagents do not receive privileged memo-management instructions.

## UserPromptSubmit and PreToolUse

These hooks set up runtime state for KB-producing skills and prompt-mode Ralph:

- `kb-promote-gate.mjs` creates session-scoped KB activity flags
- `ralph-loop.mjs` creates or updates the prompt-loop state file
- `coral-skill-vars.mjs` injects shared Coral variables needed by skill flows
- `cli-resolve.mjs` rewrites bare `coral-cli` Bash commands to the plugin-local CLI bundle path

## Failure-aware KB Reminder

`hooks/kb-lookup-reminder.mjs` covers two cases:

- `PostToolUseFailure`: explicit non-zero tool exits
- `PostToolUse` on Bash: silent failures where the shell command returned zero but emitted known failure patterns

In both cases the hook injects additional KB lookup guidance without blocking the session.

## Stop Hooks

Two stop-time guards can block session exit:

- `ralph-loop.mjs` re-injects the stored prompt when prompt-mode Ralph should continue
- `kb-promote-gate.mjs` forces a memo review / promotion pass for KB-producing sessions

These hooks coexist because Claude Code can honor multiple `decision: "block"` responses during the same stop cycle.

## Node.js ESM Conventions

Hook scripts follow the same shape:

```javascript
import { exitIfChildProcess, exitIfWrongFlavor } from './lib/hook-utils.mjs';
import { readFileSync } from 'node:fs';

exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
  const output = { /* hook result */ };
  process.stdout.write(JSON.stringify(output) + '\n');
} catch {
  process.exit(0);
}
```

Rules:

- use ESM (`.mjs`, `import`)
- read stdin JSON
- write machine-readable JSON to stdout
- fail open on any exception
- avoid external runtime dependencies except documented hook-local fallbacks such as the read-only `better-sqlite3` corpus snapshot reader
